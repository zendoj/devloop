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

// GitHub token for PR creation/merge. Same file the worker
// manager uses. Reading empty as null so the deployer fails
// fast at startup if the operator forgot to provision it.
const GITHUB_TOKEN = (loadFile('github_token') ?? '').trim();

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
  github_owner: string;
  github_repo: string;
  report_title: string;
}

interface PrResult {
  pr_number: number;
  merge_sha: string;
}

interface VerifyingTask {
  task_id: string;
  display_id: string;
  lease_version: number;
  applied_desired_state_id: string;
  applied_status: string | null;
}

interface FailingTask {
  task_id: string;
  display_id: string;
  project_id: string;
  lease_version: number;
  approved_base_sha: string;
  merged_commit_sha: string;
  default_branch: string;
  applied_status: string;
}

interface RollingBackTask {
  task_id: string;
  display_id: string;
  lease_version: number;
  rollback_desired_state_id: string;
  applied_status: string | null;
  rollback_target_sha: string;
  applied_sha: string | null;
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
        await rollbackFailing(ds);
        await verifyRollback(ds);
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
      p.github_default_branch AS default_branch,
      p.github_owner,
      p.github_repo,
      r.title AS report_title
    FROM public.agent_tasks at
    JOIN public.projects p ON p.id = at.project_id
    JOIN public.reports  r ON r.id = at.report_id
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

  // Step -1: create + merge the GitHub PR BEFORE starting the
  // DB transaction. A PR creation or merge failure leaves the
  // task in 'approved' (untouched DB state) so the next
  // iteration retries cleanly. Doing this inside the txn would
  // hold the deploy_mutex across an external HTTP call, which
  // is worse under contention.
  let prResult: PrResult;
  try {
    prResult = await createAndMergePr(t);
  } catch (err) {
    console.error(`[dp] ${t.display_id} PR step failed:`, err);
    // Leave task in 'approved' — next iteration retries. If
    // the failure is permanent (e.g. branch already merged),
    // operators need to cancel the task manually for now.
    // A proper permanent/transient split is a Fas 6+ concern.
    return;
  }
  console.log(
    `[dp] ${t.display_id} PR #${prResult.pr_number} merged as ${prResult.merge_sha.slice(0, 7)}`,
  );

  // Step 0: build + sign desired_state OUTSIDE the transaction.
  // The signature is deterministic given the inputs and is
  // pure compute, so doing it before the transaction shortens
  // the lock window on agent_tasks/deploy_mutex inside the txn.
  const issuedAt = new Date().toISOString();
  const mergedSha = prResult.merge_sha;
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

