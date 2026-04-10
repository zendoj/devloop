# Architecture review — round 7

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=41561 completion=19743, reasoning=16384

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Lock ownership is undefined in `assigned` and `approved`** — §6.2, §6.2.1, §6.3, §19 D4  
   **Severity:** critical  
   **Problem statement:** §19 D4 says the module lock is held from `assigned` through deploy/verify, but §6.3 only assigns heartbeat/lock-renew ownership for `in_progress`, `review`, `deploying`, `merged`, `verifying`, and `rolling_back`. `assigned` and `approved` have no owner renewing `module_locks.expires_at`, yet they still hold the lock. Under normal delays (worker-manager outage, deploy queue delay, project waiting behind another deploy), the lock expires after 15 minutes while the task remains `assigned`/`approved`, allowing another task to acquire the same module lock. The stale-task policy also does not define what janitor does for `assigned` or `approved`, even though the stale query includes them.  
   **Recommended fix:** Either:
   - assign explicit heartbeat/renew owners for `assigned` and `approved` (and define janitor behavior for both), or
   - stop holding the module lock in those states and update §6.2/§19 D4/workflows accordingly.  
   As written, the lock invariant is not maintainable.

2. **Deployer cannot access the local git state it is required to push** — §7.5 step 4, §11  
   **Severity:** critical  
   **Problem statement:** The deployer is the only component with GitHub write credentials, and §7.5 step 4 requires it to read the locally committed agent branch from `/var/devloop/projects/<slug>/main/` and push it. But §11 does not put `devloop-dep` in `devloop-fs`, and the mirror/worktree paths are `0770` to `devloop-fs` owners only. So the deployer, as documented, cannot read or update the bare mirror needed for the push/checkpoint flow.  
   **Recommended fix:** Choose one concrete model and document it consistently:
   - grant `devloop-dep` the minimum filesystem access needed to the bare mirror/worktree refs, or
   - move the push into a narrowly-scoped helper/IPC operation that the deployer invokes without broad FS access.  
   A required component currently lacks the permissions to perform its core function.

3. **Deploy workflow still uses undeclared transitions and has a merge-recovery hole** — §6.2.1, §6.4, §7.5 steps 5–8  
   **Severity:** critical  
   **Problem statement:** §6.4 says all status changes go through a hardcoded transition table, but §7.5 uses transitions not present in §6.2.1, including `deploying → review` (stale SHA / merge blocked) and `deploying → failed` (branch protection failure, CI failure, PR closed without merge). In addition, §7.5 step 7 says if GitHub shows the PR is already merged, persist `merged_commit_sha` and proceed to step 8. If the prior attempt crashed after the GitHub merge but before `deploying → merged`, the task can have `status='deploying'` with `merged_commit_sha` set, and step 8 has no explicit repair transition back to `merged` before `merged → verifying`.  
   **Recommended fix:** Make the transition table complete and authoritative for every pair used by workflows, and add an explicit recovery rule: if `merged_commit_sha IS NOT NULL` while status is `deploying`, perform idempotent `deploying → merged` before writing desired state / entering `verifying`.

4. **Retry accounting is contradictory and not enforceable** — §4.2 (`agent_tasks.retry_count`), §7.5 step 1, §8, §19 D22  
   **Severity:** critical  
   **Problem statement:** The document gives mutually inconsistent retry semantics:
   - §4.2 says `retry_count` is incremented by janitor on requeue.
   - §7.5 step 1 says it increments only when `fence_and_transition()` enters a retryable state, not per job claim.
   - §8/D22 say crash recovery keeps the task in the same status and resumes from checkpoint, with failure only after retry exhaustion.  
   In the resume-with-same-status model, a deployer/reviewer can crash or hit API failures repeatedly without any guaranteed `retry_count` increment, so `max_retries` may never fire.  
   **Recommended fix:** Pick one precise retry model and encode it at the DB boundary. For example, maintain explicit per-stage attempt counters incremented exactly once on lease-reclaim/restart of that stage, or increment on job reclaim with an idempotent reclaim token. Then update §4.2, §7.5, §8, and §19 to match.

