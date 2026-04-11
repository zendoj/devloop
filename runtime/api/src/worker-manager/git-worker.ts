/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Fas B1 worker runtime — real git + Claude CLI.
 *
 * Given a project + task context, this module:
 *   1. Clones the project's GitHub repo into a per-task worktree
 *      under /var/lib/devloop/worktrees/<task_id>.
 *   2. Checks out the default branch and creates
 *      `devloop/task/<display_id>`.
 *   3. Spawns the Claude CLI (`/var/lib/devloop/bin/claude -p`)
 *      inside the worktree with the report title + body as the
 *      user prompt and a system prompt that constrains it to
 *      minimal code changes. Claude is given Read/Edit/Write and
 *      a narrow Bash allowlist, runs with bypassPermissions, and
 *      is capped by --max-budget-usd.
 *   4. Commits whatever Claude changed on the worktree head and
 *      pushes the branch.
 *   5. Cleans up the worktree.
 *   6. Returns branch + head SHA + a summary extracted from
 *      Claude's JSON output so the Worker Manager can record it.
 *
 * Security invariants:
 *   - The token never leaks into logs. git command output is
 *     scanned and the token string is replaced with REDACTED.
 *   - The worktree path is built from hardcoded prefix + task_id
 *     (uuid), never user input. rm -rf is only called on paths
 *     that start with that exact prefix.
 *   - git config user.email/user.name is per-worktree, not global.
 *   - The worker NEVER pushes to the default branch. It only
 *     pushes to devloop/task/<display_id>, which is a
 *     write-restricted namespace convention we rely on review
 *     + branch protection for.
 *
 * If the clone or push fails, the caller is expected to catch and
 * transition the task to 'failed' via fence_and_transition.
 */

const WORKTREES_BASE = '/var/lib/devloop/worktrees';
const CLAUDE_BIN = '/var/lib/devloop/bin/claude';
const CLAUDE_HOME = '/var/lib/devloop/claude-home';
const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
const CLAUDE_MAX_BUDGET_USD = '5';
const CLAUDE_ALLOWED_TOOLS =
  'Read Edit Write Glob Grep Bash(git:status,git:diff,git:log,ls,cat,rg,grep,find,node,npm:run,npx:tsc)';

export interface WorkerRunInput {
  taskId: string;
  displayId: string;
  projectSlug: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  reportTitle: string;
  reportBody: string;
  /** Planner output (from agent_configs 'planner' role), or null if planner disabled / skipped */
  plan: string | null;
  /** Prior human-feedback entries from task_feedback, oldest first */
  feedback: Array<{
    attempt_number: number;
    feedback_text: string;
    files: Array<{ name: string; size: number; content: string }>;
    reported_at: string;
  }>;
  /** Rich-report attachments from report_attachments (screenshots, logs) */
  attachments: Array<{
    name: string;
    mime_type: string;
    content_base64: string;
    size: number;
  }>;
  githubToken: string;
  workerId: string;
}

export interface WorkerRunResult {
  branch_name: string;
  base_sha: string;
  head_sha: string;
  files_changed: string[];
  summary: string;
}

