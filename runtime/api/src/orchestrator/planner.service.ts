/* eslint-disable no-console */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';
import { callAgent, stripJsonFence } from '../agents/call-agent';

/**
 * PlannerService — runs the `planner` agent role (best-effort)
 * after classification, before the worker spawns Claude. Produces
 * a short strategy + step list + files-to-touch recommendation
 * that gets saved in `agent_tasks.plan` and handed to Claude as
 * `.devloop/plan.md` inside the worktree.
 *
 * Design decisions:
 *   - Best-effort: if the planner agent is disabled, fails, or
 *     returns unparseable JSON, we return null and the pipeline
 *     proceeds WITHOUT a plan. Claude plans internally anyway.
 *   - Short timeout bounded by the agent_configs.timeout_ms for
 *     the planner role (default 5 min). A hung planner should
 *     never block the pipeline permanently.
 *   - Stateless: no conversationRef — each task gets a fresh
 *     webengine chat. Persistent per-module memory was explicitly
 *     decided against; reproducibility > hidden context.
 *   - Markdown output: we store the model's `notes_md` field
 *     directly into agent_tasks.plan. Claude treats it as a
 *     human-written plan and tries to follow it.
 */

const PLANNER_ASK_TXT = `You are the DevLoop Planner.

Files attached:
  - report.txt — the bug report and task metadata

Your job: write a minimal, concrete plan for a coder agent
(Claude Code) that will fix the bug reported in report.txt.

Return EXACTLY ONE JSON object and NO other text, markdown, or
code fences. Schema:

{
  "summary": "<one sentence, under 200 chars>",
  "strategy": "<2-3 sentences explaining the approach>",
  "files_to_touch": ["<relative/path/to/file.ts>", "..."],
  "steps": [
    {
      "step": 1,
      "file": "<path>",
      "change": "<what to change>",
      "why": "<why this change fixes the bug>"
    }
  ],
  "risks": [
    "<potential regression or edge case to watch>"
  ],
  "estimated_complexity": "low" | "medium" | "high",
  "needs_new_tests": true | false,
  "notes_md": "<multi-paragraph markdown plan a human can read>"
}

Hard rules for the plan:
  - Prefer the smallest change that fixes the bug. No refactoring.
  - Do NOT invent file paths you cannot justify from the report.
  - If the report is too vague to plan against, set
    estimated_complexity = "high" and explain in notes_md what
    information is missing; the coder will then fail fast.
  - Your notes_md is what the coder reads — keep it actionable.
`;

/**
 * Free-function entry point so non-Nest callers (like the
 * worker-manager standalone script) can drive the planner
 * without constructing a Nest container. Both this and the
 * injected PlannerService share the same implementation.
 */
export async function planForTaskDirect(
  ds: DataSource,
  taskId: string,
  reportTitle: string,
  reportBody: string,
  module: string,
  riskTier: string,
  logger?: { warn: (s: string) => void; log: (s: string) => void },
): Promise<string | null> {
  return planImpl(ds, taskId, reportTitle, reportBody, module, riskTier, logger);
}

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /**
   * Produce a plan for a task. Saves the notes_md field directly
   * to agent_tasks.plan on success. Returns the saved plan text
   * or null if planning was skipped / failed.
   */
  public async planForTask(
    taskId: string,
    reportTitle: string,
    reportBody: string,
    module: string,
    riskTier: string,
  ): Promise<string | null> {
    return planImpl(
      this.ds,
      taskId,
      reportTitle,
      reportBody,
      module,
      riskTier,
      this.logger,
    );
  }
}

async function planImpl(
  ds: DataSource,
  taskId: string,
  reportTitle: string,
  reportBody: string,
  module: string,
  riskTier: string,
  logger?: { warn: (s: string) => void; log: (s: string) => void },
): Promise<string | null> {
  const warn = (s: string): void => {
    if (logger) logger.warn(s);
    else console.warn(`[planner] ${s}`);
  };
  const log = (s: string): void => {
    if (logger) logger.log(s);
    else console.log(`[planner] ${s}`);
  };

  const reportTxt = [
    `Task ID:   ${taskId}`,
    `Module:    ${module}`,
    `Risk tier: ${riskTier}`,
    '',
    `Title: ${reportTitle}`,
    '',
    'Description:',
    reportBody.slice(0, 8000),
  ].join('\n');

  let result;
  try {
    result = await callAgent(ds, {
      role: 'planner',
      prompt:
        'Read ask.txt. Plan a minimal fix for the bug in report.txt. Return only the JSON object as specified.',
      files: [
        { name: 'ask.txt', content: PLANNER_ASK_TXT },
        { name: 'report.txt', content: reportTxt },
      ],
    });
  } catch (err) {
    const msg = (err as Error).message;
    warn(`planner skipped for task ${taskId}: ${msg.slice(0, 200)}`);
    return null;
  }

  const stripped = stripJsonFence(result.text);
  let parsed: { notes_md?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(stripped);
  } catch {
    warn(
      `planner returned non-JSON for task ${taskId}: ${stripped.slice(0, 200)}`,
    );
    return null;
  }

  const notesMd =
    typeof parsed.notes_md === 'string' && parsed.notes_md.length > 0
      ? parsed.notes_md
      : typeof parsed.summary === 'string'
        ? parsed.summary
        : null;
  if (!notesMd) {
    warn(`planner returned empty plan for task ${taskId}`);
    return null;
  }

  try {
    await ds.query(
      `UPDATE public.agent_tasks SET plan = $1 WHERE id = $2`,
      [notesMd.slice(0, 20000), taskId],
    );
  } catch (err) {
    warn(
      `planner UPDATE failed for task ${taskId}: ${(err as Error).message}`,
    );
    return null;
  }

  log(
    `planner produced ${notesMd.length}-char plan for task ${taskId} (${result.model}, ${result.elapsedMs}ms)`,
  );
  return notesMd;
}