  // Wrap all four DB steps in a single transaction so a process
  // crash mid-deploy never strands a task in 'merged' or
  // 'deploying'. PG rolls back on disconnect: the task stays
  // 'approved', the deploy_mutex is released, and the next
  // deployer iteration retries from scratch.
  const desiredStateId = await ds.transaction(async (m) => {
    // Step 1: approved → deploying (acquires deploy_mutex).
    const r1 = (await m.query(
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

    // Step 2: deploying → merged. Also stamp github_pr_number so
    // the UI can link back to the GitHub PR that was
    // auto-merged.
    const r2 = (await m.query(
      `
      SELECT public.fence_and_transition(
        $1, $2::bigint, 'deploying'::public.task_status_enum,
        'merged'::public.task_status_enum,
        $3::varchar(128), 'system'::public.actor_kind_enum,
        jsonb_build_object(
          'merged_commit_sha', $4::text,
          'github_pr_number',  $5::int
        ),
        $3::varchar(128)
      ) AS new_lease
      `,
      [t.task_id, currentLease, DEPLOYER_ID, mergedSha, prResult.pr_number],
    )) as Array<{ new_lease: string | number }>;
    currentLease = Number(r2[0]?.new_lease ?? currentLease);

    // Step 3: record signed desired_state.
    const r3 = (await m.query(
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
    const dsi = r3[0]?.desired_state_id;
    if (!dsi) {
      throw new Error('record_desired_state returned no id');
    }

    // Step 4: merged → verifying with applied_desired_state_id.
    await m.query(
      `
      SELECT public.fence_and_transition(
        $1, $2::bigint, 'merged'::public.task_status_enum,
        'verifying'::public.task_status_enum,
        $3::varchar(128), 'system'::public.actor_kind_enum,
        jsonb_build_object('applied_desired_state_id', $4::text),
        $3::varchar(128)
      )
      `,
      [t.task_id, currentLease, DEPLOYER_ID, dsi],
    );
    return dsi;
  });

  console.log(
    `[dp] ${t.display_id} → verifying desired_state=${desiredStateId.slice(0, 8)}`,
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

/**
 * Fas B4 — rollback trigger.
 *
 * Polls tasks in 'verifying' whose linked applied_desired_state
 * has applied_status IN ('failed','timed_out'). For each such
 * task we:
 *
 *   1. Build a new signed desired_state with action='rollback',
 *      deploy_sha = task.approved_base_sha (the SHA the branch
 *      was based on, i.e. the pre-change state we want to
 *      restore), base_sha = task.merged_commit_sha (the failed
 *      deploy the host is currently sitting on).
 *   2. Record it via record_desired_state inside a transaction
 *      that also fences the task verifying → rolling_back with
 *      rollback_desired_state_id in the payload. Mutex + lock
 *      stay held (per state machine).
 *
 * The host agent will pick up the new rollback row the same way
 * it picks up deploys — a rollback is just a signed desired_state
 * with a different action. `verifyRollback()` below watches for
 * the host's result and transitions rolling_back → rolled_back
 * or → rollback_failed.
 */
async function rollbackFailing(ds: DataSource): Promise<void> {
  const rows = (await ds.query(
    `
    SELECT
      at.id                   AS task_id,
      at.display_id,
      at.project_id,
      at.lease_version,
      at.approved_base_sha,
      at.merged_commit_sha,
      p.github_default_branch AS default_branch,
      dsh.applied_status::text AS applied_status
    FROM public.agent_tasks at
    JOIN public.projects p              ON p.id  = at.project_id
    JOIN public.desired_state_history dsh ON dsh.id = at.applied_desired_state_id
    WHERE at.status = 'verifying'
      AND dsh.applied_status IN ('failed', 'timed_out')
      AND at.approved_base_sha IS NOT NULL
      AND at.merged_commit_sha IS NOT NULL
    ORDER BY at.created_at ASC
    LIMIT $1
    `,
    [VERIFY_POLL_LIMIT],
  )) as Array<FailingTask>;

  for (const t of rows) {
    if (!running) break;
    try {
      await rollbackOne(ds, t);
    } catch (err) {
      console.error(`[dp] ${t.display_id} rollback trigger failed:`, err);
    }
  }
}

async function rollbackOne(ds: DataSource, t: FailingTask): Promise<void> {
  console.log(
    `[dp] ${t.display_id} host reported ${t.applied_status} for ${t.merged_commit_sha.slice(0, 7)} — rolling back to ${t.approved_base_sha.slice(0, 7)}`,
  );

  // Sign the rollback desired_state OUTSIDE the transaction —
  // same ordering rationale as deployOne: the lock window on
  // agent_tasks stays as short as possible.
  const issuedAt = new Date().toISOString();
  const desired = {
    project_id: t.project_id,
    deploy_sha: t.approved_base_sha,
    base_sha: t.merged_commit_sha,
    action: 'rollback',
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

  await ds.transaction(async (m) => {
    // Step 1: record the rollback desired_state first so we have
    // its id to stamp into the task row on the fence transition.
    const r1 = (await m.query(
      `
      SELECT public.record_desired_state(
        $1::uuid,
        $2::varchar(64),
        $3::varchar(64),
        'rollback'::public.desired_action_enum,
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
        t.approved_base_sha,
        t.merged_commit_sha,
        t.default_branch,
        ACTIVE_KEY_ID,
        signedBytes,
        signature,
        t.task_id,
      ],
    )) as Array<{ desired_state_id: string }>;
    const rollbackDsi = r1[0]?.desired_state_id;
    if (!rollbackDsi) {
      throw new Error('record_desired_state(rollback) returned no id');
    }

    // Step 2: verifying → rolling_back with rollback id stamped.
    await m.query(
      `
      SELECT public.fence_and_transition(
        $1, $2::bigint, 'verifying'::public.task_status_enum,
        'rolling_back'::public.task_status_enum,
        $3::varchar(128), 'system'::public.actor_kind_enum,
        jsonb_build_object(
          'rollback_desired_state_id', $4::text,
          'failure_reason', $5::text
        ),
        $3::varchar(128)
      )
      `,
      [
        t.task_id,
        t.lease_version,
        DEPLOYER_ID,
        rollbackDsi,
        `host reported applied_status=${t.applied_status} on ${t.merged_commit_sha}`,
      ],
    );
  });

  console.log(
    `[dp] ${t.display_id} → rolling_back (rollback desired_state queued)`,
  );
}

/**
 * Fas B4 — rollback verifier.
 *
 * Mirrors verifyVerifying() for tasks in 'rolling_back'. Reads
 * the rollback desired_state's applied_status:
 *
 *   - 'success' AND applied_sha = rollback's deploy_sha
 *     → fence rolling_back → rolled_back (terminal).
 *   - 'failed' OR 'timed_out'
 *     → fence rolling_back → rollback_failed (§19 D5: lock +
 *       mutex SEALED to infinity until operator recovery).
 *
 * A 'success' where applied_sha does not match is treated like a
 * failure: the host reported success but on the wrong SHA, which
 * means rollback did not actually happen. rollback_failed is
 * safer than rolled_back here.
 */
async function verifyRollback(ds: DataSource): Promise<void> {
  const rows = (await ds.query(
    `
    SELECT
      at.id                         AS task_id,
      at.display_id,
      at.lease_version,
      at.rollback_desired_state_id,
      dsh.applied_status::text      AS applied_status,
      dsh.deploy_sha                AS rollback_target_sha,
      dsh.applied_sha               AS applied_sha
    FROM public.agent_tasks at
    JOIN public.desired_state_history dsh ON dsh.id = at.rollback_desired_state_id
    WHERE at.status = 'rolling_back'
      AND dsh.applied_status IS NOT NULL
    ORDER BY at.created_at ASC
    LIMIT $1
    `,
    [VERIFY_POLL_LIMIT],
  )) as Array<RollingBackTask>;

  for (const t of rows) {
    if (!running) break;
    const success =
      t.applied_status === 'success' &&
      t.applied_sha !== null &&
      t.applied_sha === t.rollback_target_sha;
    const failed =
      t.applied_status === 'failed' ||
      t.applied_status === 'timed_out' ||
      (t.applied_status === 'success' && !success);

    try {
      if (success) {
        await ds.query(
          `
          SELECT public.fence_and_transition(
            $1, $2::bigint, 'rolling_back'::public.task_status_enum,
            'rolled_back'::public.task_status_enum,
            $3::varchar(128), 'system'::public.actor_kind_enum,
            jsonb_build_object(
              'rollback_commit_sha', $4::text
            ),
            $3::varchar(128)
          )
          `,
          [t.task_id, t.lease_version, DEPLOYER_ID, t.applied_sha],
        );
        console.log(`[dp] ${t.display_id} → rolled_back ↩`);
      } else if (failed) {
        await ds.query(
          `
          SELECT public.fence_and_transition(
            $1, $2::bigint, 'rolling_back'::public.task_status_enum,
            'rollback_failed'::public.task_status_enum,
            $3::varchar(128), 'system'::public.actor_kind_enum,
            jsonb_build_object(
              'failure_reason', $4::text
            ),
            $3::varchar(128)
          )
          `,
          [
            t.task_id,
            t.lease_version,
            DEPLOYER_ID,
            `rollback apply ${t.applied_status}: host applied_sha=${t.applied_sha ?? 'null'} expected=${t.rollback_target_sha}`,
          ],
        );
        console.warn(
          `[dp] ${t.display_id} → rollback_failed (${t.applied_status}, applied_sha=${t.applied_sha ?? 'null'})`,
        );
      }
    } catch (err) {
      console.error(`[dp] ${t.display_id} rollback verify failed:`, err);
    }
  }
}

/**
 * Create a GitHub PR for the worker's branch and immediately
 * merge it (squash). Returns the real merge_commit_sha so the
 * deployer can use it as the deploy_sha for the signed
 * desired_state. The reviewer (Fas 4) has already gpt-5.4-
 * approved the diff before the task hit 'approved', so the
 * auto-merge is gated on that.
 *
 * Raises on any GitHub API failure. The caller leaves the task
 * in 'approved' on failure so a retry is clean.
 *
 * Note: a real production deploy pipeline would additionally
 * wait for CI + branch protection checks. This function
 * depends on branch protection being configured separately on
 * the repo — if GitHub refuses to merge because required
 * checks are missing, the merge call returns 405/422 and we
 * throw.
 */
async function createAndMergePr(t: ApprovedTask): Promise<PrResult> {
  if (GITHUB_TOKEN.length === 0) {
    throw new Error('github_token not loaded');
  }
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'devloop-deployer/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  const repo = `${t.github_owner}/${t.github_repo}`;

  // Step 1: create the PR. If a PR already exists for this
  // branch (e.g. a previous retry), GitHub returns 422 with
  // a specific error message; we then look up the existing PR.
  const createBody = {
    title: `devloop(${t.display_id}): ${t.report_title}`.slice(0, 250),
    body: [
      `DevLoop task: ${t.display_id}`,
      `Module: ${t.module}`,
      `Base SHA: ${t.base_sha}`,
      `Head SHA: ${t.head_sha}`,
      '',
      'This PR was opened automatically by the DevLoop deployer',
      'after gpt-5.4 reasoning=medium reviewed the diff and',
      'marked the task approved.',
    ].join('\n'),
    head: t.branch_name,
    base: t.default_branch,
    maintainer_can_modify: false,
  };

  const createUrl = `https://api.github.com/repos/${t.github_owner}/${t.github_repo}/pulls`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(createBody),
  });

  let prNumber: number;
  if (createRes.status === 201) {
    const created = (await createRes.json()) as { number: number };
    prNumber = created.number;
    console.log(`[dp] ${t.display_id} opened PR #${prNumber} on ${repo}`);
  } else if (createRes.status === 422) {
    // Either the PR already exists, or the base/head is invalid.
    // Probe for an existing open PR for this branch.
    const existingUrl = `https://api.github.com/repos/${t.github_owner}/${t.github_repo}/pulls?head=${encodeURIComponent(`${t.github_owner}:${t.branch_name}`)}&state=open`;
    const existingRes = await fetch(existingUrl, { method: 'GET', headers });
    if (!existingRes.ok) {
      const err = await createRes.text().catch(() => '');
      throw new Error(`PR create 422 and existing-PR probe failed: ${err.slice(0, 200)}`);
    }
    const existing = (await existingRes.json()) as Array<{ number: number }>;
    if (existing.length === 0) {
      const err = await createRes.text().catch(() => '');
      throw new Error(`PR create 422 (no existing PR found): ${err.slice(0, 300)}`);
    }
    prNumber = existing[0]!.number;
    console.log(`[dp] ${t.display_id} reusing existing PR #${prNumber} on ${repo}`);
  } else {
    const err = await createRes.text().catch(() => '');
    throw new Error(`PR create HTTP ${createRes.status}: ${err.slice(0, 300)}`);
  }

  // Step 2: squash merge the PR.
  const mergeUrl = `https://api.github.com/repos/${t.github_owner}/${t.github_repo}/pulls/${prNumber}/merge`;
  const mergeBody = {
    merge_method: 'squash',
    commit_title: `devloop(${t.display_id}): ${t.report_title}`.slice(0, 250),
    commit_message: [
      `DevLoop task: ${t.display_id}`,
      `Auto-merged by devloop-deployer after gpt-5.4 review.`,
    ].join('\n'),
  };
  const mergeRes = await fetch(mergeUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(mergeBody),
  });
  if (!mergeRes.ok) {
    const err = await mergeRes.text().catch(() => '');
    throw new Error(`PR merge HTTP ${mergeRes.status}: ${err.slice(0, 300)}`);
  }
  const merged = (await mergeRes.json()) as { sha: string; merged: boolean };
  if (merged.merged !== true || typeof merged.sha !== 'string' || merged.sha.length < 7) {
    throw new Error(`PR merge unexpected response: ${JSON.stringify(merged).slice(0, 200)}`);
  }
  return { pr_number: prNumber, merge_sha: merged.sha };
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