export async function runWorkerStub(
  input: WorkerRunInput,
): Promise<WorkerRunResult> {
  const workDir = `${WORKTREES_BASE}/${input.taskId}`;
  const safeToken = input.githubToken;

  // Clean up any stale worktree from a prior failed run.
  if (existsSync(workDir)) {
    if (!workDir.startsWith(`${WORKTREES_BASE}/`)) {
      throw new Error(`refusing to rm ${workDir}`);
    }
    await rm(workDir, { recursive: true, force: true });
  }
  await mkdir(workDir, { recursive: true });

  const branchName = `devloop/task/${input.displayId.toLowerCase()}`;
  // Bare URL with no token. The token is fed via GIT_ASKPASS so
  // it never lands in argv (and thus never in /proc/<pid>/cmdline
  // or process listings). The askpass script reads the token
  // from a per-task file mode 0600 owned by the running user
  // and is deleted in the finally block.
  const repoUrl = `https://github.com/${input.githubOwner}/${input.githubRepo}.git`;
  console.log(`[worker] cloning ${repoUrl} → ${workDir}`);

  // Per-task askpass setup. The script writes the token to
  // stdout when git asks for "Password for ...". The username
  // git asks for first ('x-access-token') is hardcoded into the
  // URL via the credential helper config below.
  const askpassDir = `${WORKTREES_BASE}/.askpass-${input.taskId}`;
  await mkdir(askpassDir, { recursive: true });
  await chmod(askpassDir, 0o700);
  const tokenPath = `${askpassDir}/token`;
  const askpassPath = `${askpassDir}/askpass.sh`;
  await writeFile(tokenPath, safeToken, 'utf8');
  await chmod(tokenPath, 0o600);
  // The askpass script echoes either the username or the token
  // depending on the prompt git issues. We use a fixed username
  // 'x-access-token' which is GitHub's documented bot user
  // for installation tokens.
  const askpassScript = `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  Password*) cat "${tokenPath}" ;;
esac
`;
  await writeFile(askpassPath, askpassScript, 'utf8');
  await chmod(askpassPath, 0o700);

  const askpassEnv = {
    GIT_ASKPASS: askpassPath,
    DEVLOOP_TOKEN_PATH: tokenPath,
  };

  try {
    await runGit(
      ['clone', '--depth', '1', '--branch', input.defaultBranch, repoUrl, workDir],
      '/',
      safeToken,
      askpassEnv,
    );

    // Capture base SHA so reviewer/deployer can reason about drift.
    const baseSha = (await runGit(['rev-parse', 'HEAD'], workDir, safeToken, askpassEnv)).trim();

    // Identity for the commit. Deliberately scoped to this worktree
    // via local `git config`, never global.
    await runGit(['config', 'user.email', 'devloop@airpipe.ai'], workDir, safeToken, askpassEnv);
    await runGit(['config', 'user.name', 'DevLoop Worker'], workDir, safeToken, askpassEnv);

    // Branch off the default branch.
    await runGit(['checkout', '-b', branchName], workDir, safeToken, askpassEnv);

    // Fas H: write planner output + accumulated human-reject
    // feedback into the worktree as .devloop/plan.md + files
    // under .devloop/feedback/attempt-N/. Claude reads them via
    // --add-dir and uses them as extra context without needing
    // another tool invocation.
    const devloopDir = `${workDir}/.devloop`;
    await mkdir(devloopDir, { recursive: true });
    if (input.plan && input.plan.length > 0) {
      await writeFile(`${devloopDir}/plan.md`, input.plan, 'utf8');
    }
    await writeFile(
      `${devloopDir}/report.md`,
      `# ${input.reportTitle}\n\n${input.reportBody}\n`,
      'utf8',
    );
    for (const fb of input.feedback) {
      const attemptDir = `${devloopDir}/feedback/attempt-${fb.attempt_number}`;
      await mkdir(attemptDir, { recursive: true });
      await writeFile(
        `${attemptDir}/feedback.md`,
        `Reported at: ${fb.reported_at}\n\n${fb.feedback_text}\n`,
        'utf8',
      );
      for (const f of fb.files) {
        // Files are stored base64-encoded in the DB (per
        // tasks.controller reject handler). Decode on the way
        // out so Claude sees real bytes.
        const bytes = Buffer.from(f.content, 'base64');
        await writeFile(`${attemptDir}/${f.name}`, bytes);
      }
    }

    // Fas I: rich-report attachments (screenshot, console log,
    // network log, state dump, element selector). Dropped into
    // .devloop/attachments/ so Claude can open them directly.
    if (input.attachments.length > 0) {
      const attachDir = `${devloopDir}/attachments`;
      await mkdir(attachDir, { recursive: true });
      for (const a of input.attachments) {
        const bytes = Buffer.from(a.content_base64, 'base64');
        await writeFile(`${attachDir}/${a.name}`, bytes);
      }
    }

    // Hand the task to Claude. It runs inside workDir with Read/
    // Edit/Write + a narrow Bash allowlist and is capped by a USD
    // budget. If Claude errors or makes no file changes we fail
    // the task — the caller transitions to 'failed'.
    const sanitizedTitle = input.reportTitle.replace(/[\r\n]/g, ' ').slice(0, 200);
    const claudeResult = await runClaude(
      workDir,
      sanitizedTitle,
      input.reportBody,
      input.plan,
      input.feedback.length > 0,
      input.attachments.length > 0,
    );

    // Before staging, strip .devloop/ out of the worktree — it's
    // scratch context for Claude, not part of the commit. rm -rf
    // is bounded to a hardcoded subdir of the worktree.
    try {
      await rm(devloopDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }

    // Detect whether Claude actually changed anything. An empty
    // worktree status means Claude produced no fix and the task
    // must not be pushed as a no-op.
    const statusOut = await runGit(
      ['status', '--porcelain'],
      workDir,
      safeToken,
      askpassEnv,
    );
    if (statusOut.trim().length === 0) {
      throw new Error(
        `claude produced no file changes (cost=$${claudeResult.costUsd.toFixed(4)}, turns=${claudeResult.numTurns})`,
      );
    }

    // Collect the list of touched files for the result payload.
    const filesChanged = statusOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.slice(3));

    // Stage + commit everything Claude touched.
    await runGit(['add', '-A'], workDir, safeToken, askpassEnv);
    const commitSubject = `devloop(${input.displayId}): ${sanitizedTitle}`.slice(0, 120);
    const commitBody = [
      `DevLoop task: ${input.taskId}`,
      `Worker: ${input.workerId}`,
      `Claude session: ${claudeResult.sessionId}`,
      `Claude cost: $${claudeResult.costUsd.toFixed(4)} (${claudeResult.numTurns} turns)`,
      '',
      claudeResult.summary.slice(0, 2000),
    ].join('\n');
    await runGit(
      ['commit', '-m', commitSubject, '-m', commitBody],
      workDir,
      safeToken,
      askpassEnv,
    );

    const headSha = (
      await runGit(['rev-parse', 'HEAD'], workDir, safeToken, askpassEnv)
    ).trim();

    // Push the branch. The askpass helper provides credentials
    // when git prompts; the token never appears in argv.
    await runGit(['push', 'origin', branchName], workDir, safeToken, askpassEnv);

    return {
      branch_name: branchName,
      base_sha: baseSha,
      head_sha: headSha,
      files_changed: filesChanged,
      summary: claudeResult.summary.slice(0, 500) || commitSubject,
    };
  } finally {
    // Always clean up the worktree AND the askpass helper dir so
    // the next task run starts fresh and the token file is not
    // left on disk. Both paths are validated against the
    // hardcoded prefix before rm.
    if (workDir.startsWith(`${WORKTREES_BASE}/`) && existsSync(workDir)) {
      await rm(workDir, { recursive: true, force: true });
    }
    if (
      askpassDir.startsWith(`${WORKTREES_BASE}/.askpass-`) &&
      existsSync(askpassDir)
    ) {
      await rm(askpassDir, { recursive: true, force: true });
    }
  }
}

