/* eslint-disable no-console */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../data-source';
import { callAgent } from '../agents/call-agent';

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

// Review score gate: approved verdicts with a score below this
// threshold are downgraded to changes_requested. Matches the
// "intentionally generous — approved ~60" doc in the system
// prompt for DevLoop Fas 3 stub diffs.
const MIN_APPROVAL_SCORE = 60;

// Advisory lock namespace key for reviewer claims. Two reviewer
// instances calling pg_try_advisory_lock with the same (class,
// task_id_hash) will see exactly one succeed; the other skips
// the task entirely without fetching the diff or calling OpenAI.
const REVIEWER_LOCK_CLASS = hashInt('devloop:reviewer_claim');

function hashInt(s: string): number {
  // Cheap 32-bit hash (same shape as pg's hashtext result range
  // for int). Deterministic, no crypto needed — this is just a
  // namespace key for advisory locks.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

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
  plan: string | null;
}

interface ReviewVerdict {
  decision: 'approved' | 'changes_requested';
  score: number;
  summary: string;
}

async function main(): Promise<void> {
  console.log(`[rv] starting reviewer ${REVIEWER_ID}`);
  // The API key for the reviewer agent lives in the DB-backed
  // agent_configs row and is loaded per-call by callAgent(). We
  // no longer verify it at startup — a missing/misconfigured
  // key surfaces as a loud error on the first real review call,
  // which is fine because the reviewer keeps the task in 'review'
  // and retries next iteration.
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
      at.files_changed,
      at.plan
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
  // Step 0: try to claim the task via a SESSION-scoped advisory
  // lock on a dedicated connection. Two reviewer instances
  // polling the same batch will both see this row in 'review'
  // + decision IS NULL; the first to call pg_try_advisory_lock
  // gets the claim, the second returns false and we skip
  // without fetching the diff or calling OpenAI.
  //
  // Session-scoped lock (NOT transaction-scoped) lets us hold
  // the claim across the external OpenAI call without keeping
  // a long-running transaction open. The lock is released
  // explicitly in finally. On process crash PG drops the
  // session and the lock goes with it.
  const qr = ds.createQueryRunner();
  await qr.connect();
  let claimed = false;
  try {
    const claimRows = (await qr.query(
      `SELECT pg_try_advisory_lock($1::int, hashtext($2::text)::int) AS ok`,
      [REVIEWER_LOCK_CLASS, task.task_id],
    )) as Array<{ ok: boolean }>;
    if (claimRows[0]?.ok !== true) {
      console.log(
        `[rv] ${task.display_id} already claimed by another reviewer — skipping`,
      );
      return;
    }
    claimed = true;
    await reviewOneClaimed(ds, task);
  } finally {
    if (claimed) {
      try {
        await qr.query(
          `SELECT pg_advisory_unlock($1::int, hashtext($2::text)::int)`,
          [REVIEWER_LOCK_CLASS, task.task_id],
        );
      } catch (err) {
        console.warn(`[rv] advisory_unlock failed: ${String(err)}`);
      }
    }
    await qr.release();
  }
}

