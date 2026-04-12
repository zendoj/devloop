/* eslint-disable no-console */
import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../data-source';

/**
 * DevLoop Host Agent (Fas 5 dry-run skeleton).
 *
 * In a real deployment this runs on the MANAGED HOST (not central)
 * and polls central's desired_state_history for new rows targeting
 * its project. For Fas 5 we colocate the host agent on the central
 * machine and run it in DRY-RUN mode: it polls, calls the
 * record_apply_* lifecycle, but never actually touches a host file
 * system or restarts a service. The architecture's pull-based
 * deploy contract is preserved at the database level.
 *
 * Loop per iteration:
 *   1. SELECT desired_state_history rows where applied_status IS NULL
 *      AND apply_started_at IS NULL, ordered by seq_no, limit N.
 *      In real deployment the host filters by project_id matching
 *      its own; in dry-run mode we apply to every project on the
 *      central machine because all projects belong to one operator.
 *   2. For each row:
 *      a. record_apply_started(desired_state_id, project_id)
 *      b. (dry-run: log what would happen)
 *      c. record_apply_heartbeat
 *      d. record_deploy_applied(success, applied_sha=deploy_sha)
 *
 * The host agent is INTENTIONALLY a separate process so the
 * production setup remains identical: same code, real or
 * dry-run depends only on whether the agent has the
 * apply_changes permission on the host. In dry-run mode it runs
 * as devloop-api on the central machine — it has no shell, no
 * deployment credentials, and no write access to anything beyond
 * the Postgres tables it already had.
 *
 * Security:
 *   - Only EXECUTE on record_apply_* and SELECT on
 *     desired_state_history are needed. devloop_api already has
 *     these from migration 007.
 *   - The agent NEVER reads or signs anything. The signature on
 *     desired_state_history is checked by the host's policy.yml
 *     in real deployment; in dry-run we trust central.
 *   - DRY_RUN=true is hardcoded for this phase. Setting it to
 *     false in a future phase requires:
 *       - signature verification using the public key from
 *         signing_keys joined to desired_state_history.signing_key_id
 *       - real shell execution under a sandbox
 *       - reload / restart of the host service
 */

const POLL_INTERVAL_MS = 3_000;
const BATCH_SIZE = 5;
/**
 * Real apply path is now on by default. Set DEVLOOP_HOST_AGENT_APPLY=0
 * to force dry-run. When real apply is on, the host-agent shells out
 * to /usr/local/bin/devloop-apply-to-crm.sh with the target SHA; that
 * script does git fetch + build + pm2 restart + health probe.
 */
const DRY_RUN = process.env['DEVLOOP_HOST_AGENT_APPLY'] !== '1';
const APPLY_SCRIPT = '/usr/local/bin/devloop-apply-to-crm.sh';
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;

const HOST_AGENT_ID = `ha-${process.pid}-${Date.now().toString(36)}`;

let running = true;

interface PendingDeploy {
  desired_state_id: string;
  project_id: string;
  project_slug: string;
  seq_no: number;
  deploy_sha: string;
  base_sha: string;
  action: string;
  target_branch: string;
  signing_key_id: string;
}

