/* eslint-disable no-console */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../data-source';

/**
 * DevLoop Reviewer (Fas 4).
 *
 * Polls agent_tasks WHERE status='review', fetches the diff via
 * the GitHub Compare API (no clone needed — much faster than
 * the worker runtime path), sends prompt + diff to gpt-5.4
 * reasoning=medium, parses the verdict ('approved' or
 * 'changes_requested') and a 0..100 score, calls
 * record_review_result to stamp the metadata, then
 * fence_and_transition's the task accordingly.
 *
 * Same security posture as the Worker Manager:
 *   - runs as devloop-api OS user (peer-maps to devloop_api PG role)
 *   - reads openai_api_key + github_token via systemd LoadCredential
 *   - tokens are never logged
 *   - the diff is bounded (max 80kB) so a giant patch cannot
 *     blow up the model context or our error logs
 *   - generic error handling: a model failure does NOT auto-fail
 *     the task; it leaves the task in 'review' for retry on the
 *     next iteration
 *
 * The Reviewer is intentionally generous (passing score >= 60).
 * The whole point of DevLoop is to keep the human-in-the-loop
 * gates (branch protection + manual merge) on TOP of this
 * automated review — the reviewer's job is to filter obvious
 * garbage, not to be the final word.
 */

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 3;
const MAX_DIFF_BYTES = 80 * 1024;
const MODEL = 'gpt-5.4';

const REVIEWER_ID = `rv-${process.pid}-${Date.now().toString(36)}`;

let running = true;

function loadSecret(name: string): string | null {
  const credDir = process.env['CREDENTIALS_DIRECTORY'];
  if (credDir) {
    try {
      return readFileSync(`${credDir}/${name}`, 'utf8').trim();
    } catch {
      /* fall through */
    }
  }
  try {
    return readFileSync(`/etc/devloop/${name}`, 'utf8').trim();
  } catch {
    return null;
  }
}

const OPENAI_API_KEY = loadSecret('openai_api_key');
const GITHUB_TOKEN = loadSecret('github_token');

interface TaskForReview {
  task_id: string;
  display_id: string;
  module: string;
  risk_tier: string;
  lease_version: number;
  branch_name: string;
  base_sha: string;
  head_sha: string;
  github_owner: string;
  github_repo: string;
  report_title: string;
  report_body: string;
  files_changed: unknown;
}

interface ReviewVerdict {
  decision: 'approved' | 'changes_requested';
  score: number;
  summary: string;
}