async function reviewOneClaimed(
  ds: DataSource,
  task: TaskForReview,
): Promise<void> {
  console.log(
    `[rv] ${task.display_id} reviewing branch=${task.branch_name} ${task.base_sha.slice(0, 7)}..${task.head_sha.slice(0, 7)}`,
  );

  // Step 1: fetch the diff via GitHub Compare API.
  const diffResult = await fetchDiff(
    task.github_owner,
    task.github_repo,
    task.base_sha,
    task.head_sha,
  );
  if (diffResult.kind === 'transient') {
    console.warn(
      `[rv] ${task.display_id} diff fetch transient failure — leaving in review for retry`,
    );
    return;
  }
  if (diffResult.kind === 'permanent') {
    console.error(
      `[rv] ${task.display_id} diff fetch permanent failure (${diffResult.reason}) — failing task`,
    );
    await failReviewTask(ds, task, `diff fetch failed: ${diffResult.reason}`);
    return;
  }
  const diff = diffResult.body;
  const diffTrimmed =
    diff.length > MAX_DIFF_BYTES
      ? diff.slice(0, MAX_DIFF_BYTES) + `\n\n…(truncated, original ${diff.length} bytes)`
      : diff;

  // Step 2: ask the reviewer agent AND (for high-risk modules)
  // the auditor agent in parallel. callAgent handles the
  // provider routing + webengine semaphore + throttle.
  let verdict: ReviewVerdict;
  let modelUsed: string;
  let notesMd = '';
  let auditStatus: string | null = null;
  let auditNotesMd: string | null = null;
  try {
    const out = await askModel(ds, task, diffTrimmed);
    verdict = out.verdict;
    modelUsed = out.model;
    notesMd = out.notesMd;
    auditStatus = out.auditStatus;
    auditNotesMd = out.auditNotesMd;
  } catch (err) {
    console.error(`[rv] ${task.display_id} model call failed:`, err);
    return;
  }

  // Score gate: an approved verdict with a score below the
  // minimum is downgraded to changes_requested. The model
  // contradicted itself — prefer the conservative outcome
  // over letting a "looks unsafe, score 12, but approved!"
  // response slip through to deployment.
  if (verdict.decision === 'approved' && verdict.score < MIN_APPROVAL_SCORE) {
    console.warn(
      `[rv] ${task.display_id} downgrading approved→changes_requested (score=${verdict.score} < ${MIN_APPROVAL_SCORE})`,
    );
    verdict = {
      decision: 'changes_requested',
      score: verdict.score,
      summary: `downgraded from approved due to low score (${verdict.score}): ${verdict.summary}`,
    };
  }
  console.log(
    `[rv] ${task.display_id} verdict ${verdict.decision} score=${verdict.score}`,
  );

  // Steps 3 + 4 atomic: lease-fenced stamp + status transition
  // in one DB transaction. Without this, a process crash after
  // record_review_result but before fence_and_transition would
  // leave the task in 'review' with review_decision set, which
  // the poll query explicitly excludes — wedging the task
  // forever. Wrapping in ds.transaction() means PG rolls back
  // both on a crash and the next reviewer pass retries cleanly.
  const targetStatus =
    verdict.decision === 'approved' ? 'approved' : 'changes_requested';
  try {
    await ds.transaction(async (m) => {
      const stamped = (await m.query(
        `
        SELECT public.record_review_result(
          $1, $2::bigint, $3::public.review_decision_enum, $4, $5, $6::jsonb
        ) AS ok
        `,
        [
          task.task_id,
          task.lease_version,
          verdict.decision,
          modelUsed,
          verdict.score,
          JSON.stringify({ summary: verdict.summary }),
        ],
      )) as Array<{ ok: boolean }>;
      if (stamped[0]?.ok !== true) {
        // Lost the race or already decided — abort the txn so
        // the stamp does not land partially.
        throw new Error('record_review_result returned false');
      }

      await m.query(
        `
        SELECT public.fence_and_transition(
          $1, $2::bigint, 'review'::public.task_status_enum,
          $3::public.task_status_enum,
          $4::varchar(128), 'system'::public.actor_kind_enum,
          jsonb_build_object(
            'reviewer_id', $4::text,
            'model', $5::text,
            'score', $6::int,
            'review_notes_md', $7::text,
            'audit_status', $8::text,
            'audit_notes_md', $9::text
          ),
          $4::varchar(128)
        )
        `,
        [
          task.task_id,
          task.lease_version,
          targetStatus,
          REVIEWER_ID,
          modelUsed,
          verdict.score,
          notesMd,
          auditStatus,
          auditNotesMd,
        ],
      );
    });
  } catch (err) {
    if ((err as Error).message === 'record_review_result returned false') {
      console.warn(
        `[rv] ${task.display_id} review stamp lost race / already decided — skipping`,
      );
      return;
    }
    throw err;
  }
  console.log(`[rv] ${task.display_id} → ${targetStatus}`);
}