async function main(): Promise<void> {
  console.log(
    `[ha] starting host agent ${HOST_AGENT_ID} (DRY_RUN=${DRY_RUN})`,
  );
  const ds = buildDataSource();
  await ds.initialize();

  process.on('SIGTERM', () => {
    console.log('[ha] SIGTERM — draining');
    running = false;
  });
  process.on('SIGINT', () => {
    console.log('[ha] SIGINT — draining');
    running = false;
  });

  try {
    while (running) {
      try {
        await runOnce(ds);
      } catch (err) {
        console.error('[ha] iteration error:', err);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await ds.destroy();
    console.log('[ha] shutdown complete');
  }
}

async function runOnce(ds: DataSource): Promise<void> {
  const rows = (await ds.query(
    `
    SELECT
      dsh.id              AS desired_state_id,
      dsh.project_id,
      p.slug              AS project_slug,
      dsh.seq_no,
      dsh.deploy_sha,
      dsh.base_sha,
      dsh.action::text    AS action,
      dsh.target_branch,
      dsh.signing_key_id
    FROM public.desired_state_history dsh
    JOIN public.projects p ON p.id = dsh.project_id
    WHERE dsh.applied_status IS NULL
      AND dsh.apply_started_at IS NULL
    ORDER BY dsh.seq_no ASC
    LIMIT $1
    `,
    [BATCH_SIZE],
  )) as Array<PendingDeploy>;

  for (const d of rows) {
    if (!running) break;
    try {
      await applyOne(ds, d);
    } catch (err) {
      console.error(`[ha] desired_state ${d.desired_state_id} failed:`, err);
    }
  }
}

async function applyOne(ds: DataSource, d: PendingDeploy): Promise<void> {
  console.log(
    `[ha] applying ${d.project_slug} seq=${d.seq_no} action=${d.action} sha=${d.deploy_sha.slice(0, 7)}`,
  );

  // Step 1: record_apply_started.
  const started = (await ds.query(
    `SELECT public.record_apply_started($1, $2) AS ok`,
    [d.desired_state_id, d.project_id],
  )) as Array<{ ok: boolean }>;
  if (started[0]?.ok !== true) {
    console.warn(
      `[ha] record_apply_started returned false for ${d.desired_state_id}`,
    );
    return;
  }

  // Step 2: heartbeat.
  await ds.query(`SELECT public.record_apply_heartbeat($1, $2)`, [
    d.desired_state_id,
    d.project_id,
  ]);

  // Step 3: apply the change. In dry-run mode we just wait and
  // pretend; in real mode we shell out to the apply script
  // which does git fetch + build + pm2 restart + health probe.
  let applyStatus: 'success' | 'failed' = 'success';
  let applyLog = '';

  if (DRY_RUN) {
    await sleep(300);
    console.log(`[ha]   (dry-run: pretending apply succeeded)`);
    applyLog = `dry-run apply by ${HOST_AGENT_ID}`;
  } else {
    const scriptResult = await runApplyScript(d.deploy_sha);
    applyStatus = scriptResult.ok ? 'success' : 'failed';
    applyLog = scriptResult.log.slice(-4000);
    if (!scriptResult.ok) {
      console.error(
        `[ha]   ✗ apply failed for ${d.project_slug} seq=${d.seq_no} exit=${scriptResult.exitCode}`,
      );
    }
  }

  // Step 4: record final outcome — success OR failed. Either way
  // the deployer loop picks it up: success → verifying → ready_
  // for_test; failed → the rollback path kicks in.
  const finished = (await ds.query(
    `
    SELECT public.record_deploy_applied(
      $1::uuid, $2::uuid,
      $3::public.apply_status_enum,
      $4::varchar(64),
      $5::text
    ) AS ok
    `,
    [
      d.desired_state_id,
      d.project_id,
      applyStatus,
      applyStatus === 'success' ? d.deploy_sha : null,
      applyLog,
    ],
  )) as Array<{ ok: boolean }>;
  if (finished[0]?.ok !== true) {
    console.warn(
      `[ha] record_deploy_applied returned false for ${d.desired_state_id}`,
    );
    return;
  }
  console.log(
    `[ha]   ${applyStatus === 'success' ? '✓' : '✗'} ${applyStatus} ${d.project_slug} seq=${d.seq_no}`,
  );
}

/**
 * Shell out to /usr/local/bin/devloop-apply-to-crm.sh. Returns
 * ok=true on exit code 0, false otherwise. Captures the full
 * stdout+stderr so record_deploy_applied can stash a log
 * excerpt in desired_state_history.applied_log_excerpt.
 *
 * Hard kill after APPLY_TIMEOUT_MS (10 minutes). If the build
 * hangs that long something is very wrong and the rollback
 * path should take over rather than blocking the host-agent
 * loop forever.
 */
async function runApplyScript(
  targetSha: string,
): Promise<{ ok: boolean; exitCode: number; log: string }> {
  return new Promise((resolve) => {
    const proc = spawn(APPLY_SCRIPT, [targetSha], {
      cwd: '/',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/home/jonas',
      },
    });
    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({
        ok: false,
        exitCode: -1,
        log: output + '\n[ha] SIGKILL after apply timeout',
      });
    }, APPLY_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -2,
        log: `spawn error: ${err.message}`,
      });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        log: output,
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref();
  });
}

main().catch((err) => {
  console.error('[ha] fatal:', err);
  process.exit(1);
});
