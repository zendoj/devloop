/* eslint-disable no-console */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../data-source';
import { runWorkerStub, WorkerRunResult } from './git-worker';

/**
 * DevLoop Worker Manager (Fas 2 skeleton).
 *
 * Polls agent_tasks for rows in 'assigned' status, claims each one
 * via public.claim_assigned_task, transitions it to 'in_progress'
 * via public.fence_and_transition, simulates work (no real Claude
 * yet — that is Fas 3), and transitions it to 'review' so the
 * reviewer worker (Fas 4) can pick it up.
 *
 * For each iteration:
 *   1. Select up to N tasks in 'assigned' status, oldest first,
 *      that are owned by some project (not scoped per-config yet).
 *   2. For each task, call claim_assigned_task(task_id, worker_id,
 *      worker_handle). Returns (new_lease, out_project_id,
 *      out_module) — we only use the new lease.
 *   3. Call fence_and_transition(task_id, new_lease, 'assigned',
 *      'in_progress', actor='worker-manager-stub',
 *      kind='system') to bump status.
 *   4. Sleep a moment to simulate thinking.
 *   5. Call fence_and_transition(task_id, current_lease, 'in_progress',
 *      'review') to hand off to the reviewer.
 *
 * Fas 2 intentionally skips every interesting thing:
 *   - no Claude call
 *   - no repo clone
 *   - no git operations
 *   - no branch push
 *   - no diff generation
 * All of that lives in Fas 3 inside this same daemon or a sibling.
 *
 * The process runs as the devloop-api OS user (peer-maps to
 * devloop_api PG role) under systemd as devloop-worker-manager.service.
 * The PG role only needs EXECUTE on claim_assigned_task and
 * fence_and_transition plus SELECT on agent_tasks — all granted
 * in migration 015.
 *
 * Graceful shutdown: SIGTERM sets a flag and the current
 * iteration finishes before the DataSource is destroyed. That way
 * a restart does not abandon half-processed task transitions.
 */

const POLL_INTERVAL_MS = 2_000;
const BATCH_SIZE = 5;

const WORKER_ID = `wm-${process.pid}-${Date.now().toString(36)}`;

let running = true;

function loadGithubToken(): string | null {
  // $CREDENTIALS_DIRECTORY (systemd LoadCredential) first, then
  // /etc/devloop/github_token, then env var. Missing token is
  // returned as null so non-git workflows can still run.
  const credDir = process.env['CREDENTIALS_DIRECTORY'];
  if (credDir) {
    try {
      return readFileSync(`${credDir}/github_token`, 'utf8').trim();
    } catch {
      /* fall through */
    }
  }
  try {
    return readFileSync('/etc/devloop/github_token', 'utf8').trim();
  } catch {
    /* fall through */
  }
  const env = process.env['DEVLOOP_GITHUB_TOKEN'];
  if (env && env.length > 0) return env.trim();
  return null;
}

const GITHUB_TOKEN = loadGithubToken();