/**
 * Run a git command and return stdout as a string. Rejects with
 * the stderr output (token-redacted) on non-zero exit.
 */
async function runGit(
  args: string[],
  cwd: string,
  token: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        // Disable terminal prompts — if credentials fail we want
        // a clean non-zero exit, not a hung process. GIT_ASKPASS
        // (when set in extraEnv) takes precedence over the
        // default 'echo' fallback.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const redactedErr = redactToken(stderr, token);
        reject(
          new Error(
            `git ${args[0]} failed (exit ${code}): ${redactedErr.slice(0, 500)}`,
          ),
        );
      }
    });
  });
}

function redactToken(s: string, token: string): string {
  if (!token || token.length < 8) return s;
  return s.split(token).join('REDACTED');
}

interface ClaudeResult {
  sessionId: string;
  costUsd: number;
  numTurns: number;
  summary: string;
}

/**
 * Spawn the Claude CLI inside the given worktree and wait for it
 * to finish. The CLI runs non-interactively (`-p`) with JSON
 * output, bypassPermissions (edits without prompting), a narrow
 * tool allowlist, and a USD budget cap. HOME is redirected to
 * /var/lib/devloop/claude-home so Claude reads devloop-api's
 * credentials rather than /home/jonas (which is hidden by
 * ProtectHome in the systemd unit).
 */