5. **Host apply timeout is too short and accepts late success incorrectly** — §3.4.2, §7.5 step 9, `record_deploy_applied()` in §4.2  
   **Severity:** critical  
   **Problem statement:** Central rolls back if no apply report arrives within 5 minutes (§7.5 step 9), but the documented host flow includes 15s polling delay, fresh clone/fetch, `npm ci` + builds for backend and frontend, restart, and then 60 seconds of continuous health success (§3.4.2). That can exceed 5 minutes under normal conditions. Worse, on timeout the design audits `host_apply_timeout` but does not mark the `desired_state_history` row as `timed_out`; `record_deploy_applied()` will still accept a late success because `applied_at` is still NULL. This can trigger rollback of a deployment that was merely slow.  
   **Recommended fix:** Make host-apply timeout project-configurable and based on an explicit host progress model (`started`/heartbeat/final status), or greatly increase the timeout to match the documented host build path. Also define the DB update on timeout (`applied_status='timed_out'`) and how late reports are handled.

6. **First rollback is undefined because no baseline desired state is seeded** — §7.5 step 10, §§13.3–13.5, §18.2  
   **Severity:** critical  
   **Problem statement:** Rollback selects the previous successful `desired_state_history` row (§7.5 step 10), but registration/install steps never seed an initial “current production SHA” row. On the first DevLoop-managed deploy for a project, a failed post-cutover deploy may have no previous successful desired state to roll back to. §18.2 implies corrective desired-state rows can exist, but onboarding does not create one.  
   **Recommended fix:** Add an explicit onboarding/baseline step: capture the currently deployed GitHub SHA from the host at registration/install, verify it, and write an initial signed `desired_state_history` row marked applied/success. If you do not want that, then define the exact no-baseline rollback behavior.

7. **RBAC is still internally inconsistent with the “authoritative” matrix** — §4.1, §19 D26, §19 D3, §19 D19  
   **Severity:** critical  
   **Problem statement:** §4.1 still contains stale privilege descriptions that contradict §19 D26, including direct role writes that §19 forbids and a reference to non-existent `desired_state_current`. Example: `devloop_dep` is described as writing `desired_state_current`, and `devloop_rev` as inserting audit/quota directly, while §19 D26 says sensitive mutations go only through stored procedures. Since §19 is declared authoritative, this is a blocking internal inconsistency in a security-critical boundary.  
   **Recommended fix:** Remove the stale privilege summary from §4.1 or rewrite it to reference §19 D26 only. There should be exactly one source of truth for runtime DB privileges.

8. **Deploy-stage uniqueness rule still contradicts its own authoritative table** — §4.2, §19 D6, §19 D5  
   **Severity:** critical  
   **Problem statement:** §4.2 correctly defines the unique index to include `rollback_failed`, but §19 D6 omits `rollback_failed` from the status set. Because §19 is declared authoritative, the document currently disagrees with itself about whether a `rollback_failed` task blocks new deploy admission. This directly affects the project-serialization safety invariant.  
   **Recommended fix:** Update §19 D6 to exactly match §4.2 and §19 D5: `rollback_failed` must be included in the deploy-stage uniqueness invariant.

9. **Filesystem ownership/cleanup rules still drift across sections** — §3.2, §7.3, §11  
   **Severity:** critical  
   **Problem statement:** §3.2 says worktrees/credentials are created with `devloop-worker:devloop-fs` and group-readable so `devloop-wm` can inspect and shred them after sandbox exit. But §11 still describes `/var/devloop/worktrees/<task_id>/workspace` and `cred/` as `devloop-worker:devloop-worker`, with `cred/` at `0700`. Under §11, `devloop-wm` cannot perform the cleanup that §7.3 requires.  
   **Recommended fix:** Normalize §11 to the actual intended spawn-time ownership/mode model from §3.2/§7.3, or change the cleanup strategy. Right now the documented permissions do not support the documented cleanup path.

