/* eslint-disable no-console */
import 'reflect-metadata';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../data-source';
import { jcs } from './jcs';

/**
 * DevLoop Deployer (Fas 5).
 *
 * Polls agent_tasks WHERE status='approved'. For each:
 *   1. fence_and_transition approved → deploying (acquires
 *      deploy_mutex, requires worker_id).
 *   2. "Merge" — for Fas 5 we do NOT actually merge a PR on
 *      GitHub. The branch sits on the project repo and a human
 *      can merge later. We use approved_head_sha as the
 *      merged_commit_sha for state-machine purposes so the
 *      pipeline progresses end-to-end.
 *   3. fence_and_transition deploying → merged with
 *      merged_commit_sha in the payload.
 *   4. Build the canonical JCS desired_state payload, sign with
 *      Ed25519 from /etc/devloop/deploy_signing_priv_<key_id>,
 *      call record_desired_state to get the new desired state id.
 *   5. fence_and_transition merged → verifying with
 *      applied_desired_state_id in the payload.
 *
 * After this, the Host Agent (separate service) sees the new
 * desired_state_history row, calls record_apply_started /
 * heartbeat / record_deploy_applied. The Deployer's verifier
 * loop watches for tasks in 'verifying' whose
 * applied_desired_state_id has applied_status='success' and
 * fence_and_transitions verifying → verified.
 *
 * Security:
 *   - The private key is loaded once at startup from
 *     $CREDENTIALS_DIRECTORY/deploy_signing_priv_<key_id> via
 *     systemd LoadCredential. Never logged.
 *   - Active key id is read from
 *     $CREDENTIALS_DIRECTORY/deploy_signing_active_key_id which
 *     names the file to load.
 *   - The signed bytes (raw JCS bytes) are stored verbatim in
 *     desired_state_history.signed_bytes; the host verifies
 *     against them without re-canonicalizing (per ARCHITECTURE
 *     §5.4 / §19 D8).
 *   - record_desired_state validates that the signing_key_id
 *     references the currently-active key via FOR KEY SHARE,
 *     so a rotation in flight cannot land a stale signature.
 */

const POLL_INTERVAL_MS = 4_000;
const VERIFY_POLL_LIMIT = 10;
const BATCH_SIZE = 3;

const DEPLOYER_ID = `dp-${process.pid}-${Date.now().toString(36)}`;

let running = true;

function loadFile(name: string): string | null {
  const credDir = process.env['CREDENTIALS_DIRECTORY'];
  if (credDir) {
    try {
      return readFileSync(`${credDir}/${name}`, 'utf8');
    } catch {
      /* fall through */
    }
  }
  try {
    return readFileSync(`/etc/devloop/${name}`, 'utf8');
  } catch {
    return null;
  }
}

const ACTIVE_KEY_ID = (loadFile('deploy_signing_active_key_id') ?? '').trim();
const SIGNING_PRIV_PEM =
  ACTIVE_KEY_ID.length > 0
    ? loadFile(`deploy_signing_priv_${ACTIVE_KEY_ID}`)
    : null;

let SIGNING_KEY: ReturnType<typeof createPrivateKey> | null = null;
if (SIGNING_PRIV_PEM !== null) {
  SIGNING_KEY = createPrivateKey({ key: SIGNING_PRIV_PEM, format: 'pem' });
}

interface ApprovedTask {
  task_id: string;
  display_id: string;
  project_id: string;
  module: string;
  lease_version: number;
  branch_name: string;
  base_sha: string;
  head_sha: string;
  default_branch: string;
}

interface VerifyingTask {
  task_id: string;
  display_id: string;
  lease_version: number;
  applied_desired_state_id: string;
  applied_status: string | null;
}