async function main(): Promise<void> {
  console.log(`[wm] starting worker manager ${WORKER_ID}`);
  const ds = buildDataSource();
  await ds.initialize();

  process.on('SIGTERM', () => {
    console.log('[wm] SIGTERM — draining');
    running = false;
  });
  process.on('SIGINT', () => {
    console.log('[wm] SIGINT — draining');
    running = false;
  });

  try {
    while (running) {
      try {
        await retryQueued(ds);
        await runOnce(ds);
      } catch (err) {
        console.error('[wm] iteration error:', err);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await ds.destroy();
    console.log('[wm] shutdown complete');
  }
}

/**
 * Sweep tasks the orchestrator left in queued_for_lock because
 * the module lock was held by another active task. Try to
 * acquire the lock now; on success, fence_and_transition the
 * task into 'assigned' so the next runOnce pass picks it up.
 *
 * Without this loop a task can stall forever the moment two
 * reports land in the same module simultaneously. With it, the
 * second task gets promoted as soon as the first releases its
 * module lock (any terminal/lock-releasing transition).
 */
async function retryQueued(ds: DataSource): Promise<void> {
  const rows = (await ds.query(
    `
    SELECT id, project_id, module, lease_version
      FROM public.agent_tasks
     WHERE status = 'queued_for_lock'
     ORDER BY created_at ASC
     LIMIT $1
    `,
    [BATCH_SIZE],
  )) as Array<{
    id: string;
    project_id: string;
    module: string;
    lease_version: string | number;
  }>;

  for (const task of rows) {
    if (!running) break;
    try {
      const lease = (await ds.query(
        `SELECT public.acquire_module_lock($1, $2, $3, $4) AS lease`,
        [task.project_id, task.module, task.id, WORKER_ID],
      )) as Array<{ lease: string | number | null }>;
      if (lease[0]?.lease === null || lease[0]?.lease === undefined) {
        // Still held by someone else — skip this iteration.
        continue;
      }
      await ds.query(
        `
        SELECT public.fence_and_transition(
          $1, $2::bigint, 'queued_for_lock'::public.task_status_enum,
          'assigned'::public.task_status_enum,
          $3::varchar(128), 'system'::public.actor_kind_enum,
          jsonb_build_object('module_lease', $4::int),
          NULL::varchar(128)
        )
        `,
        [task.id, Number(task.lease_version), WORKER_ID, Number(lease[0].lease)],
      );
      console.log(`[wm] ${task.id} promoted queued_for_lock → assigned`);
    } catch (err) {
      console.error(`[wm] retry promote ${task.id} failed:`, err);
    }
  }
}

async function runOnce(ds: DataSource): Promise<void> {
  const rows = (await ds.query(
    `
    SELECT id, project_id, module, lease_version
      FROM public.agent_tasks
     WHERE status = 'assigned'
     ORDER BY created_at ASC
     LIMIT $1
    `,
    [BATCH_SIZE],
  )) as Array<{
    id: string;
    project_id: string;
    module: string;
    lease_version: string | number;
  }>;

  for (const task of rows) {
    if (!running) break;
    const handle = randomUUID().slice(0, 8);
    try {
      await processOne(ds, task.id, handle);
    } catch (err) {
      console.error(`[wm] task ${task.id} failed:`, err);
    }
  }
}

interface TaskContext {
  task_id: string;
  display_id: string;
  module: string;
  project_id: string;
  project_slug: string;
  github_owner: string;
  github_repo: string;
  default_branch: string;
  report_id: string;
  report_title: string;
  report_body: string;
}

async function processOne(
  ds: DataSource,
  taskId: string,
  workerHandle: string,
): Promise<void> {
  // Step 1: claim the assigned task. claim_assigned_task atomically
  // transitions status 'assigned' → 'in_progress' AND bumps
  // lease_version in a single statement.
  const claimRows = (await ds.query(
    `
    SELECT out_lease_version, out_module, out_display_id
      FROM public.claim_assigned_task($1, $2, $3)
    `,
    [taskId, WORKER_ID, workerHandle],
  )) as Array<{
    out_lease_version: string | number | null;
    out_module: string | null;
    out_display_id: string | null;
  }>;

  const claim = claimRows[0];
  if (!claim || claim.out_lease_version === null) {
    console.warn(`[wm] ${taskId} not claimable — skipped`);
    return;
  }
  let currentLease = Number(claim.out_lease_version);
  console.log(
    `[wm] ${claim.out_display_id ?? taskId} claimed + in_progress lease=${currentLease} module=${claim.out_module}`,
  );

  // Step 2: load the full task context (project repo, report
  // body) needed by the worker runtime.
  const ctx = await loadTaskContext(ds, taskId);
  if (!ctx) {
    console.warn(`[wm] ${taskId} context lookup failed — failing task`);
    await failTask(ds, taskId, currentLease, 'context lookup failed');
    return;
  }

  // Step 3: actually run the worker. If the GitHub token was not
  // provisioned, fall back to a sleep-only stub so the state
  // machine still progresses (useful for staging environments
  // without push access).
  let result: WorkerRunResult;
  if (GITHUB_TOKEN === null) {
    console.warn('[wm] no github_token — running sleep-only stub');
    await sleep(400);
    result = {
      branch_name: `devloop/task/${ctx.display_id.toLowerCase()}`,
      base_sha: '0000000',
      head_sha: '0000000',
      files_changed: [],
      summary: 'no token — sleep-only stub',
    };
  } else {
    try {
      result = await runWorkerStub({
        taskId: ctx.task_id,
        displayId: ctx.display_id,
        projectSlug: ctx.project_slug,
        githubOwner: ctx.github_owner,
        githubRepo: ctx.github_repo,
        defaultBranch: ctx.default_branch,
        reportTitle: ctx.report_title,
        reportBody: ctx.report_body,
        githubToken: GITHUB_TOKEN,
        workerId: WORKER_ID,
      });
      console.log(
        `[wm] ${ctx.display_id} pushed ${result.branch_name} head=${result.head_sha.slice(0, 7)}`,
      );
    } catch (err) {
      console.error(`[wm] ${ctx.display_id} worker run failed:`, err);
      await failTask(ds, taskId, currentLease, (err as Error).message);
      return;
    }
  }

  // Step 4: stamp the diff metadata via the SECURITY DEFINER
  // helper. Returns false if the task moved out of in_progress
  // (e.g. cancelled by janitor) — in that case bail out.
  const stamped = (await ds.query(
    `
    SELECT public.record_worker_result(
      $1, $2, $3, $4, $5::jsonb
    ) AS ok
    `,
    [
      taskId,
      result.branch_name,
      result.base_sha,
      result.head_sha,
      JSON.stringify(result.files_changed),
    ],
  )) as Array<{ ok: boolean }>;
  if (stamped[0]?.ok !== true) {
    console.warn(`[wm] ${ctx.display_id} record_worker_result returned false`);
    return;
  }

  // Step 5: transition in_progress → review.
  const reviewRows = (await ds.query(
    `
    SELECT public.fence_and_transition(
      $1, $2::bigint, 'in_progress'::public.task_status_enum,
      'review'::public.task_status_enum,
      $3::varchar(128), 'system'::public.actor_kind_enum,
      jsonb_build_object(
        'worker_id', $3::text,
        'branch',    $4::text,
        'head_sha',  $5::text,
        'summary',   $6::text
      ),
      $3::varchar(128)
    ) AS new_lease
    `,
    [
      taskId,
      currentLease,
      WORKER_ID,
      result.branch_name,
      result.head_sha,
      result.summary,
    ],
  )) as Array<{ new_lease: string | number }>;
  currentLease = Number(reviewRows[0]?.new_lease ?? currentLease);
  console.log(`[wm] ${ctx.display_id} → review lease=${currentLease}`);
}

async function loadTaskContext(
  ds: DataSource,
  taskId: string,
): Promise<TaskContext | null> {
  const rows = (await ds.query(
    `
    SELECT
      at.id            AS task_id,
      at.display_id,
      at.module,
      at.project_id,
      p.slug           AS project_slug,
      p.github_owner,
      p.github_repo,
      p.github_default_branch AS default_branch,
      r.id             AS report_id,
      r.title          AS report_title,
      r.description    AS report_body
    FROM public.agent_tasks at
    JOIN public.projects p ON p.id = at.project_id
    JOIN public.reports  r ON r.id = at.report_id
    WHERE at.id = $1
    LIMIT 1
    `,
    [taskId],
  )) as Array<TaskContext>;
  return rows[0] ?? null;
}

async function failTask(
  ds: DataSource,
  taskId: string,
  expectedLease: number,
  reason: string,
): Promise<void> {
  try {
    await ds.query(
      `
      SELECT public.fence_and_transition(
        $1, $2::bigint, 'in_progress'::public.task_status_enum,
        'failed'::public.task_status_enum,
        $3::varchar(128), 'system'::public.actor_kind_enum,
        jsonb_build_object('reason', $4::text),
        $3::varchar(128)
      )
      `,
      [taskId, expectedLease, WORKER_ID, reason.slice(0, 1000)],
    );
  } catch (err) {
    console.error(`[wm] failTask ${taskId} also failed:`, err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref();
  });
}

main().catch((err) => {
  console.error('[wm] fatal:', err);
  process.exit(1);
});