async function runClaude(
  worktree: string,
  title: string,
  body: string,
  plan: string | null,
  hasPriorFeedback: boolean,
  hasAttachments: boolean,
): Promise<ClaudeResult> {
  const systemPromptLines = [
    'You are DevLoop Worker, an autonomous bug-fixer running inside',
    'a fresh git worktree. Your job: read the bug report below and',
    'make the smallest possible code change to fix it.',
    '',
    'Context files in .devloop/ (read-only for you, NOT part of the commit):',
    '  .devloop/report.md — the original bug report',
  ];
  if (plan && plan.length > 0) {
    systemPromptLines.push(
      '  .devloop/plan.md   — the planner\'s strategy. Follow it',
      '                        unless you see it is wrong.',
    );
  }
  if (hasPriorFeedback) {
    systemPromptLines.push(
      '  .devloop/feedback/attempt-N/ — previous human rejections.',
      '                        Read every attempt-N/feedback.md and any',
      '                        attached screenshots/logs. Address',
      '                        each concern before making your fix.',
    );
  }
  if (hasAttachments) {
    systemPromptLines.push(
      '  .devloop/attachments/ — rich bug-report artifacts:',
      '                        screenshot.png, console.log,',
      '                        network.log, state.json, element.json.',
      '                        Read them to understand EXACTLY what',
      '                        the user saw when filing the report.',
    );
  }
  systemPromptLines.push(
    '',
    'Hard rules:',
    '- Do NOT refactor unrelated code.',
    '- Do NOT add comments beyond what is strictly necessary.',
    '- Do NOT create new files unless the fix absolutely requires it.',
    '- Do NOT run destructive shell commands.',
    '- Do NOT commit or push — the worker handles git.',
    '- Do NOT modify anything inside .devloop/ — that directory is',
    '  stripped before commit and is context only.',
    '- If you cannot determine a safe fix, edit nothing and explain',
    '  why in your final message; the worker will fail the task.',
    '',
    'When you are done editing, end your final message with a short',
    'one-paragraph summary of what you changed and why.',
  );
  const systemPrompt = systemPromptLines.join('\n');

  const userPromptParts: string[] = [`# Bug report: ${title}`, '', body];
  if (plan && plan.length > 0) {
    userPromptParts.push(
      '',
      '## Planner output',
      '',
      'The Planner agent produced this strategy before you were',
      'invoked. You can read it in full at .devloop/plan.md. It',
      'is a recommendation, not a command — you have the actual',
      'code open and can deviate if you see something the',
      'planner missed.',
      '',
      plan.slice(0, 4000),
    );
  }
  if (hasPriorFeedback) {
    userPromptParts.push(
      '',
      '## Prior human rejections',
      '',
      'This is not the first attempt at this task. A previous',
      'version of your work was deployed and a human rejected it',
      'because it did not actually fix the reported problem when',
      'tried in the running product. Read every file under',
      '.devloop/feedback/ and make sure your new attempt addresses',
      'each issue raised.',
    );
  }
  if (hasAttachments) {
    userPromptParts.push(
      '',
      '## Rich bug-report attachments',
      '',
      'The bug reporter captured runtime state when they filed',
      'this report. Look in .devloop/attachments/ — there may be',
      'a screenshot showing the broken state, a console.log with',
      'the JS errors that happened right before the report, a',
      'network.log with failed HTTP requests, and a state.json',
      'with the client app state at the time. Use these to',
      'pinpoint the exact root cause before you start editing.',
    );
  }
  const userPrompt = userPromptParts.join('\n');

  const args = [
    '-p',
    userPrompt,
    '--output-format',
    'json',
    '--append-system-prompt',
    systemPrompt,
    '--permission-mode',
    'bypassPermissions',
    '--allowedTools',
    CLAUDE_ALLOWED_TOOLS,
    '--add-dir',
    worktree,
    '--max-budget-usd',
    CLAUDE_MAX_BUDGET_USD,
    '--no-session-persistence',
  ];

  console.log(`[worker] spawning claude in ${worktree}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: worktree,
      env: {
        PATH: '/var/lib/devloop/bin:/usr/bin:/bin',
        HOME: CLAUDE_HOME,
        CLAUDE_NONINTERACTIVE: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `claude exited ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          is_error?: boolean;
          result?: string;
          session_id?: string;
          total_cost_usd?: number;
          num_turns?: number;
          subtype?: string;
        };
        if (parsed.is_error) {
          reject(
            new Error(
              `claude reported error (${parsed.subtype ?? 'unknown'}): ${(parsed.result ?? '').slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve({
          sessionId: parsed.session_id ?? 'unknown',
          costUsd: parsed.total_cost_usd ?? 0,
          numTurns: parsed.num_turns ?? 0,
          summary: parsed.result ?? '',
        });
      } catch (e) {
        reject(
          new Error(
            `claude output was not valid JSON: ${(e as Error).message}; first 200 bytes: ${stdout.slice(0, 200)}`,
          ),
        );
      }
    });
  });
}