type DiffResult =
  | { kind: 'ok'; body: string }
  | { kind: 'transient'; reason: string }
  | { kind: 'permanent'; reason: string };

async function fetchDiff(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<DiffResult> {
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
    // Network-layer error: classify as transient.
    return { kind: 'transient', reason: `network: ${String(err)}` };
  }
  if (res.ok) {
    return { kind: 'ok', body: await res.text() };
  }
  const body = await res.text().catch(() => '');
  const snippet = body.slice(0, 200);
  console.error(
    `[rv] fetchDiff ${owner}/${repo} ${base}..${head} → HTTP ${res.status}: ${snippet}`,
  );
  // 5xx → upstream is sick, retry.
  // 429 → rate-limited, retry.
  // 403 → MIGHT be rate-limit / abuse detection (retry) or
  //        bad/expired token (permanent). GitHub uses 403
  //        liberally — inspect headers and body to decide.
  // 401 → bad/expired token, permanent.
  // 404 → repo or compare missing, permanent.
  // 422 → SHAs do not exist or unrelated, permanent.
  // Other 4xx → permanent.
  if (res.status >= 500 || res.status === 429) {
    return { kind: 'transient', reason: `HTTP ${res.status}` };
  }
  if (res.status === 403) {
    // Treat as transient if GitHub is signaling a rate limit or
    // abuse-detection throttle via headers or body wording.
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = res.headers.get('retry-after');
    const bodyLower = body.toLowerCase();
    const looksRateLimited =
      remaining === '0' ||
      retryAfter !== null ||
      bodyLower.includes('rate limit exceeded') ||
      bodyLower.includes('secondary rate limit') ||
      bodyLower.includes('abuse detection') ||
      bodyLower.includes('api rate limit');
    if (looksRateLimited) {
      return {
        kind: 'transient',
        reason: `HTTP 403 rate limit (remaining=${remaining ?? 'n/a'}, retry-after=${retryAfter ?? 'n/a'})`,
      };
    }
    // Real auth/permission failure — permanent.
    return { kind: 'permanent', reason: `HTTP 403: ${snippet}` };
  }
  return { kind: 'permanent', reason: `HTTP ${res.status}: ${snippet}` };
}

/**
 * Fail a task that cannot be reviewed because the diff is
 * permanently unfetchable. Transitions review → blocked with a
 * clear reason in the failure_reason payload, releasing the
 * module lock so other work can proceed.
 */
async function failReviewTask(
  ds: DataSource,
  task: TaskForReview,
  reason: string,
): Promise<void> {
  try {
    await ds.query(
      `
      SELECT public.fence_and_transition(
        $1, $2::bigint, 'review'::public.task_status_enum,
        'blocked'::public.task_status_enum,
        $3::varchar(128), 'system'::public.actor_kind_enum,
        jsonb_build_object('failure_reason', $4::text),
        NULL::varchar(128)
      )
      `,
      [task.task_id, task.lease_version, REVIEWER_ID, reason.slice(0, 1000)],
    );
  } catch (err) {
    console.error(`[rv] failReviewTask ${task.display_id} failed:`, err);
  }
}

/**
 * Build the instruction (ask.txt) that tells the reviewer model
 * exactly what to return. Kept as a constant so the content is
 * identical across every request and prompts stay deterministic.
 *
 * The ask.txt contract gives the model room to produce a detailed
 * review — structured issues[] + positives[] + risks[] plus a
 * multi-paragraph notes_md — instead of cramming the entire
 * verdict into a one-sentence summary like our first iteration
 * forced it to.
 */