10. **Threat-model/storage documentation is still wrong about where secrets live** — §4.3, §17.1  
   **Severity:** critical  
   **Problem statement:** §4.3 and the first half of §17.1 correctly say runtime secrets are file-backed via `LoadCredential`, with DB-resident secrets limited mainly to encrypted 2FA data / hashes / HMACs / public keys. But §17.1 “Assets” still says “Secrets stored in central DB (GitHub App key, OpenAI key, signing key, 2FA secrets).” That is false relative to the rest of the document. For this product, dishonest or contradictory threat-model documentation is a blocker.  
   **Recommended fix:** Correct §17.1 so asset inventory matches the actual storage model: runtime secrets are file-backed; DB contains only the explicitly listed derived/encrypted items.

## Important issues (should address)
1. **GitHub auth model should say “two Apps,” not “two installations,” if permissions differ** — §5.5, §19 D14  
   **Severity:** important  
   **Problem statement:** The document describes “two separate GitHub App installations” with different permission scopes. GitHub permission scopes are app-level, not installation-level. If you want one read-only identity and one write-capable identity, this should be two separate GitHub Apps (or App + PAT fallback), not merely two installations of one app.  
   **Recommended fix:** Rename and document this precisely as two separate GitHub Apps or explicitly choose App/PAT split.

2. **Credential-shred timing still conflicts with the authoritative table** — §7.3, §19 D23  
   **Severity:** important  
   **Problem statement:** §7.3 says the Anthropic credential file is shredded immediately after sandbox exit. §19 D23 says “Immediate credential file shred at terminal state.” Since §19 is declared authoritative, this can reintroduce the older, weaker behavior.  
   **Recommended fix:** Update §19 D23 to match §7.3 exactly: shred immediately after bwrap/Claude exits, independent of task terminal state.

3. **Several stale names/identifiers remain on critical paths** — §3.2, §6.3, §7.3, §4.2 (`project_configs` note)  
   **Severity:** important  
   **Problem statement:** The document still mixes `TaskStateService.heartbeat` / `heartbeat_task()` with `refresh_task()`, and `project_config_version` appears in prose after the schema was changed to `project_config_id`. These are not conceptual holes, but they are the kind of drift that causes implementation mistakes.  
   **Recommended fix:** Do one consistency sweep for procedure names and field names so every section uses the same identifiers.

4. **24-hour `issued_at` freshness may strand long-offline hosts** — §3.4.2  
   **Severity:** important  
   **Problem statement:** The deploy agent rejects desired state older than 24h. If a host is offline longer than that, it cannot apply the latest desired state when it returns, and the normal recovery path is not documented.  
   **Recommended fix:** Either make this window configurable and large enough for expected outages, or add a documented “re-issue current desired state with fresh `issued_at`” operator workflow.

## Suggestions (optional improvements)
- Generate §19 decision entries and transition/RBAC docs from one machine-readable source to prevent cross-section drift.
- Add an explicit host apply lifecycle (`pending` → `started`/heartbeat → `success|failed|timed_out`) rather than inferring everything from one final callback.
- Add a small onboarding command to seed the baseline desired state from the host’s current symlink SHA and central’s GitHub view.
- Consider making deploy/apply timeouts part of `project_configs` or host agent config surfaced into central, so timeouts match real project build durations.
- Add a resume test matrix for every deploy checkpoint boundary: after PR create, after merge API success, after `merged_commit_sha` persist, after desired-state write, after timeout, after rollback PR create.

## Strengths
- Honest single-operator trust model; the document does not pretend central compromise is harmless.
- Good process and identity separation for an MVP: separate OS users, separate PG roles, systemd credentials.
- Strong direction toward DB-enforced invariants rather than “best effort” application logic.
- Pull-based deploy plus host-side signature verification and path policy is a sensible defense-in-depth pattern for this scope.
- Deterministic branch naming and PR lookup/idempotency strategy are well thought through.
- Sandboxed Claude has no DB/API credentials and a meaningfully reduced egress surface.
- The audit trail design is materially stronger than typical MVPs.

## Open questions central must resolve
- Who owns heartbeat and lock renewal while a task is in `assigned` and `approved`?
- What exact mechanism gives the deployer access to the local branch it must push?
- What is the single authoritative retry-attempt model, and where is it incremented?
- How is the baseline “current production SHA” established for a new project before the first rollback is ever needed?
- What is the maximum expected host apply duration per project, and how does central distinguish “slow” from “dead”?
- Are the compliance and deploy GitHub identities two separate App registrations, or is one of them a PAT fallback?