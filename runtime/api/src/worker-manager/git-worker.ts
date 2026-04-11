/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Fas 3 worker runtime — real git operations.
 *
 * Given a project + task context, this module:
 *   1. Clones the project's GitHub repo into a per-task worktree
 *      under /var/lib/devloop/worktrees/<task_id> via the
 *      credentialed remote `https://x-access-token:<token>@…`.
 *   2. Checks out the default branch.
 *   3. Creates a `devloop/task/<display_id>` branch.
 *   4. Makes a trivial marker change (appends a DEVLOOP task note
 *      to DEVLOOP_TASKS.md — new file if missing). Real Claude
 *      invocation replaces this in Fas 3b+.
 *   5. git commit + git push origin <branch>.
 *   6. Cleans up the worktree directory.
 *   7. Returns the branch name + head SHA so the Worker Manager
 *      can record it in agent_tasks.
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

export interface WorkerRunInput {
  taskId: string;
  displayId: string;
  projectSlug: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  reportTitle: string;
  reportBody: string;
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

    // Trivial "fix": append a marker note to DEVLOOP_TASKS.md. This
    // is the Fas 3 stub — real Claude invocation ships in Fas 3b.
    // The file is intentionally non-code so the reviewer can see
    // the shape of the flow without a real code change breaking
    // the repo.
    const notePath = `${workDir}/DEVLOOP_TASKS.md`;
    let priorNote = '';
    try {
      priorNote = await readFile(notePath, 'utf8');
    } catch {
      priorNote = '# DevLoop task notes\n\n';
    }
    const sanitizedTitle = input.reportTitle.replace(/[\r\n]/g, ' ').slice(0, 200);
    const sanitizedBody = input.reportBody.replace(/[\r\n]+/g, '\n').slice(0, 2000);
    const appendedNote = `## ${input.displayId} — ${sanitizedTitle}

**Status:** stub analysis from worker runtime Fas 3a.

${sanitizedBody}

_This placeholder note was added by DevLoop Worker stub. Fas 3b wires in Claude for a real fix._
`;
    await writeFile(notePath, priorNote + '\n' + appendedNote, 'utf8');

    // Stage + commit.
    await runGit(['add', 'DEVLOOP_TASKS.md'], workDir, safeToken);
    const commitSubject = `devloop(${input.displayId}): stub fix for ${sanitizedTitle}`;
    await runGit(
      [
        'commit',
        '-m',
        commitSubject,
        '-m',
        `DevLoop task: ${input.taskId}\nWorker: ${input.workerId}\nStub-only: no real code change. See DEVLOOP_TASKS.md for the task note.`,
      ],
      workDir,
      safeToken,
      askpassEnv,
    );

    const headSha = (await runGit(['rev-parse', 'HEAD'], workDir, safeToken, askpassEnv)).trim();

    // Push the branch. The askpass helper provides credentials
    // when git prompts; the token never appears in argv.
    await runGit(['push', 'origin', branchName], workDir, safeToken, askpassEnv);

    return {
      branch_name: branchName,
      base_sha: baseSha,
      head_sha: headSha,
      files_changed: ['DEVLOOP_TASKS.md'],
      summary: commitSubject,
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