const REVIEWER_ASK_TXT = `You are a code reviewer for the DevLoop AI bug-fix system.

Files attached to this request:
  - report.txt               — the bug report and task metadata
  - plan.txt                 — the planner's strategy (what the
                               worker was supposed to do). May be
                               empty if planning was skipped.
  - diff.txt                 — the git diff to review
  - <filename>.full.txt × N  — the FULL post-edit content of each
                               touched source file, so you can
                               reason about surrounding context

Read them. Compare the diff to the plan and the bug report. Then
return EXACTLY ONE JSON object and NO other text, markdown, or
code fences. Use this schema:

{
  "decision": "approved" | "changes_requested",
  "score": <integer 0..100>,
  "summary": "<one sentence, under 200 chars>",
  "plan_adherence": "full" | "partial" | "deviates" | "no_plan",
  "issues": [
    {
      "file": "<path from repo root>",
      "line": <integer or null>,
      "severity": "high" | "medium" | "low",
      "description": "<what is wrong>",
      "suggestion": "<concrete fix>"
    }
  ],
  "positives": ["<things the diff did well>"],
  "risks": ["<potential regressions or edge cases>"],
  "notes_md": "<multi-paragraph markdown analysis that a human can read>"
}

Decision rules:
  - "approved" if the diff plausibly fixes the bug described in
    report.txt, does not introduce obvious regressions, and follows
    reasonable conventions.
  - "approved" if the diff is a small marker/stub/docs edit
    (score around 60).
  - "changes_requested" if the diff is destructive, off-topic,
    removes large blocks of unrelated code, leaks secrets, or
    fails to address the reported problem.

Score guide:
  -   0..40  — obviously bad
  -  41..70  — stub, partial, or low-confidence fix
  -  71..100 — solid, ready to merge

Do not invent information that is not in the attached files. Every
issue you report must cite a file from <filename>.full.txt or a
line visible in diff.txt.`;

interface ChangedFile {
  path: string;
  status: string; // added / modified / removed / renamed
}

