/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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
  const cloneUrl = `https://x-access-token:${safeToken}@github.com/${input.githubOwner}/${input.githubRepo}.git`;
  const displayCloneUrl = `https://github.com/${input.githubOwner}/${input.githubRepo}.git`;
  console.log(`[worker] cloning ${displayCloneUrl} → ${workDir}`);

  try {
    await runGit(
      ['clone', '--depth', '1', '--branch', input.defaultBranch, cloneUrl, workDir],
      '/',
      safeToken,
    );

    // Capture base SHA so reviewer/deployer can reason about drift.
    const baseSha = (await runGit(['rev-parse', 'HEAD'], workDir, safeToken)).trim();

    // Identity for the commit. Deliberately scoped to this worktree
    // via local `git config`, never global.
    await runGit(['config', 'user.email', 'devloop@airpipe.ai'], workDir, safeToken);
    await runGit(['config', 'user.name', 'DevLoop Worker'], workDir, safeToken);

    // Branch off the default branch.
    await runGit(['checkout', '-b', branchName], workDir, safeToken);

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
    );

    const headSha = (await runGit(['rev-parse', 'HEAD'], workDir, safeToken)).trim();

    // Push the branch. --force-with-lease is safer than --force if
    // someone else is simultaneously pushing to the same branch,
    // but since this branch is newly minted it does not matter
    // much here. Plain push works.
    await runGit(['push', 'origin', branchName], workDir, safeToken);

    return {
      branch_name: branchName,
      base_sha: baseSha,
      head_sha: headSha,
      files_changed: ['DEVLOOP_TASKS.md'],
      summary: commitSubject,
    };
  } finally {
    // Always clean up the worktree so the next task run starts
    // fresh and no credentialed remote lingers on disk.
    if (workDir.startsWith(`${WORKTREES_BASE}/`) && existsSync(workDir)) {
      await rm(workDir, { recursive: true, force: true });
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        // Disable terminal prompts — if credentials fail we want
        // a clean non-zero exit, not a hung process.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
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
