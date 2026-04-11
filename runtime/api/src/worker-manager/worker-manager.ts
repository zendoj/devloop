/* eslint-disable no-console */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../data-source';

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
const FAKE_WORK_MS = 400;

const WORKER_ID = `wm-${process.pid}-${Date.now().toString(36)}`;

let running = true;

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

async function processOne(
  ds: DataSource,
  taskId: string,
  workerHandle: string,
): Promise<void> {
  // Step 1: claim the assigned task. claim_assigned_task atomically
  // transitions status 'assigned' → 'in_progress' AND bumps
  // lease_version in a single statement, so after this call the
  // task is already in_progress. If the task has moved out of
  // 'assigned' since the SELECT above, the function returns zero
  // rows and we skip.
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

  // Step 2: simulate work. Real Claude sandbox invocation lives
  // in Fas 3.
  await sleep(FAKE_WORK_MS);

  // Step 3: transition in_progress → review so the reviewer
  // (Fas 4) can pick it up.
  const reviewRows = (await ds.query(
    `
    SELECT public.fence_and_transition(
      $1, $2::bigint, 'in_progress'::public.task_status_enum,
      'review'::public.task_status_enum,
      $3::varchar(128), 'system'::public.actor_kind_enum,
      jsonb_build_object('worker_id', $3::text, 'stub', true, 'summary', 'stub work complete'),
      $3::varchar(128)
    ) AS new_lease
    `,
    [taskId, currentLease, WORKER_ID],
  )) as Array<{ new_lease: string | number }>;
  currentLease = Number(reviewRows[0]?.new_lease ?? currentLease);
  console.log(`[wm] ${taskId} review lease=${currentLease} (handed off)`);
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