async function askModel(
  ds: DataSource,
  task: TaskForReview,
  diff: string,
): Promise<{
  verdict: ReviewVerdict;
  model: string;
  notesMd: string;
  auditStatus: string | null;
  auditNotesMd: string | null;
}> {
  // Fetch the list of changed files + their post-edit contents
  // from GitHub at head_sha. If this fails we still send the diff
  // alone — the reviewer gets reduced context but can still render
  // a verdict.
  const changedFiles = await fetchChangedFiles(
    task.github_owner,
    task.github_repo,
    task.base_sha,
    task.head_sha,
  );
  const fullFiles: Array<{ name: string; content: string }> = [];
  for (const f of changedFiles.slice(0, 10)) {
    if (f.status === 'removed') continue;
    const content = await fetchFileAtSha(
      task.github_owner,
      task.github_repo,
      f.path,
      task.head_sha,
    );
    if (content === null) continue;
    const capped =
      content.length > 200 * 1024
        ? content.slice(0, 200 * 1024) + '\n\n[... truncated by reviewer: original was ' + content.length + ' bytes]\n'
        : content;
    fullFiles.push({
      name: sanitizeAttachmentName(f.path) + '.full.txt',
      content: capped,
    });
  }

  const reportTxt = [
    `Task ID:     ${task.display_id}`,
    `Module:      ${task.module}`,
    `Risk tier:   ${task.risk_tier}`,
    `Branch:      ${task.branch_name}`,
    `Base SHA:    ${task.base_sha}`,
    `Head SHA:    ${task.head_sha}`,
    ``,
    `Title: ${task.report_title}`,
    ``,
    `Body:`,
    task.report_body,
  ].join('\n');

  const planTxt = task.plan && task.plan.length > 0 ? task.plan : '(no plan — planner skipped or disabled)';

  const baseFiles: Array<{ name: string; content: string }> = [
    { name: 'ask.txt', content: REVIEWER_ASK_TXT },
    { name: 'report.txt', content: reportTxt },
    { name: 'plan.txt', content: planTxt },
    { name: 'diff.txt', content: diff },
    ...fullFiles,
  ];

  // Short prompt. All heavy content is in the attached files —
  // webengine's Playwright paste misbehaves on long prompts.
  const reviewerPrompt = 'Read ask.txt. Review the diff against the plan and report. Return only the JSON object as specified in ask.txt.';

  // Fas H: auditor runs in PARALLEL with reviewer for high-risk
  // modules. Both calls go through callAgent's webengine semaphore
  // so we never exceed 5 concurrent upstream requests. If auditor
  // says "blocking" we override an approved reviewer verdict.
  const auditorEnabled = isHighRisk(task.module, task.risk_tier);

  const reviewerPromise = callAgent(ds, {
    role: 'reviewer',
    prompt: reviewerPrompt,
    files: baseFiles,
  });

  const auditorPromise: Promise<
    | { ok: true; text: string; model: string }
    | { ok: false; reason: string }
  > = auditorEnabled
    ? callAgent(ds, {
        role: 'auditor',
        prompt:
          'Read ask.txt. Security-audit the diff and the attached full files. Return only the JSON object as specified in ask.txt.',
        files: [
          { name: 'ask.txt', content: AUDITOR_ASK_TXT },
          { name: 'report.txt', content: reportTxt },
          { name: 'diff.txt', content: diff },
          ...fullFiles,
        ],
      })
        .then(
          (r) => ({ ok: true as const, text: r.text, model: r.model }),
        )
        .catch((err: Error) => ({ ok: false as const, reason: err.message }))
    : Promise.resolve({ ok: false as const, reason: 'not high-risk' });

  const [reviewerResult, auditorResult] = await Promise.all([
    reviewerPromise,
    auditorPromise,
  ]);

  // Parse the reviewer verdict first — that's the core gate.
  const stripped = stripJsonFence(reviewerResult.text);
  let parsed: {
    decision?: unknown;
    score?: unknown;
    summary?: unknown;
    issues?: unknown;
    positives?: unknown;
    risks?: unknown;
    notes_md?: unknown;
    plan_adherence?: unknown;
  };
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `failed to parse reviewer JSON: ${String(err)}; first 200 bytes: ${stripped.slice(0, 200)}`,
    );
  }
  let rawDecision = parsed.decision;
  if (rawDecision === 'needs_changes' || rawDecision === 'requested_changes') {
    rawDecision = 'changes_requested';
  }
  if (rawDecision !== 'approved' && rawDecision !== 'changes_requested') {
    throw new Error(`bad decision: ${String(rawDecision)}`);
  }
  let decision: 'approved' | 'changes_requested' = rawDecision;
  const score = parsed.score;
  const summary = parsed.summary;
  const notesMd =
    typeof parsed.notes_md === 'string' ? parsed.notes_md : '';
  if (
    typeof score !== 'number' ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 100
  ) {
    throw new Error(`bad score: ${String(score)} (must be integer 0..100)`);
  }
  if (typeof summary !== 'string') {
    throw new Error('bad summary');
  }

  // Process auditor (best-effort). If it succeeded and returns
  // security_status=blocking, we override reviewer approval.
  let auditStatus: string | null = null;
  let auditNotesMd: string | null = null;
  if (auditorResult.ok) {
    try {
      const auditJson = JSON.parse(stripJsonFence(auditorResult.text)) as {
        security_status?: string;
        notes_md?: string;
      };
      if (typeof auditJson.security_status === 'string') {
        auditStatus = auditJson.security_status;
      }
      if (typeof auditJson.notes_md === 'string') {
        auditNotesMd = auditJson.notes_md;
      }
      if (
        auditStatus === 'blocking' &&
        decision === 'approved'
      ) {
        console.warn(
          `[rv] ${task.display_id} auditor OVERRIDE: reviewer said approved but auditor status=blocking — downgrading`,
        );
        decision = 'changes_requested';
      }
    } catch (err) {
      console.warn(
        `[rv] ${task.display_id} auditor JSON parse failed: ${String(err)}`,
      );
    }
  } else if (auditorEnabled) {
    console.warn(
      `[rv] ${task.display_id} auditor call failed: ${auditorResult.reason}`,
    );
  }

  return {
    verdict: { decision, score, summary: summary.slice(0, 500) },
    model: reviewerResult.model,
    notesMd,
    auditStatus,
    auditNotesMd,
  };
}