async function main(): Promise<void> {
  console.log(`[rv] starting reviewer ${REVIEWER_ID}`);
  if (OPENAI_API_KEY === null) {
    console.error('[rv] FATAL: openai_api_key not loaded');
    process.exit(2);
  }
  if (GITHUB_TOKEN === null) {
    console.warn('[rv] no github_token — diff fetch will use anonymous GitHub which only works for public repos');
  }

  const ds = buildDataSource();
  await ds.initialize();

  process.on('SIGTERM', () => {
    console.log('[rv] SIGTERM — draining');
    running = false;
  });
  process.on('SIGINT', () => {
    console.log('[rv] SIGINT — draining');
    running = false;
  });

  try {
    while (running) {
      try {
        await runOnce(ds);
      } catch (err) {
        console.error('[rv] iteration error:', err);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await ds.destroy();
    console.log('[rv] shutdown complete');
  }
}

async function runOnce(ds: DataSource): Promise<void> {
  const rows = (await ds.query(
    `
    SELECT
      at.id            AS task_id,
      at.display_id,
      at.module,
      at.risk_tier::text AS risk_tier,
      at.lease_version,
      at.branch_name,
      at.approved_base_sha AS base_sha,
      at.approved_head_sha AS head_sha,
      p.github_owner,
      p.github_repo,
      r.title          AS report_title,
      r.description    AS report_body,
      at.files_changed
    FROM public.agent_tasks at
    JOIN public.projects p ON p.id = at.project_id
    JOIN public.reports  r ON r.id = at.report_id
    WHERE at.status = 'review'
      AND at.review_decision IS NULL
      AND at.branch_name IS NOT NULL
      AND at.approved_base_sha IS NOT NULL
      AND at.approved_head_sha IS NOT NULL
    ORDER BY at.created_at ASC
    LIMIT $1
    `,
    [BATCH_SIZE],
  )) as Array<TaskForReview>;

  for (const task of rows) {
    if (!running) break;
    try {
      await reviewOne(ds, task);
    } catch (err) {
      console.error(`[rv] ${task.display_id} review error:`, err);
    }
  }
}

async function reviewOne(ds: DataSource, task: TaskForReview): Promise<void> {
  console.log(
    `[rv] ${task.display_id} reviewing branch=${task.branch_name} ${task.base_sha.slice(0, 7)}..${task.head_sha.slice(0, 7)}`,
  );

  // Step 1: fetch the diff via GitHub Compare API.
  const diff = await fetchDiff(
    task.github_owner,
    task.github_repo,
    task.base_sha,
    task.head_sha,
  );
  if (diff === null) {
    console.warn(`[rv] ${task.display_id} diff fetch failed — leaving in review`);
    return;
  }
  const diffTrimmed =
    diff.length > MAX_DIFF_BYTES
      ? diff.slice(0, MAX_DIFF_BYTES) + `\n\n…(truncated, original ${diff.length} bytes)`
      : diff;

  // Step 2: ask gpt-5.4 for a verdict.
  let verdict: ReviewVerdict;
  try {
    verdict = await askModel(task, diffTrimmed);
  } catch (err) {
    console.error(`[rv] ${task.display_id} model call failed:`, err);
    return;
  }
  console.log(
    `[rv] ${task.display_id} verdict ${verdict.decision} score=${verdict.score}`,
  );

  // Step 3: stamp via record_review_result.
  const stamped = (await ds.query(
    `
    SELECT public.record_review_result(
      $1, $2::public.review_decision_enum, $3, $4, $5::jsonb
    ) AS ok
    `,
    [
      task.task_id,
      verdict.decision,
      MODEL,
      verdict.score,
      JSON.stringify({ summary: verdict.summary }),
    ],
  )) as Array<{ ok: boolean }>;
  if (stamped[0]?.ok !== true) {
    console.warn(`[rv] ${task.display_id} record_review_result returned false`);
    return;
  }

  // Step 4: fence_and_transition to approved or changes_requested.
  const targetStatus =
    verdict.decision === 'approved' ? 'approved' : 'changes_requested';
  await ds.query(
    `
    SELECT public.fence_and_transition(
      $1, $2::bigint, 'review'::public.task_status_enum,
      $3::public.task_status_enum,
      $4::varchar(128), 'system'::public.actor_kind_enum,
      jsonb_build_object('reviewer_id', $4::text, 'model', $5::text, 'score', $6::int),
      $4::varchar(128)
    )
    `,
    [task.task_id, task.lease_version, targetStatus, REVIEWER_ID, MODEL, verdict.score],
  );
  console.log(`[rv] ${task.display_id} → ${targetStatus}`);
}

async function fetchDiff(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string | null> {
  // GitHub returns the patch directly when Accept is the diff
  // media type. Compare endpoint accepts SHAs or branch names on
  // both sides; we already have the SHAs from the worker run.
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${base}...${head}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3.diff',
    'User-Agent': 'devloop-reviewer/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN !== null) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    console.error(`[rv] fetchDiff network error: ${String(err)}`);
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(
      `[rv] fetchDiff ${owner}/${repo} ${base}..${head} → HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
    return null;
  }
  return await res.text();
}

async function askModel(
  task: TaskForReview,
  diff: string,
): Promise<ReviewVerdict> {
  const systemPrompt = `You are a code reviewer for the DevLoop AI bug-fix system. You see a bug report and a diff that an AI worker proposed as a fix. Your job is to decide whether the diff is acceptable to forward to a human merger.

OUTPUT FORMAT — return EXACTLY a JSON object with these fields and no extra text:
{
  "decision": "approved" | "changes_requested",
  "score": <integer 0..100>,
  "summary": "<one-sentence reason in English>"
}

Guidelines:
- approved if the diff plausibly addresses the bug, does not introduce obvious regressions, and follows reasonable conventions.
- approved if the diff is a no-op stub or marker file change (DevLoop is wired up before any real fix logic exists, so stub diffs are expected during early phases — score them ~60).
- changes_requested if the diff is destructive, off-topic, or removes large blocks of unrelated code.
- score is your confidence that this diff is safe to merge: 0..40 = obviously bad, 41..70 = stub or partial, 71..100 = solid.
- Keep summary under 200 chars.

Risk tier and module are provided as context; do not let them dominate the decision — small low-risk diffs can still be wrong.`;

  const userPrompt = `Task: ${task.display_id}
Module: ${task.module}
Risk tier: ${task.risk_tier}
Branch: ${task.branch_name}
Base: ${task.base_sha}
Head: ${task.head_sha}

Bug report:
=== ${task.report_title} ===
${task.report_body}

Diff:
\`\`\`diff
${diff}
\`\`\`

Return your verdict as JSON now.`;

  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    reasoning_effort: 'medium',
    max_completion_tokens: 4000,
    response_format: { type: 'json_object' },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openai HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('openai returned empty content');
  }

  let parsed: { decision?: unknown; score?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`failed to parse model JSON: ${String(err)}`);
  }
  const decision = parsed.decision;
  const score = parsed.score;
  const summary = parsed.summary;
  if (decision !== 'approved' && decision !== 'changes_requested') {
    throw new Error(`bad decision: ${String(decision)}`);
  }
  if (typeof score !== 'number' || score < 0 || score > 100) {
    throw new Error(`bad score: ${String(score)}`);
  }
  if (typeof summary !== 'string') {
    throw new Error('bad summary');
  }
  return {
    decision,
    score: Math.round(score),
    summary: summary.slice(0, 500),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref();
  });
}

main().catch((err) => {
  console.error('[rv] fatal:', err);
  process.exit(1);
});