async function main(): Promise<void> {
  console.log(`[dp] starting deployer ${DEPLOYER_ID}`);
  if (ACTIVE_KEY_ID.length === 0 || SIGNING_KEY === null) {
    console.error(
      '[dp] FATAL: deploy_signing_active_key_id or deploy_signing_priv_<key_id> missing',
    );
    process.exit(2);
  }
  console.log(`[dp] active signing key: ${ACTIVE_KEY_ID}`);

  const ds = buildDataSource();
  await ds.initialize();

  process.on('SIGTERM', () => {
    console.log('[dp] SIGTERM — draining');
    running = false;
  });
  process.on('SIGINT', () => {
    console.log('[dp] SIGINT — draining');
    running = false;
  });

  try {
    while (running) {
      try {
        await deployApproved(ds);
        await verifyVerifying(ds);
      } catch (err) {
        console.error('[dp] iteration error:', err);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await ds.destroy();
    console.log('[dp] shutdown complete');
  }
}

async function deployApproved(ds: DataSource): Promise<void> {
  const rows = (await ds.query(
    `
    SELECT
      at.id            AS task_id,
      at.display_id,
      at.project_id,
      at.module,
      at.lease_version,
      at.branch_name,
      at.approved_base_sha AS base_sha,
      at.approved_head_sha AS head_sha,
      p.github_default_branch AS default_branch
    FROM public.agent_tasks at
    JOIN public.projects p ON p.id = at.project_id
    WHERE at.status = 'approved'
    ORDER BY at.created_at ASC
    LIMIT $1
    `,
    [BATCH_SIZE],
  )) as Array<ApprovedTask>;

  for (const t of rows) {
    if (!running) break;
    try {
      await deployOne(ds, t);
    } catch (err) {
      console.error(`[dp] ${t.display_id} deploy failed:`, err);
    }
  }
}

async function deployOne(ds: DataSource, t: ApprovedTask): Promise<void> {
  console.log(
    `[dp] ${t.display_id} deploying ${t.branch_name} head=${t.head_sha.slice(0, 7)}`,
  );

  // Step 1: approved → deploying (acquires deploy_mutex).
  const r1 = (await ds.query(
    `
    SELECT public.fence_and_transition(
      $1, $2::bigint, 'approved'::public.task_status_enum,
      'deploying'::public.task_status_enum,
      $3::varchar(128), 'system'::public.actor_kind_enum,
      jsonb_build_object('deployer_id', $3::text),
      $3::varchar(128)
    ) AS new_lease
    `,
    [t.task_id, t.lease_version, DEPLOYER_ID],
  )) as Array<{ new_lease: string | number }>;
  let currentLease = Number(r1[0]?.new_lease ?? t.lease_version);

  // Step 2: deploying → merged. We do NOT actually merge a PR on
  // GitHub in this phase. Use the worker's head_sha as the
  // merged_commit_sha for state-machine purposes. The branch is
  // available on the repo for a human to merge.
  const mergedSha = t.head_sha;
  const r2 = (await ds.query(
    `
    SELECT public.fence_and_transition(
      $1, $2::bigint, 'deploying'::public.task_status_enum,
      'merged'::public.task_status_enum,
      $3::varchar(128), 'system'::public.actor_kind_enum,
      jsonb_build_object('merged_commit_sha', $4::text),
      $3::varchar(128)
    ) AS new_lease
    `,
    [t.task_id, currentLease, DEPLOYER_ID, mergedSha],
  )) as Array<{ new_lease: string | number }>;
  currentLease = Number(r2[0]?.new_lease ?? currentLease);

  // Step 3: build + sign desired_state, call record_desired_state.
  const issuedAt = new Date().toISOString();
  const desired = {
    project_id: t.project_id,
    deploy_sha: mergedSha,
    base_sha: t.base_sha,
    action: 'deploy',
    target_branch: t.default_branch,
    signing_key_id: ACTIVE_KEY_ID,
    issued_at: issuedAt,
  };
  const canonical = jcs(desired);
  const signedBytes = Buffer.from(canonical, 'utf8');
  const signature = cryptoSign(null, signedBytes, SIGNING_KEY!);
  if (signature.length !== 64) {
    throw new Error(`bad ed25519 signature length ${signature.length}`);
  }

  const r3 = (await ds.query(
    `
    SELECT public.record_desired_state(
      $1::uuid,
      $2::varchar(64),
      $3::varchar(64),
      'deploy'::public.desired_action_enum,
      $4::varchar(128),
      $5::varchar(64),
      $6::bytea,
      $7::bytea,
      $8::uuid,
      NULL::uuid
    ) AS desired_state_id
    `,
    [
      t.project_id,
      mergedSha,
      t.base_sha,
      t.default_branch,
      ACTIVE_KEY_ID,
      signedBytes,
      signature,
      t.task_id,
    ],
  )) as Array<{ desired_state_id: string }>;
  const desiredStateId = r3[0]?.desired_state_id;
  if (!desiredStateId) {
    throw new Error('record_desired_state returned no id');
  }

  // Step 4: merged → verifying with applied_desired_state_id.
  const r4 = (await ds.query(
    `
    SELECT public.fence_and_transition(
      $1, $2::bigint, 'merged'::public.task_status_enum,
      'verifying'::public.task_status_enum,
      $3::varchar(128), 'system'::public.actor_kind_enum,
      jsonb_build_object('applied_desired_state_id', $4::text),
      $3::varchar(128)
    ) AS new_lease
    `,
    [t.task_id, currentLease, DEPLOYER_ID, desiredStateId],
  )) as Array<{ new_lease: string | number }>;
  currentLease = Number(r4[0]?.new_lease ?? currentLease);
  console.log(
    `[dp] ${t.display_id} → verifying lease=${currentLease} desired_state=${desiredStateId.slice(0, 8)}`,
  );
}

async function verifyVerifying(ds: DataSource): Promise<void> {
  // Pick up tasks in verifying whose linked desired_state has
  // applied_status='success' AND the host's reported applied_sha
  // exactly matches both the SHA we signed (deploy_sha) AND the
  // task's merged_commit_sha. The latter check is the
  // belt-and-suspenders against a buggy or compromised host
  // agent that returns success on a different commit.
  const rows = (await ds.query(
    `
    SELECT
      at.id   AS task_id,
      at.display_id,
      at.lease_version,
      at.applied_desired_state_id,
      dsh.applied_status::text AS applied_status
    FROM public.agent_tasks at
    JOIN public.desired_state_history dsh ON dsh.id = at.applied_desired_state_id
    WHERE at.status = 'verifying'
      AND dsh.applied_status = 'success'
      AND dsh.applied_sha IS NOT NULL
      AND dsh.applied_sha = at.merged_commit_sha
      AND dsh.applied_sha = dsh.deploy_sha
    ORDER BY at.created_at ASC
    LIMIT $1
    `,
    [VERIFY_POLL_LIMIT],
  )) as Array<VerifyingTask>;

  for (const t of rows) {
    if (!running) break;
    try {
      await ds.query(
        `
        SELECT public.fence_and_transition(
          $1, $2::bigint, 'verifying'::public.task_status_enum,
          'verified'::public.task_status_enum,
          $3::varchar(128), 'system'::public.actor_kind_enum,
          jsonb_build_object('deployer_id', $3::text),
          $3::varchar(128)
        )
        `,
        [t.task_id, t.lease_version, DEPLOYER_ID],
      );
      console.log(`[dp] ${t.display_id} → verified ✓`);
    } catch (err) {
      console.error(`[dp] ${t.display_id} verify transition failed:`, err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref();
  });
}

main().catch((err) => {
  console.error('[dp] fatal:', err);
  process.exit(1);
});