const AUDITOR_ASK_TXT = `You are a security auditor for the DevLoop AI bug-fix system.

Files attached:
  - report.txt               — bug report and task metadata
  - diff.txt                 — the git diff
  - <filename>.full.txt × N  — full post-edit content of each
                               touched file

Scan for:
  - Hardcoded secrets / API keys / passwords / JWT secrets
  - SQL injection (string-built queries, unescaped concatenation)
  - Auth bypass (missing guards, permission checks)
  - Path traversal (../ in file operations)
  - Unsafe deserialization
  - Command injection in spawn/exec calls
  - Logging of sensitive data (tokens, secrets, full request bodies)

Return EXACTLY ONE JSON object, no extra text or markdown, with
this schema:

{
  "security_status": "clean" | "warnings" | "blocking",
  "overall_risk": "low" | "medium" | "high" | "critical",
  "findings": [
    {
      "category": "secret_leak" | "injection" | "auth_bypass" | "path_traversal" | "unsafe_deserialization" | "command_injection" | "logging_leak" | "other",
      "severity": "low" | "medium" | "high" | "critical",
      "file": "<path>",
      "line": <integer or null>,
      "description": "<what is wrong>",
      "recommendation": "<how to fix>"
    }
  ],
  "notes_md": "<multi-paragraph markdown analysis>"
}

Use "blocking" only for critical or high-severity findings that
are clearly exploitable as written. Use "warnings" for medium
findings you want the reviewer to be aware of but that are not
an immediate block. Use "clean" if nothing suspicious stands out.

Do not invent findings. Every finding must cite a specific file
and (when possible) line number from the attached files.`;

function isHighRisk(module: string, riskTier: string): boolean {
  if (riskTier === 'high' || riskTier === 'critical') return true;
  const highRiskModules = new Set([
    'auth',
    'backend/db',
    'backend/telephony',
    'devops',
  ]);
  return highRiskModules.has(module);
}

/**
 * GitHub Compare API returns a JSON body (when accept=application/
 * vnd.github+json) with a `files` array. We re-request with the
 * JSON media type to get the file list; the text diff has already
 * been fetched separately by fetchDiff.
 */
async function fetchChangedFiles(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<ChangedFile[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${base}...${head}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'devloop-reviewer/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN !== null) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }
  try {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      console.warn(`[rv] fetchChangedFiles HTTP ${res.status} — proceeding with diff only`);
      return [];
    }
    const body = (await res.json()) as {
      files?: Array<{ filename?: unknown; status?: unknown }>;
    };
    if (!Array.isArray(body.files)) return [];
    return body.files.flatMap((f) => {
      if (typeof f.filename !== 'string') return [];
      const status = typeof f.status === 'string' ? f.status : 'modified';
      return [{ path: f.filename, status }];
    });
  } catch (err) {
    console.warn(`[rv] fetchChangedFiles error: ${String(err)}`);
    return [];
  }
}

async function fetchFileAtSha(
  owner: string,
  repo: string,
  path: string,
  sha: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3.raw',
    'User-Agent': 'devloop-reviewer/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN !== null) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }
  try {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Turn a file path into a single attachment name safe for
 * multipart (no slashes, no leading dot).
 */
function sanitizeAttachmentName(p: string): string {
  return p.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
}

function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence && fence[1]) return fence[1].trim();
  return trimmed;
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
