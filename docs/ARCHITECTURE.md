# DevLoop — Centralized Multi-Project Architecture

**Version:** 10.0.0-draft
**Status:** Round 10 — 4 micro-fixes from round 9 review (SQL gate, timeout procedure, handoff dir, POST verb). Final.
**Last updated:** 2026-04-10
**Scope:** Single-operator MVP product

---

## 0. Change Log

### v9 (this revision — focused patch, 6 critical fixes only)

| # | Round 8 critical issue | v9 resolution |
|---|---|---|
| C1 | Agent-branch publication path contradictory (WM vs deployer as pusher) | **Deployer is the sole GitHub writer.** All WM-push references removed. Handoff model: WM commits to the local agent branch inside its own worktree; on task → `review`, WM produces a `git bundle` artifact at `/var/devloop/handoff/<task_id>.bundle` and chowns it `devloop-worker:devloop-fs`. On `approved → deploying`, deployer reads the bundle via the `devloop-fs` group (deployer is added to `devloop-fs` in §11), unbundles into its own per-task clone at `/var/devloop/deployer/<task_id>/`, and pushes to `origin devloop/task/<task_id>` from there. No WM GitHub credentials exist. |
| C2 | Host apply lifecycle not in schema | Added columns to `desired_state_history`: `apply_started_at timestamptz NULL`, `apply_last_heartbeat_at timestamptz NULL`. Added stored procedures `record_apply_started(desired_state_id)` and `record_apply_heartbeat(desired_state_id)` granted to `devloop_api`. `record_deploy_applied` gate updated: `WHERE id=$1 AND applied_status IS NULL` (instead of `applied_at IS NULL`) — when timeout sets `applied_status='timed_out'`, late success is atomically rejected. Added audit enum values: `host_heartbeat_timeout`, `deploy_host_apply_late_after_timeout`, `deploy_merge_blocked`. Canonicalized host→central HTTP contract to **POST** (removes PUT/POST drift). |
| C3 | `changes_requested → assigned` can't re-spawn (worker_id not cleared) | `fence_and_transition(..., 'assigned', ...)` explicitly clears `worker_id`, `worker_handle`, `started_at`, `heartbeat_at` in the same UPDATE. Applies to every re-entry to `assigned` (from `changes_requested`, from `blocked` via orchestrator, from `queued_for_lock` upon lock acquisition). Documented in the transition table. |
| C4 | RBAC missing procedures (`refresh_task` for orch, `claim_assigned_task`, `deploy_mutex_clear_if_stale`) | §19 D26 updated: (a) `devloop_orch` gets EXECUTE on `refresh_task` (needed for `assigned`-stage heartbeat renewal); (b) new `claim_assigned_task(task_id, worker_id, worker_handle)` stored procedure replaces direct WM UPDATE — called with fenced semantics, returns new lease on success or NULL on failure; granted to `devloop_wm`; (c) new `deploy_mutex_clear_if_stale(project_id)` stored procedure — called by orchestrator reconciler; granted to `devloop_orch`. All direct WM UPDATE to `agent_tasks.status` removed from §7.3. |
| C5 | Rollback desired_state_id tracking unclear | Added column `rollback_desired_state_id uuid REFERENCES desired_state_history(id) NULL` on `agent_tasks`. `applied_desired_state_id` remains the forward deploy pointer; `rollback_desired_state_id` is populated when deployer writes the rollback row in §7.5 step 10. Verification scanner uses `COALESCE(rollback_desired_state_id, applied_desired_state_id)` when a task is in `rolling_back`. Checkpoint summary updated. |
| C6 | SQL references `wont_fix` but it's not in task_status_enum | **`wont_fix` is a report status, NOT a task status.** Removed from `idx_agent_tasks_stale` predicate and all other task-level queries. Task-level terminal states are: `verified`, `rolled_back`, `rollback_failed`, `failed`, `cancelled`. When a report becomes `wont_fix`, its active task (if any) transitions to `cancelled`. |

### v8



Fixes real gaps identified in round 7 plus a final aggressive drift sweep.

| # | Round 7 issue | v8 resolution | Section |
|---|---|---|---|
| C1 | Lock ownership undefined in `assigned` and `approved` | §6.3 extended: orchestrator owns lock renewal for `assigned` (a task in `assigned` should transition to `in_progress` within 5 min anyway; if WM is down, janitor moves task to `failed` with reason `spawn_timeout`). Deployer owns lock renewal for `approved` (deployer claim happens immediately when job is enqueued; if deployer is backed up, janitor moves task to `blocked` with reason `deployer_backlog`). §19 D4 updated to list the owner per state explicitly. | §6.3, §19 D4 |
| C2 | Deployer cannot access local git state for push | Deployer runs its own worktree in `/var/devloop/deployer/<task_id>` (separate from the worker's worktree). Deployer's FS access is its OWN directory tree, cloned fresh from `origin` at start of stage, not via the WM's bare mirror. `devloop-dep` owns `/var/devloop/deployer/` at `0750`. No cross-process FS sharing needed between WM and deployer. | §3.1.5, §7.3, §7.5, §11 |
| C3 | Workflow uses undeclared transitions | §6.2 transition table extended: `deploying → review`, `deploying → failed`, `deploying → merged`, merge-recovery `deploying → merged` when `merged_commit_sha IS NOT NULL && status='deploying'` explicitly allowed as a repair path. All transitions used in §7.5 are now in the table. | §6.2, §6.2.1, §7.5 |
| C4 | Retry accounting contradictory | **Single rule:** `retry_count` is incremented inside `fence_and_transition()` exactly when a task re-enters a retryable state (`assigned`, `deploying`, etc.) from a transient failure path. The janitor does NOT touch `retry_count`. On reclaim from a stale lease, the stage component resumes without incrementing. `retry_count` is compared against `max_retries` inside `fence_and_transition()` before allowing the retryable transition; if exceeded, the function forces `failed` instead. Enforced at DB boundary. | §4.2, §7.5 step 1, §8, §19 D22 |
| C5 | Host apply timeout too short | Timeout made configurable per project: `projects.host_apply_timeout_seconds` (default 1200 = 20 min, up from 5 min). Plus explicit host apply lifecycle with `started`/`heartbeat` callbacks: the host deploy agent POSTs `{status: "started"}` when it begins work, then `{status: "heartbeat"}` every 60s, then a final `{status: "success|failed"}`. Central tracks `desired_state_history.apply_started_at` and only rolls back if no heartbeat received for 180s. Late success reports are rejected (the `record_deploy_applied` stored procedure checks `applied_at IS NULL`, which is still true if we never set `applied_status='timed_out'` on timeout — so v8 also updates the timeout path to set `applied_status='timed_out'` before rollback, making `record_deploy_applied` idempotent in the "late success after timeout" case). | §3.4.2, §4.2, §7.5 step 9 |
| C6 | No baseline desired state at project registration | Added to §13.3 registration flow: after compliance check, central prompts the admin to enter (or fetch from host) the currently-deployed SHA, then writes an initial signed `desired_state_history` row with `action='baseline'`, `applied_sha=<current>`, `applied_status='success'`, `applied_at=now()`. First rollback has a valid target. | §4.2 (add `baseline` to `desired_action_enum`), §13.3 |
| C7 | §4.1 stale privileges contradict §19 D26 | §4.1 completely rewritten: no privilege lists at all. Just says "See §19 D26 for the authoritative RBAC matrix." | §4.1 |
| C8 | §19 D6 missing `rollback_failed` | §19 D6 updated to include `rollback_failed` in the status set. Matches §4.2. | §19 D6 |
| C9 | §11 workspace ownership drift from §3.2 | §11 filesystem table rewritten. Worktree paths are `devloop-worker:devloop-fs` mode `0770`. Credential dir is `devloop-worker:devloop-fs` mode `0770` (group-read by devloop-fs so devloop-wm can shred). Matches §3.2 exactly. | §11 |
| C10 | §17.1 still has stale DB-secret line | Stale "Secrets stored in central DB (GitHub App key, OpenAI key, signing key, 2FA secrets)" line removed entirely. Clean asset inventory. | §17.1 |
| I1 | GitHub auth: "two installations" vs "two Apps" | §5.5/§19 D14 updated: "two separate GitHub Apps" — one with write-scoped permissions for deployer, one with read-only permissions for compliance. Two different App registrations, not two installations of one App. | §5.5, §19 D14 |
| I2 | §19 D23 credential shred timing drift | §19 D23 updated: "Anthropic credential file shredded immediately after bwrap/sandbox exits (not at task terminal state)." Matches §7.3. | §19 D23 |
| I3 | Stale identifiers (project_config_version, heartbeat_task name) | Final sweep done for `project_config_version` (→ `project_config_id`), `heartbeat_task` (→ `refresh_task`), and `desired_state_current` references. | §3, §4, §6 |
| I4 | 24h `issued_at` freshness could strand long-offline hosts | Window made configurable in deploy agent policy (`max_desired_state_age_hours`, default 168 = 1 week). Plus operator command `devloop reissue-current --project <slug>` to re-sign the current desired_state with a fresh `issued_at`. | §3.4.2 |

### v7



Key structural change: **RBAC is now a single table in §19 (D26)**. All service sections just reference it. Prevents drift.

| # | Round 6 issue | v7 resolution | Section |
|---|---|---|---|
| C1 | RBAC inconsistent across §3.1.* | Consolidated into §19 D26 authoritative RBAC matrix. All service sections reference it; no service section has its own privilege list. §6.4 "no mutations bypass transition function" is now the binding rule. | §3.1.*, §4.1, §19 D26 |
| C2 | `rollback_failed` allows new task into `deploying` | **Atomic admission**: mutex acquisition is moved INSIDE `fence_and_transition('approved' → 'deploying')`. The function takes the mutex in the same transaction as the status change, using the DB unique index as a safety net. `rollback_failed` is added to the deploy-stage uniqueness partial index so no new task can enter `deploying` while any `rollback_failed` task exists for the project. | §4.2, §7.5, §19 D6 |
| C3 | devloop-worker ownership blocks wm cleanup | Changed worktree ownership: `devloop-worker:devloop-fs` mode `0770`. devloop-wm is in devloop-fs group, so it can list, read, and shred-then-remove the worktree after Claude exits. Credential directory uses same group ACL. | §3.2, §7.3, §11 |
| C4 | Merge not crash-idempotent | Added explicit PR state check before merge: deployer queries GitHub for PR status. If already merged: extract `merge_commit_sha` from GitHub response and persist. Only call merge endpoint if PR is open. Same pattern applied to rollback merge. | §7.5 steps 7 and 10 |
| C5 | `retry_count_last_incremented_at` undefined | Removed the field reference. Retry accounting simplified: `retry_count` is incremented exactly once per `fence_and_transition()` call that enters a retry-able state (`in_progress` from `assigned`, `deploying` from `approved`, etc.), not per job claim. | §4.2, §7.5 |
| C6 | Trust boundaries §2.1/§2.2 stale | Rewrote §2.1/§2.2 to match actual v1 behavior: reviewer → OpenAI direct AF_INET; deployer → GitHub direct AF_INET; deployer → host-healthz HTTP GET (anonymous or bearer-auth, for deploy verification). Egress proxy is explicitly only for sandboxed Claude in v1. | §2.1, §2.2 |
| I1 | Branch name drift: `experiment2/agent/...` vs `devloop/task/...` | Canonicalized to `devloop/task/<task_id>` everywhere. §3.2 worktree creation, §7.2 orchestrator branch assignment, §7.5 deployer push all use the same name. | §3.2, §7.2, §7.5 |
| I2 | Secret storage path/mode drift in §4.3/§17.1 | §4.3 sweep: removed `/etc/devloop/deploy_signing_priv` (now `deploy_signing_priv_<key_id>`); removed mode `0400` references (all `0440`). §17.1 no longer mentions secrets in DB. | §4.3, §17.1 |
| I3 | Credential shred timing ambiguous | Rule explicit: Anthropic credential file is `shred`ed **immediately after sandbox/bwrap exits** (not at task terminal state). Worktree itself is retained 24h. | §3.2, §7.3 |
| I4 | §8 retry semantics drift from §19/§7.5 | §8 rewritten: external API failures (OpenAI/GitHub/Anthropic) trigger retry loop within `retry_count` budget; only on budget exhaustion does task → `failed`. No stage auto-transitions to `blocked` on API failure. | §8 |
| I5 | Claude CLI + UNIX socket HTTP_PROXY mechanism unclear | Committed to concrete approach: a small bash shim script is placed inside the sandbox at `/usr/local/bin/claude-wrapped` that sets up a forwarder from TCP `127.0.0.1:9090` → UNIX `/run/egress.sock` using `socat -u` (or a builtin equivalent), then invokes the actual Claude CLI with `HTTPS_PROXY=http://127.0.0.1:9090`. This makes the proxy standard HTTP CONNECT over TCP from Claude's perspective. | §3.2 |

### v6



Fixes 8 critical + 8 important issues from round 5. v5 introduced new bugs during the consistency sweep (self-fencing heartbeat, missing deployer push step, netns-needs-privileges). v6 addresses those and adds **§19 Authoritative Decision Table** as the canonical cross-reference source for all "pick one" decisions.

| # | Round 5 issue | v6 resolution | Section |
|---|---|---|---|
| C1 | `heartbeat_task()` self-fences by bumping `lease_version` | Heartbeat split into two operations: `refresh_task(task_id, expected_lease)` updates only `heartbeat_at` (no lease bump); `fence_and_transition(task_id, expected_lease, new_status)` is the only lease-bumping call. Callers' in-memory lease is stable between transitions. Module lock renewal checks `ROW_COUNT = 1` and fails/fences on mismatch. | §6.3 |
| C2 | Deployer flow missing branch-push step | Added explicit Step 4.5 in §7.5: deployer pushes the approved local branch to GitHub (idempotent via deterministic remote ref name `devloop/task/<task_id>`) before running freshness checks. Persisted as `agent_tasks.remote_branch_pushed_at` checkpoint. | §7.5 |
| C3 | Stale mutex clearing lets a second task into `deploying` while old task exists | Added **DB-enforced invariant**: partial unique index on `agent_tasks(project_id) WHERE status IN ('deploying', 'merged', 'verifying', 'rolling_back')`. At most one non-terminal deploy-stage task per project. Enforced at the DB layer, not just via mutex. Combined with the mutex for in-process coordination. | §4.2, §7.5 |
| C4 | `rollback_failed` lock/mutex semantics contradicted in 4 places | **Canonical policy (per §19):** On `rollback_failed`, BOTH module lock AND deploy mutex are RETAINED. The task stays in rollback_failed until a human operator runs `devloop recovery clear-task <task_id>` which explicitly releases both. All 4 sections (§4.2, §6.2.1, §7.5, §8) updated to match. | §4.2, §6.2.1, §7.5, §8, §19 |
| C5 | `ip netns add` requires privileges WM doesn't have | Removed `ip netns add` entirely. Sandbox isolation via `bwrap --unshare-net` only. bwrap's user-namespace-based netns creation works without root. | §3.2 |
| C6 | RBAC still inconsistent; direct INSERT on audit_events in some sections | Final RBAC sweep done. ALL service sections now say EXECUTE on `append_audit_event()` only. `desired_state_current` references fully purged. Authoritative privilege matrix added in §19. | §3.1.*, §4.1, §4.2, §19 |
| C7 | Branch-name canonicalization drift (`refs/heads/experiment2` vs `experiment2`) | **Canonical:** plain branch names (`experiment2`, `main`), never `refs/heads/`. All of §3.4.2 policy, §4.2 schema, §7.5 flow normalized. | §3.4.2, §4.2, §7.5, §19 |
| C8 | PR creation idempotency gap (API call succeeds, DB write fails → duplicate on retry) | **Deterministic branch name and PR discovery:** agent branches use `devloop/task/<task_id>` which embeds the task id. On deployer retry, before creating a PR, deployer queries GitHub for open PRs with `head=devloop/task/<task_id>` and reuses existing. Same pattern for revert PRs: `devloop/revert/<task_id>`. Documented in §7.5. | §7.5 |
| I1 | `runtime/backend` vs per-component split in §13.2 | §13.2 rewritten to build per-component: `runtime/api`, `runtime/orchestrator`, `runtime/reviewer`, `runtime/deployer`, `runtime/worker-manager`, `runtime/frontend`, `runtime/egress-proxy`. Migration entrypoint: `runtime/api/dist/migrations/run.js` owned by api package since api is where the schema definitions live. | §13.2 |
| I2 | §18.2 step 9 references removed `/version` endpoint | Replaced with: (a) read deploy agent's `state.json` for last applied SHA, (b) read `current` symlink target on host, (c) compare with latest `desired_state_history` row | §18.2 |
| I3 | §17.1 asset inventory still says secrets in DB | Split into "file-backed runtime secrets" vs "DB-resident encrypted data". GitHub keys, OpenAI key, Anthropic key, signing private key, JWT secret all file-backed. `users.two_factor_secret`, `users.password_hash`, token HMACs, `signing_keys.public_key` are in DB. | §17.1 |
| I4 | Egress proxy not actually enforced for reviewer/deployer | **Honest doc change:** Egress proxy is enforced **only for the sandboxed Claude** in v1. Reviewer and deployer have direct outbound AF_INET. §2.1, §2.2, §3.1.7, §11, §17 updated to reflect this limitation. v1 roadmap includes forcing reviewer/deployer through the proxy as a hardening item. | §2.1, §2.2, §3.1.7, §11, §17 |
| I5 | Signing key file path inconsistent (`deploy_signing_priv` vs `deploy_signing_priv_<key_id>`) | **Canonical:** `/etc/devloop/deploy_signing_priv_<key_id>` (with key_id suffix). Active key_id recorded at `/etc/devloop/deploy_signing_active_key_id`. Propagated everywhere. | §4.3, §5.4, §11, §19 |
| I6 | Worktree retention/cleanup contradictory | Split: **immediate** cleanup of per-task credential file (shred), **delayed** cleanup of worktree (24h later via cron), **git worktree prune** run weekly to clean up bare mirror metadata. | §7.3 |
| I7 | Deploy agent health_check input unspecified | Added `health_check_url` field to deploy-agent config.yml. Example and schema updated. | §3.4.2 |
| I8 | `project_config_id` vs `project_config_version` drift | Canonicalized to `project_config_id` everywhere. `version_seq` remains as a convenience for humans to order configs but is not a foreign key target. | §4.2 |

### v5



**Round 5 is a consistency sweep.** Round 4 review identified that v4 had introduced cross-section inconsistencies — sections that were edited in isolation but not propagated to other sections that referenced them. This revision resolves those inconsistencies.

| # | Round 4 issue | v5 resolution | Section |
|---|---|---|---|
| C1 | Sandbox uses `devloop-worker` but §11 didn't match | §11 completely rewritten: `devloop-worker` is in `devloop-egress-clients`, has read/write ACLs on worktrees, traversal on `/var/devloop/`, `/var/devloop/projects` and `/var/devloop/worktrees` use POSIX ACLs so both `devloop-wm` and `devloop-worker` have the required access | §11 |
| C2 | Module lock held through review/deploy but no renew path | **Unified task heartbeat model:** whichever component currently owns the task (worker manager / reviewer / deployer) is responsible for renewing `agent_tasks.heartbeat_at` AND `module_locks.expires_at` in the same transaction via `TaskStateService.heartbeat(task_id, lease_version, stage)` stored procedure. Heartbeat interval is 60s during long-running stages (in_progress, CI wait, host apply wait). Short stages (review API call) complete within the lock's 30-minute lease and don't need renewal. Janitor scans non-terminal tasks with stale `heartbeat_at`. | §6.2, §6.3, §7.4, §7.5 |
| C3 | `deploy_mutex` "conceptually held" is not real enforcement | Deploy mutex semantics changed: `expires_at` only advances via explicit heartbeat from the holding deployer worker. Holder is released exclusively by explicit terminal transitions (`verified`, `rolled_back`, `rollback_failed`, `failed`, `cancelled`). If deployer crashes AND heartbeat lapses past the max-idle threshold (5 minutes), janitor increments `lease_version` which fences the stale deployer and releases the mutex. Acquisition checks both `holder_task_id IS NULL` OR `expires_at + grace < now()`. | §4.2, §7.5, §8 |
| C4 | Desired-state signing canonicalization undefined | **Canonical format committed: RFC 8785 JSON Canonicalization Scheme (JCS).** The signed bytes are the exact output of JCS applied to a JSON object with a fixed field list, in a fixed order. The `desired_state_history` table stores `signed_bytes bytea` (the exact bytes that were signed) + `signature bytea`. `signed_payload jsonb` is removed. Host verifies by signing the received `signed_bytes` verbatim against the trusted Ed25519 public key; no re-canonicalization needed on the host. | §4.2, §3.4.2 |
| C5 | Cross-section contradictions: §3.1.5 desired_state_current, §8 vs §7.5, missing audit enum values | §3.1.5 updated: no `desired_state_current` reference; deployer has EXECUTE on stored procedures only. §8 failure table rewritten to match §7.5 canonical recovery rule exactly (no crash → `failed`, only retry exhaustion → `failed`). §18.2 step 9 updated. Audit enum list extended with all event types used in procedures: `deploy_host_apply_duplicate_or_missing`, `host_apply_timeout`, `deploy_mutex_renewed`, etc. | §3.1.5, §8, §18.2, §4.2 |
| C6 | Migration auth incompatible with peer auth | §13.2 rewritten: dedicated OS user `devloop-admin` (no login shell, used only by root via `sudo -u devloop-admin` during install/migration) is peer-mapped to `devloop_owner` Postgres role via `pg_ident.conf`. Runtime users are never granted the owner role. Install bootstraps via this user. | §13.2 |
| I1 | Spawn path lacks atomic worker claim | Added explicit atomic claim step in §3.1.6 and §7.3: on IPC receipt, worker manager immediately runs `UPDATE agent_tasks SET status='in_progress', worker_id=..., worker_handle=..., started_at=now(), lease_version=lease_version+1 WHERE id=$1 AND status='assigned' AND worker_id IS NULL RETURNING lease_version`. If 0 rows, abort (duplicate spawn). | §3.1.6, §7.3 |
| I2 | Host config field name inconsistency | Normalized: `allowed_deploy_branches` is the canonical name; all sample configs and flow text updated | §3.4.2 |
| I3 | Signing key rotation sequence violates unique index | Rotation sequence updated: retire the old key first (`status='active' → 'retired'`), THEN insert the new key with `status='active'`, in one transaction. Matches the partial unique index constraint. | §5.4 |
| I4 | Service sections still say direct INSERT on audit_events | All five service role sections updated: `devloop_api`, `devloop_orch`, `devloop_rev`, `devloop_dep`, `devloop_wm` have EXECUTE on `append_audit_event()` instead of INSERT on `audit_events`. | §3.1.2-§3.1.6, §4.1 |
| I5 | Secret file permissions 0400 + group read contradictory | Normalized: secret source files are mode `0440` with specific group membership, systemd `LoadCredential` reads them (systemd has enough privilege). `0400` is retained only for files that no service user should read directly (e.g., the `devloop_owner` migration-time credentials). | §4.3, §11 |
| I6 | §17.1 asset inventory mismatched storage | §17.1 updated: GitHub App key, OpenAI key, Anthropic key, deploy signing private key are all **file-backed** per §4.3, not in DB. `signing_keys` table holds public keys only. `users.two_factor_secret` is the only encrypted DB secret. | §17.1 |

### v4



Addresses all 8 critical and 7 important issues from round 3 review.

| # | Round 3 issue | v4 resolution | Section |
|---|---|---|---|
| C1 | Public API has no desired-state or GitHub access but must serve deploy-agent endpoints and compliance checks | §3.1.2 updated: Public API holds a separate `GITHUB_APP_COMPLIANCE_KEY` (metadata-read only) and its DB role has SELECT on `desired_state_history` latest-per-project plus EXECUTE on `record_deploy_applied()` stored procedure | §3.1.2, §4.1, §4.2 |
| C2 | Worker dispatch inconsistent (IPC vs `worker` DB queue) | **Committed to Option A**: no `worker` DB queue. Orchestrator commits the task transaction, then sends IPC to worker manager over UNIX socket. A safety-net reconciler scans `assigned` tasks with no `worker_id` after 30s and re-sends IPC. | §3.1.6, §7.2 |
| C3 | Sandbox uid/perm broken, ANTHROPIC_API_KEY contradicts "no env vars" | bwrap now uses the dedicated `devloop-worker` uid; worktree ownership and egress socket group match; Anthropic credential delivered as a bind-mounted read-only file (not env var), and Claude reads via `ANTHROPIC_API_KEY_FILE` | §3.2, §11 |
| C4 | `desired_state_current` described three ways | **Removed entirely.** Latest desired state is served by an indexed query on `desired_state_history`. No materialized view, no trigger-maintained table. | §4.2, §7.5 |
| C5 | `agent_tasks.project_config_version` FK invalid | Changed to `project_config_id uuid REFERENCES project_configs(id)` | §4.2 |
| C6 | `queued_for_lock` stalls on missed NOTIFY | Added explicit reconciler loop: orchestrator scans `queued_for_lock` tasks every 30s regardless of notifications | §7.2 |
| C7 | Deployer crash recovery contradicts itself | **Canonical rule:** crash → job lease expires → job requeued → deployer resumes from DB checkpoint. Task is moved to `failed` only after `max_retries` exhausted OR an explicit unrecoverable inconsistency is detected. §8 updated to match. | §7.5, §8 |
| C8 | Host apply acks not tied to specific desired_state_id | Signed desired-state payload includes `desired_state_id`; host echoes it back; `record_deploy_applied()` stored procedure updates exactly one row by id with `WHERE applied_at IS NULL` for idempotency | §3.4.2, §4.2, §7.5 |
| I1 | Project config read-race in orchestrator | Orchestrator transaction runs at `REPEATABLE READ`; config row locked `FOR UPDATE` at start | §7.2 |
| I2 | Host branch-policy semantics unclear post-merge | Clarified: `allowed_deploy_branches` refers to the **target branch of the merged commit** (i.e., the default branch the commit now sits on). Source-branch provenance is guaranteed by central's signature on the desired-state payload. | §3.4.2 |
| I3 | Host symlink swap not atomic; step 8 vs 11 contradicted | Replaced with `mv -T` atomic rename + explicit pre-cutover vs post-cutover failure handling | §3.4.2 |
| I4 | "Exactly one active signing key" not enforced | Added partial unique index: `CREATE UNIQUE INDEX idx_signing_keys_one_active ON signing_keys((TRUE)) WHERE status = 'active'` | §4.2 |
| I5 | Secret storage inconsistent across sections | **Canonical model:** file-backed via systemd `LoadCredential` for ALL runtime secrets. `signing_keys` table stores public keys only. Removed contradictory "encrypted in DB with rotation" references. | §4.3, §5.4, §5.5 |
| I6 | Branch-protection check freshness (6h is not current) | Live GitHub check before deploy (short-circuited if cached < 5 min old); fail-closed if stale | §7.5 |
| I7 | Audit append-only enforcement not fully specified at DB boundary | Added explicit trigger SQL and stored procedure for chain extension | §4.2 |

### v3



Addresses all issues from round 2 review by `gpt-5.4` reasoning=high.

| # | Round 2 issue | v3 resolution | Section |
|---|---|---|---|
| C1 | Shared OS identity, all secrets to all units | Split into 5 separate OS users + 5 separate Postgres roles with column-level grants; each systemd unit loads only the secrets it needs | §3, §4.1, §11 |
| C2 | "Blast radius reduced" goal not actually achieved | Goal rewritten honestly; added §17 threat model with explicit accepted-risk documentation; central is documented as the trust root | §1, §17 |
| C3 | Deploys not serialized per project; last-writer-wins | Added `deploy_mutex` (project-scoped) + versioned `desired_state_history` append-only with monotonic `seq_no`; `desired_state` is a materialized current pointer | §4.2, §7.5 |
| C4 | `blocked → assigned` violated lock invariant | State machine updated: `blocked → queued_for_lock`, then orchestrator reacquires lock before `assigned` | §6.2 |
| C5 | `review` heartbeat inconsistent | Removed `review` from worker heartbeat index; reviewer/deployer stage liveness uses `jobs.lease_until` instead | §4.2, §6.3 |
| C6 | Deploy timeout path contradictory | Single canonical path documented: verify-or-rollback; `§7.5` and `§8` synced | §7.5, §8 |
| C7 | Branch protection not enforced at onboarding | Added project registration hook that calls GitHub API to verify branch protection; periodic compliance re-check; registration fails if not protected | §13.3, §3.1 (new `compliance` module) |
| C8 | Host-side GitHub fetch credentials missing | Deploy agent gets a dedicated read-only GitHub deploy key (or installation token) stored in file at `/etc/devloop-deploy-agent/github-key`, mode 0400, rotated independently | §3.4.2, §13.5 |
| C9 | Claude execution model undecided | Committed: **Claude CLI runs inside `bwrap` sandbox**; sandbox has no general network; a dedicated `devloop-egress-proxy` service (tinyproxy-like allowlist CONNECT proxy) is bind-mounted into the sandbox via UNIX socket, allowing only `api.anthropic.com:443` via SNI matching | §3.2 |
| C10 | Deploy signing key inconsistent (per-project vs global) | Decided: **one global signing key with `key_id` versioning and documented rotation protocol**. Per-project pubkey column removed; deploy agent policy file references trusted `key_id`s | §4.2, §5.3, §11 |
| I1 | `quota_usage` schema contradiction | Fixed: single composite PK `(period_key, quota_scope, metric)`; split into `quota_usage_global` and `quota_usage_project` to avoid nullable PK column | §4.2 |
| I2 | Audit hash chain not concurrency-safe | Added single-row `audit_chain_head` table; `pg_advisory_xact_lock(7331)` taken before each insert; chain extension is serialized | §4.2 |
| I3 | Lock acquire + task insert not atomic | Explicit SQL function `orchestrate_task(report_id, agent_name, module, risk_tier)` runs in single transaction: lock upsert, task insert, job enqueue, audit insert. Fenced. | §7.2 |
| I4 | Project/agent config not in schema | Added `project_configs` table with `version_seq`, `is_active`, signed content; `agent_roles` stored as immutable versioned rows | §4.2, §7.2.1 |
| I5 | `/version` endpoint auth incomplete | **Removed from design**; deploy verification now uses GitHub API to verify merged commit + host's own applied_sha reporting | §3.4.1, §7.5 |
| I6 | Worker logs can leak secrets | Worker manager pipes Claude stdout/stderr through a redaction filter before writing to disk; size-capped; separate "raw" log for debugging on local disk only | §3.2, §9 |
| I7 | Host deploy checkout not atomic | Deploy agent uses release-directory pattern: `releases/<sha>/` fresh clone, atomic symlink swap of `current`, previous N kept for rollback | §3.4.2 |
| I8 | Workers share loopback netns | Each task gets own netns (`--unshare-net`); egress proxy reached via UNIX socket bind-mount, not TCP loopback | §3.2 |
| I9 | Reporter `DEVLOOP_HOST_TOKEN` env var vs deploy-agent file-based | Harmonized: both read from `/etc/devloop-host/host_token` (mode 0400, owned by host app user) at startup, not env vars | §3.4.1, §13.4 |
| I10 | Backup/restore too high-level | Added §18 Backup matrix with explicit items, RPO/RTO, restore procedure, drill cadence | §18 |
| I11 | HTTPS not enforced in schema | Added CHECK constraint on `host_base_url` + runtime TLS validation + rejection of private/internal address targets | §4.2 |
| I12 | `desired_state` current-state-only | Replaced with append-only `desired_state_history` + materialized `desired_state_current` view | §4.2 |

### v2 (previous)
Major pivot to pull-based deploy, separated worker manager process, fenced state transitions, hash-chained audit, atomic quota reservations. Addressed 11 critical + 12 important from round 1.

### v1
Initial draft.

---

## 1. Vision and Scope

DevLoop is a **standalone product** for AI-assisted bug fixing across multiple host projects. A single central control plane (`devloop.airpipe.ai`) manages all host projects from one dashboard. Host projects install a thin adapter and a separate deploy agent. All AI orchestration, code review, and decision-making happens in central.

**This is a single-operator MVP.** Jonas is the sole human. There is no multi-party governance, no security team, no HSM, and no intent to introduce these in v1. The architecture is honest about the consequences of this scale (see §17).

### Goals

1. Single pane of glass for all host projects
2. Host projects stay minimal (adapter + deploy agent)
3. Centralized updates
4. Reusable across projects
5. Production-grade **correctness** and **safety** within the single-operator trust model
6. **Explicitly limited blast radius at the deploy-transport level** (host pulls, central never pushes shell commands to host)
7. Health monitoring of all connected hosts

### Non-goals (v1)

- Multi-tenant SaaS
- Multi-party review governance
- HSM / hardware key isolation
- Independent signer organization
- Real-time collaborative editing
- IDE integrations
- Non-bug-fix agents (refactors, ideation)

---

## 2. System Topology

### 2.1 Process and identity layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           devloop.airpipe.ai                             │
│                      (Nginx + Let's Encrypt, 443)                        │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                    proxy pass by path
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
            ▼                    ▼                    ▼
    ┌─────────────────┐  ┌─────────────────┐   ┌─────────────────┐
    │  Frontend       │  │  Public API     │   │  Internal only: │
    │  Next.js 16     │  │  NestJS         │   │  no direct HTTP │
    │  :3101 loopback │  │  :3100 loopback │   │                 │
    │                 │  │                 │   │                 │
    │  User:          │  │  User:          │   │                 │
    │  devloop-front  │  │  devloop-api    │   │                 │
    │                 │  │                 │   │                 │
    │  No DB access   │  │  DB role:       │   │                 │
    │  No secrets     │  │  devloop_api    │   │                 │
    └─────────────────┘  └────────┬────────┘   └─────────────────┘
                                  │
                                  │ jobs queue writes
                                  │ report inserts
                                  │ session/auth
                                  ▼
                           ┌─────────────────┐
                           │   Postgres      │
                           │   devloop DB    │
                           └─────┬───────────┘
                                 │
                                 │ LISTEN/NOTIFY + jobs polling
                                 │
            ┌────────────────────┼────────────────────────┐
            ▼                    ▼                        ▼
    ┌───────────────┐  ┌───────────────┐       ┌───────────────┐
    │ Orchestrator  │  │ Reviewer      │       │ Deployer      │
    │ worker        │  │ worker        │       │ worker        │
    │               │  │               │       │               │
    │ User:         │  │ User:         │       │ User:         │
    │ devloop-orch  │  │ devloop-rev   │       │ devloop-dep   │
    │               │  │               │       │               │
    │ DB role:      │  │ DB role:      │       │ DB role:      │
    │ devloop_orch  │  │ devloop_rev   │       │ devloop_dep   │
    │               │  │               │       │               │
    │ Credentials:  │  │ Credentials:  │       │ Credentials:  │
    │ (none)        │  │ OPENAI_API_KEY│       │ GITHUB_APP_KEY│
    │               │  │               │       │ SIGNING_KEY   │
    └───────────────┘  └───────────────┘       └───────┬───────┘
                                                       │
                                                       │ writes desired_state
                                                       │ reads applied status
                                                       ▼
                                               ┌───────────────┐
                                               │ devloop-egress│
                                               │ -proxy        │
                                               │               │
                                               │ CONNECT       │
                                               │ allowlist:    │
                                               │ api.openai.com│
                                               │ api.anthropic│
                                               │ api.github   │
                                               │               │
                                               │ UNIX socket   │
                                               │ at /run/...   │
                                               └───────────────┘
                                                       ▲
                                                       │
                                                       │ via bind mount
                                                       │
┌──────────────────────────────────────┐       ┌───────┴────────┐
│ Worker manager                       │       │ Sandboxed      │
│                                      │──────▶│ Claude CLI     │
│ User: devloop-wm                     │ spawn │                │
│                                      │       │ bwrap user:    │
│ IPC via UNIX socket to orch/rev      │       │ devloop-worker │
│                                      │       │                │
│ DB role: devloop_wm                  │       │ netns: own     │
│  (limited UPDATE on worker fields)   │       │ fs: /workspace │
│                                      │       │     ro except  │
│ No external credentials              │       │ net: only      │
│ Delegates API calls back to main     │       │   egress proxy │
└──────────────────────────────────────┘       └────────────────┘
```

### 2.2 Trust boundaries (actual v1 behavior)

**Honesty note:** This table reflects what v1 actually does. Egress proxy enforcement is **only** for the sandboxed Claude in v1; reviewer and deployer have direct AF_INET outbound to their respective APIs. Forcing reviewer and deployer through the egress proxy is a roadmap hardening item, not v1 scope. See §19 D15.

| Boundary | Direction | Identity at origin | Identity at destination | Auth | Transport |
|---|---|---|---|---|---|
| Browser → Nginx | inbound | anonymous user | nginx (www-data) | TLS | HTTPS 443 |
| Nginx → Frontend | internal | www-data | devloop-front | — | loopback 3101 |
| Nginx → Public API | internal | www-data | devloop-api | — | loopback 3100 |
| Browser → Public API (via Nginx) | inbound | logged-in user | devloop-api | Session cookie + CSRF | HTTPS |
| Host adapter → Public API (via Nginx) | inbound | host backend | devloop-api | `host_token` (HMAC-verified) | HTTPS |
| Host deploy agent → Public API (via Nginx) | inbound | deploy agent | devloop-api | `deploy_token` (HMAC-verified) | HTTPS |
| Public API → Postgres | internal | devloop-api | devloop_api role | Unix socket peer auth | socket |
| Orchestrator → Postgres | internal | devloop-orch | devloop_orch | peer auth | socket |
| Reviewer → Postgres | internal | devloop-rev | devloop_rev | peer auth | socket |
| Deployer → Postgres | internal | devloop-dep | devloop_dep | peer auth | socket |
| Worker manager → Postgres | internal | devloop-wm | devloop_wm | peer auth | socket |
| Orchestrator → Worker manager (IPC) | internal | devloop-orch | devloop-wm | UNIX peer cred (SCM_CREDENTIALS) | `/run/devloop/wm.sock` |
| **Reviewer → OpenAI** | outbound | devloop-rev | `api.openai.com:443` | `openai_api_key` | **direct AF_INET** (not via proxy in v1) |
| **Deployer → GitHub** | outbound | devloop-dep | `api.github.com:443`, `github.com:443` | GitHub App installation token | **direct AF_INET** (not via proxy in v1) |
| **Deployer → host `/devloop-host/healthz`** | outbound | devloop-dep | host server | anonymous GET (rate-limited at host) | **direct AF_INET HTTPS** (used for deploy verification post-apply — see §7.5 step 9) |
| Public API → host `/devloop-host/healthz` | outbound | devloop-api (health-monitor module) | host server | anonymous GET | direct AF_INET HTTPS (for periodic uptime polling) |
| **Sandboxed Claude → egress proxy** | internal | devloop-worker (bwrap) | devloop-egress | UNIX socket + SO_PEERCRED | bind-mounted `/run/egress.sock` |
| **Sandboxed Claude → `api.anthropic.com`** | outbound via proxy | via `devloop-egress` | `api.anthropic.com:443` | `anthropic_api_key` (per-task credential file) | **proxied** (CONNECT over UNIX→TCP bridge, §3.2) |
| Host deploy agent → GitHub | outbound | devloop-deployer (on host) | `api.github.com`, `github.com` | host-side deploy key (read-only) or installation token | direct from host, not via central |

**Important clarifications:**

1. **Deployer does call host directly** for deploy verification — specifically, it polls `/devloop-host/healthz` after the host deploy agent reports "applied: success" to confirm the host is actually healthy with the new code. This is NOT a deploy push; it is a **verification probe**. Central does NOT send any deploy commands to the host. Deploy transport is still pull-based (§19 D17).

2. **Egress proxy enforcement is sandbox-only in v1.** Reviewer and deployer can theoretically make arbitrary outbound HTTPS calls. This is an accepted limitation documented in §17. Mitigations: systemd `RestrictAddressFamilies` keeps them from listening on arbitrary ports; their user identities have no DB write access that could be used to exfiltrate via DB; they are small, auditable modules.

3. **There is no "Deployer → host adapter (for deploy)"** row — that is the key removal from pre-v6 designs. Central never POSTs deploy commands to the host. The host pulls from central via the host deploy agent.

### 2.3 Why pull-based deployment

The deploy transport is pull-based: central writes intent; a host-side deploy agent polls, verifies, and applies. This materially reduces the **deploy transport attack surface** — there is no inbound deploy channel from central to host, no shell command sent over HTTP. But it does not eliminate the fact that central has authority to author, merge, and sign code that the host will apply. See §17 for the full threat model.

---

## 3. Components

### 3.1 Central services (all under `/opt/devloop/runtime/`)

Each service is a separate systemd unit running as a separate OS user with a separate Postgres role.

#### 3.1.1 Frontend — `runtime/frontend/`

- Next.js 16 App Router, React 18, standalone build
- User: `devloop-front`
- Listens: `127.0.0.1:3101` (loopback only)
- **No DB access, no credentials.** Pure client render. All data loaded via authenticated calls to the Public API.

#### 3.1.2 Public API — `runtime/api/`

- NestJS 11 + Fastify 5
- User: `devloop-api`
- Listens: `127.0.0.1:3100` (loopback only)
- Modules: `auth`, `projects`, `reports` (intake + list), `dashboard-api`, `health-monitor` (read-only UI), `compliance` (branch-protection checks), `host-deploy-api` (serves desired-state polling and apply-status reporting for host deploy agents)
- **DB privileges:** See §19 D26 (authoritative RBAC matrix). `devloop_api` role.
- **Credentials via systemd LoadCredential:** `jwt_secret`, `github_app_compliance_key` (read-only GitHub App for branch-protection checks — **not** the write-scoped deployer key), `data_encryption_key` (for `users.two_factor_secret` encryption). **No OpenAI key, no Anthropic key, no deploy signing key.**

#### 3.1.3 Orchestrator worker — `runtime/orchestrator/`

- NestJS standalone (no HTTP listener)
- User: `devloop-orch`
- Job queue consumer for `orchestrator` queue; owns the §7.2.1 reconciler loop
- **DB privileges:** See §19 D26. `devloop_orch` role.
- **Credentials:** none external.

#### 3.1.4 Reviewer worker — `runtime/reviewer/`

- NestJS standalone
- User: `devloop-rev`
- Job queue consumer for `reviewer` queue
- **DB privileges:** See §19 D26. `devloop_rev` role.
- **Credentials via LoadCredential:** `openai_api_key`.
- **Outbound:** direct AF_INET to `api.openai.com:443` (NOT via egress proxy in v1 — see §19 D15).

#### 3.1.5 Deployer worker — `runtime/deployer/`

- NestJS standalone
- User: `devloop-dep`
- Job queue consumer for `deployer` queue
- **DB privileges:** See §19 D26. `devloop_dep` role.
- **Credentials via LoadCredential:** `github_app_key` (write-scoped, private), `deploy_signing_priv_<key_id>` (path read from `deploy_signing_active_key_id`).
- **Outbound:** direct AF_INET to `api.github.com:443`, `github.com:443`, and `<host>/devloop-host/healthz` for deploy verification. NOT via egress proxy in v1 (§19 D15).

#### 3.1.6 Worker manager — `runtime/worker-manager/`

- Node process
- User: `devloop-wm`
- **Communication model:** IPC-driven from orchestrator over `/run/devloop/wm.sock` (see §19 D2). No `worker` DB queue.
- Responsibilities: receive `spawn` IPC, perform atomic task claim (§7.3), set up worktree, spawn sandboxed Claude (§3.2), heartbeat via `refresh_task()` (§6.3 D7), inspect worktree state on Claude exit, transition task to `review` or `failed` via `fence_and_transition()`, clean up credential file immediately after sandbox exit, emit `status` IPC back to orchestrator.
- **DB privileges:** See §19 D26. `devloop_wm` role.
- **Credentials via LoadCredential:** `anthropic_api_key` (loaded from `/etc/devloop/anthropic_api_key` and copied to per-task credential directory at spawn time, then bind-mounted into the sandbox — see §3.2). Never set as env var in the worker manager host process.
- **Outbound:** AF_UNIX only (Postgres socket, wm.sock, egress.sock for sandbox bind-mount). No direct outbound network.
- **Safety-net recovery:** Orchestrator's reconciler (§7.2.1) re-sends spawn IPC if a task sits in `assigned` with no `worker_id` for 30s.

#### 3.1.7 Egress proxy — `runtime/egress-proxy/`

- Small Go or Node program (~200 LOC) implementing an HTTP CONNECT proxy with strict allowlist
- User: `devloop-egress`
- Listens on UNIX socket `/run/devloop/egress.sock` (mode 0660, group `devloop-egress-clients`)
- Allowlist (SNI-matched):
  - `api.openai.com:443`
  - `api.anthropic.com:443`
  - `api.github.com:443`
  - `codeload.github.com:443`
  - `github.com:443` (for git clone over HTTPS)
- Logs every connection attempt with SNI + origin uid (via SO_PEERCRED)
- Rejects any unlisted hostname with immediate close
- Rate-limited per origin uid
- **This is a security-critical component** and will be small, auditable, and separately reviewed.

### 3.2 Sandboxed worker execution (the Claude runtime)

The worker manager spawns Claude inside a strict sandbox. **Decision:** Claude CLI runs inside the sandbox. Network access is only to the egress proxy via a bind-mounted UNIX socket.

#### Sandbox setup per task

**Identity:** The sandboxed Claude process runs as the dedicated `devloop-worker` uid/gid (see §11). Worktree and egress socket are group-accessible to this identity.

**Filesystem preparation (as `devloop-wm` — the worker manager):**
```
1. Create a fresh git worktree on the canonical devloop branch name:
   git worktree add /var/devloop/worktrees/<task_id>/workspace \
       -b devloop/task/<task_id> \
       origin/<default_branch>
   (performed in /var/devloop/projects/<slug>/main/ bare mirror)

2. Write the task files inside the worktree:
   /var/devloop/worktrees/<task_id>/workspace/.devloop-task/TASK.md
   /var/devloop/worktrees/<task_id>/workspace/.devloop-task/role.md

3. Set ownership for shared access between devloop-worker (sandbox) and devloop-wm (supervisor):
   chown -R devloop-worker:devloop-fs /var/devloop/worktrees/<task_id>
   chmod -R u=rwX,g=rwX,o= /var/devloop/worktrees/<task_id>
   (devloop-wm is a member of devloop-fs and thus can list, read, inspect git state,
    and remove files after the sandbox exits. devloop-worker owns the files and has
    full write access inside the sandbox.)

4. Copy Anthropic API key file into a per-task credential directory:
   mkdir -p /var/devloop/worktrees/<task_id>/cred
   install -m 0440 -o devloop-worker -g devloop-fs \
       /etc/devloop/anthropic_api_key \
       /var/devloop/worktrees/<task_id>/cred/anthropic-key
   (group read by devloop-fs so devloop-wm can shred it after the sandbox exits;
    owner devloop-worker so the sandbox can read it.)
```

**Network isolation:**

Each task gets its own private network namespace via **bwrap's `--unshare-net`** flag. This creates an unprivileged network namespace with no interfaces (not even loopback enabled). The sandbox can only reach outside the netns via explicitly bind-mounted UNIX sockets.

**No external `ip netns add` is required** — bwrap creates the netns inside its user namespace without needing `CAP_NET_ADMIN` or root. This is the key advantage of using bwrap (which uses user namespaces) over systemd-nspawn (which needs root).

**bwrap invocation (run as `devloop-wm`, which executes `bwrap` that in turn switches identity to `devloop-worker` inside the sandbox user namespace):**
```
bwrap \
  --unshare-all \
  --unshare-net \
  --uid $(id -u devloop-worker) --gid $(id -g devloop-worker) \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --ro-bind /etc/alternatives /etc/alternatives \
  --ro-bind /etc/ssl/certs /etc/ssl/certs \
  --ro-bind /opt/devloop/runtime/agent-config /agent-config \
  --bind /var/devloop/worktrees/<task_id>/workspace /workspace \
  --ro-bind /var/devloop/worktrees/<task_id>/cred /run/cred \
  --bind /run/devloop/egress.sock /run/egress.sock \
  --ro-bind /opt/devloop/runtime/worker-manager/sandbox-bin/claude-wrapped /usr/local/bin/claude-wrapped \
  --tmpfs /tmp \
  --proc /proc \
  --dev /dev \
  --setenv HOME /workspace \
  --setenv PATH /usr/local/bin:/usr/bin:/bin \
  --setenv HTTPS_PROXY http://127.0.0.1:9090 \
  --setenv HTTP_PROXY http://127.0.0.1:9090 \
  --setenv DEVLOOP_TASK_ID <task_id> \
  --setenv ANTHROPIC_API_KEY_FILE /run/cred/anthropic-key \
  --chdir /workspace \
  --new-session \
  --die-with-parent \
  -- \
  /usr/local/bin/claude-wrapped -p "$(cat /workspace/.devloop-task/TASK.md)"
```

**Claude CLI + UNIX socket proxy via TCP shim (§19 D1 mechanism):**

Claude CLI expects a standard HTTP(S) proxy URL (`http://host:port`) — it does NOT natively support `unix://` proxy schemes. We bridge this with a small bash wrapper script `/opt/devloop/runtime/worker-manager/sandbox-bin/claude-wrapped`:

```bash
#!/bin/bash
# claude-wrapped: run inside the bwrap sandbox.
# Starts a local TCP listener that forwards to the bind-mounted UNIX socket /run/egress.sock
# then execs the real Claude CLI with HTTPS_PROXY pointing at 127.0.0.1:9090.

set -euo pipefail

# Launch socat as a background process:
# - Listens on 127.0.0.1:9090 inside the sandbox's private netns loopback (brought up by bwrap)
# - Forwards each connection to UNIX:/run/egress.sock
# - Sandboxed netns has lo interface available for localhost TCP
socat TCP4-LISTEN:9090,bind=127.0.0.1,reuseaddr,fork UNIX-CLIENT:/run/egress.sock &
SOCAT_PID=$!
trap "kill $SOCAT_PID 2>/dev/null || true" EXIT

# Give socat a moment to bind
sleep 0.1

# Export ANTHROPIC_API_KEY from the per-task credential file
# (Claude CLI may or may not support ANTHROPIC_API_KEY_FILE depending on version;
# this guarantees compatibility by setting the env var just before exec.)
if [[ -n "${ANTHROPIC_API_KEY_FILE:-}" && -r "$ANTHROPIC_API_KEY_FILE" ]]; then
  export ANTHROPIC_API_KEY="$(cat "$ANTHROPIC_API_KEY_FILE")"
fi

# Exec the real Claude CLI
exec /usr/local/bin/claude "$@"
```

**Notes on the shim:**
- `socat` is pre-installed on the host and bind-mounted read-only into the sandbox via bwrap (not shown in the bwrap invocation above but implied — add `--ro-bind /usr/bin/socat /usr/bin/socat`)
- The sandbox's network namespace has a loopback interface brought up by bwrap by default (when `--unshare-net` is used, bwrap still creates `lo` inside the new netns)
- If the Linux distribution's bwrap doesn't automatically bring up `lo`, the wrapper can do it: `ip link set lo up` (inside the netns this requires `CAP_NET_ADMIN`, which bwrap's user namespace does grant within the namespace)
- This mechanism has the advantage of giving Claude a standard HTTP proxy URL, so no Claude CLI modifications are needed
- Only 127.0.0.1 listener; the egress proxy on the host side still enforces SNI allowlist via SO_PEERCRED on the UNIX socket (sees the sandbox's effective uid)
```

**Key points:**
- **Uid match:** the `--uid/--gid` passed to bwrap matches the real `devloop-worker` system uid on the host. This is the identity under which the worktree and credential file are chowned.
- **No `ANTHROPIC_API_KEY` env var is set in the host process** (worker manager has no env secret). Instead, the credential file is copied into a per-task directory that only `devloop-worker` can read, and the sandbox reads it via `ANTHROPIC_API_KEY_FILE=/run/cred/anthropic-key`. Claude CLI supports this pattern; if a specific version does not, the worker manager can wrap invocation in a small shell that `export ANTHROPIC_API_KEY=$(cat $ANTHROPIC_API_KEY_FILE)` as the first action inside the sandbox. The credential never exists in any parent-process environment.
- **Egress socket:** `/run/devloop/egress.sock` is owned `devloop-egress:devloop-egress-clients` with mode 0660. `devloop-worker` is a member of `devloop-egress-clients` (see §11), so it can connect. The socket is bind-mounted into the sandbox at `/run/egress.sock`.
- **Anthropic key cleanup:** After Claude exits (success or failure), worker manager `shred`s the per-task credential file and removes the `cred/` directory as part of worktree cleanup.

**Resource limits (via systemd slice or cgroup directly):**
```
CPUQuota=200%  MemoryMax=4G  TasksMax=256  IOWeight=100
```

**Hard timeout:** 1800s default, configurable per risk tier.

**Heartbeat:** every 60s, worker manager calls the `TaskStateService.heartbeat(task_id, lease_version)` stored procedure which atomically updates `agent_tasks.heartbeat_at` AND renews `module_locks.expires_at` for the lock held by this task in the same transaction.

#### Data channel

Claude communicates with the outside world only through:
- Git commits in the worktree (this is how it submits its work)
- Stdout/stderr (this is how it reports progress to the human log)
- The egress proxy (for calling Anthropic API itself)

Claude **does not** have a DB credential, an internal API token, or any other control channel. State transitions are derived by the worker manager from the worktree state after Claude exits.

#### Log redaction

Worker manager reads Claude's stdout/stderr through a **redaction pipe** that matches regex patterns for common secrets before writing to `/var/log/devloop/workers/<task_id>.log`:

- `Authorization: (Bearer|Basic) .*` → `Authorization: [REDACTED]`
- `sk-[a-zA-Z0-9_-]{20,}` → `[REDACTED_API_KEY]`
- `ghp_[a-zA-Z0-9]{20,}`, `ghs_...`, `github_pat_...` → `[REDACTED_GH_TOKEN]`
- `-----BEGIN (OPENSSH |RSA |EC )?PRIVATE KEY-----` to `-----END ... KEY-----` → `[REDACTED_PRIVATE_KEY]`
- Base64 over 32 chars adjacent to `password|passwd|secret|token` → `[REDACTED_POSSIBLE_SECRET]`
- Connection strings: `postgres://.*@`, `redis://.*@`, `mongodb://.*@` → hostname-only

A separate **unredacted debug log** is written to `/var/devloop/private/workers/<task_id>.log.raw` with mode 0600, readable only by `devloop-wm`. It is auto-deleted 24h after task completion. This is an operator debugging aid, not production log.

Log file size cap: 10MB per task. Truncated with tail preservation if exceeded.

### 3.3 Host adapter — Reporter

Installed in each host project's backend codebase.

#### Components
- Frontend overlay lib (re-export of `/opt/devloop/frontend/components/dev/`)
- Backend NestJS module: `devloop-host.module.ts`

#### Endpoints mounted at `/devloop-host/`:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/devloop-host/report-relay` | browser session cookie from host app | Receives report from browser, server-side forwards to central with `host_token` |
| `GET` | `/devloop-host/healthz` | anonymous | Returns HTTP 200 with body `{ok: true}` and nothing else. Rate-limited. |

**`/version` endpoint removed.** Deploy verification uses the host deploy agent reporting back to central + GitHub API cross-check, not a host HTTP endpoint.

#### Token storage

The `host_token` is read from file `/etc/devloop-host/host_token` (mode 0400, owned by the host app's runtime user), **not from an env var**. This matches the deploy agent model and avoids leakage via process listings and crash dumps.

#### Configuration

```yaml
# /etc/devloop-host/config.yml (mode 0440)
central_url: https://devloop.airpipe.ai
project_slug: dev-energicrm
token_file: /etc/devloop-host/host_token
report_redact_pii: true
```

### 3.4 Host adapter — Deploy agent

Separate small Node program (or Go binary). Runs on the host server as system service.

#### Responsibilities
1. Poll `GET https://devloop.airpipe.ai/api/v1/projects/<slug>/desired-state` every 15 seconds with bearer `deploy_token`
2. Verify Ed25519 signature on response using trusted `key_id` from local policy
3. Compare desired vs current state (current tracked in `/var/lib/devloop-deploy-agent/state.json`)
4. On change: validate against allowlist policy (`/etc/devloop-deploy-agent/policy.yml`)
5. Execute deploy (release-directory pattern, see below)
6. Capture stdout/stderr, redact, POST back to `POST /api/v1/projects/<slug>/desired-state/applied` (canonical verb per §4.2 host→central contract)

#### Configuration

```yaml
# /etc/devloop-deploy-agent/config.yml (mode 0440, owned by devloop-deployer:devloop-deploy)
central_url: https://devloop.airpipe.ai
project_slug: dev-energicrm
deploy_token_file: /etc/devloop-deploy-agent/deploy-token
trusted_signing_keys:
  - key_id: "central-2026-04"
    pubkey_file: /etc/devloop-deploy-agent/keys/central-2026-04.pub
    not_after: "2027-04-10"
github_credentials_file: /etc/devloop-deploy-agent/github-key  # read-only deploy key or installation token
release_dir: /opt/dev_energicrm/releases
current_symlink: /opt/dev_energicrm/current
keep_last_releases: 5
deploy_command: |
  set -euo pipefail
  cd "$RELEASE_DIR"
  npm ci --prefix backend
  npm --prefix backend run build
  npm ci --prefix frontend
  npm --prefix frontend run build
post_deploy_command: |
  pm2 restart backend frontend
health_check_url: http://127.0.0.1:3001/healthz     # health endpoint to poll after post_deploy_command
health_check_timeout_seconds: 60                    # total time to wait for 60s of continuous success
health_check_interval_seconds: 2
policy_file: /etc/devloop-deploy-agent/policy.yml
state_file: /var/lib/devloop-deploy-agent/state.json
```

```yaml
# /etc/devloop-deploy-agent/policy.yml
allowed_deploy_branches:
  - experiment2    # plain branch names, never refs/heads/ prefix
allowed_path_prefixes:
  - backend/src/
  - frontend/src/
  - backend/package.json
  - frontend/package.json
denied_path_prefixes:
  - backend/src/email/      # LOCKED
  - frontend/src/app/(dashboard)/inbox/
max_files_changed: 50
max_lines_changed: 2000
require_all_tests_passed: true
```

#### Release-directory pattern

Deploy agent never mutates `current` in place. On each deploy:

```
1. Receive `{signed_bytes, signature, signing_key_id}` from central.
   Look up signing_key_id in local policy trusted keys; abort if not trusted.
   Verify: ed25519_verify(trusted_pubkey, signed_bytes, signature). Abort on failure.
   Parse the JSON object from signed_bytes (standard UTF-8 JSON parse; JCS is a valid JSON subset).
   Extract `id` (=desired_state_id), `deploy_sha`, `base_sha`, `action`, `target_branch`, `seq_no`, `issued_at`.
   Echo `id` back in the apply report at the end.
   Verify `seq_no > last_applied_seq_no` recorded in local state.json; reject out-of-order deploys.
   Verify `issued_at` is within a reasonable window (not older than 24h, not in the future).

2. Verify target_branch is in policy.allowed_deploy_branches.
   (Note: this checks the branch the deploy_sha sits on after merge — typically the default branch.
    Source-branch provenance is guaranteed by central's signature, which proves the deploy_sha was
    produced by a DevLoop flow.)

3. mkdir -p $release_dir/<new_sha>
   git clone --no-checkout $github_url $release_dir/<new_sha>
      (using /etc/devloop-deploy-agent/github-key for private repo auth)
   OR: rsync -a $local_mirror/.git/ $release_dir/<new_sha>/.git/
4. cd $release_dir/<new_sha>
5. git fetch origin <new_sha>
6. git checkout --detach <new_sha>

7. Verify diff against currently-deployed SHA matches policy.yml allowlist:
   git diff --name-only <current_sha>..<new_sha>
     - all changed paths must match allowed_path_prefixes
     - no paths must match denied_path_prefixes (e.g., backend/src/email/)
     - total file count <= policy.max_files_changed
     - total added+removed lines <= policy.max_lines_changed
   If any check fails: abort, POST back {status: "failed", reason: "policy_violation", desired_state_id}

8. Run deploy_command (build):
   Set $RELEASE_DIR env var to $release_dir/<new_sha>
   Execute configured deploy_command
   Capture stdout/stderr

9. If build fails (non-zero exit):
   DO NOT cut over.
   POST back {status: "failed", reason: "build_failed", desired_state_id, log: <redacted_excerpt>}
   Remove $release_dir/<new_sha> to avoid disk fill (or retain for debugging per config)
   END

10. Atomic cutover:
    Create a temp symlink adjacent to current:
      ln -s $release_dir/<new_sha> $current_symlink.new
    Atomically rename:
      mv -T $current_symlink.new $current_symlink
    (mv -T with a symlink argument is atomic on Linux and is the correct pattern here; ln -sfn is NOT atomic.)

11. Run post_deploy_command (e.g., pm2 restart):
    Execute configured post_deploy_command
    Capture stdout/stderr

12. If post_deploy_command fails OR subsequent health check fails:
    a) Attempt immediate local rollback: mv -T $current_symlink back to the previous release
       ln -s <previous_sha_dir> $current_symlink.rollback
       mv -T $current_symlink.rollback $current_symlink
    b) Run post_deploy_command again to restore previous service
    c) POST back {
         status: "failed",
         reason: "post_deploy_failed_reverted_locally" | "post_deploy_failed_local_revert_also_failed",
         desired_state_id,
         log: <redacted_excerpt>
       }
    d) If local revert also failed: service is in an unknown state. Deploy agent refuses all future
       deploys until an operator clears the flag manually. This is an explicit halt-and-catch-fire.

13. Wait for health check:
    Poll http://localhost:<health_port>/healthz for 60 seconds of continuous 200/ok.
    If health check passes:
      POST back {status: "success", applied_sha: <new_sha>, desired_state_id, log: <redacted_excerpt>}
    If health check fails:
      Go to step 12 (treat as post_deploy_failed).

14. Keep last $keep_last_releases releases in $release_dir for fast rollback; prune older ones.
```

**Atomicity note:** step 10 uses `mv -T` which on Linux performs an atomic `rename()` syscall. This is the correct primitive. Prior designs using `ln -sfn` are **not** atomic and can leave a brief window where the symlink target is undefined.

**Failure-handling split:**
- **Pre-cutover failures** (steps 1-9): previous release stays active. Host is unaffected. Agent reports failure.
- **Post-cutover failures** (steps 11-13): new release went live but something broke. Agent attempts immediate local revert (step 12). If local revert succeeds, the incident is contained to a brief period of breakage. If local revert fails, the agent halts to prevent further damage and pages for manual intervention.

**Branch policy semantics clarification:**
- `allowed_deploy_branches` in the host policy refers to the **target branch of the merged commit**, which is the branch the SHA now lives on in the repo (typically the default branch like `experiment2` or `main`).
- **Source-branch verification** (i.e., confirming the SHA was produced via a DevLoop agent branch and not pushed directly) is **not** the host policy's job. It is guaranteed by central's signature on the desired-state payload, which is itself only generated after the full orchestrator → worker → reviewer → deployer pipeline.
- The host policy is therefore a defense in depth: even if central goes rogue, the host limits deploys to specific target branches + specific file paths + size caps.

#### Rollback

Rollback is driven by central writing a new `desired_state` pointing to the previous SHA. Deploy agent applies it the same way as a forward deploy. Because previous releases are still in `$release_dir`, rollback is fast (no rebuild if using the cached release directory is allowed; config flag).

---

## 4. Data Model

### 4.1 Database setup

- **Database:** `devloop` (separate DB, same Postgres instance as energicrm)
- **Roles:** `devloop_owner` (migrations, NOLOGIN in runtime), plus five runtime roles: `devloop_api`, `devloop_orch`, `devloop_rev`, `devloop_dep`, `devloop_wm`.
- **Authoritative privilege matrix:** See **§19 D26** — the single source of truth. Do not duplicate privilege lists here.
- **Auth:** Unix socket peer authentication; OS user → Postgres role mapping via `pg_ident.conf` (see §11).
- **`synchronize=false`** enforced by both code and a DB-level startup check.
- **Mutation boundary** (§19 D19): sensitive tables (`agent_tasks.status`, `module_locks`, `deploy_mutex`, `desired_state_history`, `audit_events`, `audit_chain_head`, `signing_keys` private material) are mutated **only** via SECURITY DEFINER stored procedures listed in §19 D26. No runtime role has direct `INSERT`/`UPDATE`/`DELETE` on these tables.

### 4.2 Tables

Omitting the fully-typed definition already in v2 where unchanged. Only changes from v2 are listed explicitly.

#### Unchanged from v2 (brief list)
- `users`, `sessions`, `projects`, `reports`, `report_threads`, `report_artifacts`, `host_health`, `host_health_alerts`

#### `projects` — modifications from v2

Add:
- CHECK `host_base_url ~ '^https://'`
- CHECK `host_base_url !~ '^https?://(127\.|localhost|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'` (reject private/internal IPs for production projects; toggle-off flag in config for dev)
- Column: `branch_protection_verified_at timestamptz NULL` — last time compliance module verified GitHub branch protection
- Column: `branch_protection_required_checks text[] NOT NULL` — list of required check names
- Column: `deploy_allowlist_paths text[] NOT NULL` — policy reference, mirrored from deploy agent
- Column: `deploy_denied_paths text[] NOT NULL`

Remove:
- `deploy_signing_pubkey` (now global)

#### `agent_tasks` — modifications from v2

- Stale-detection index covers ALL non-terminal non-blocked states (not just `in_progress`): `CREATE INDEX idx_agent_tasks_stale ON agent_tasks(heartbeat_at) WHERE status NOT IN ('verified', 'rolled_back', 'rollback_failed', 'failed', 'cancelled', 'queued_for_lock', 'blocked')`. See §6.3 for the unified heartbeat model.

- **Deploy-stage uniqueness DB invariant** (critical — enforces that at most one nonterminal deploy-stage task exists per project at any time, independent of in-process mutex coordination):

  ```sql
  CREATE UNIQUE INDEX idx_agent_tasks_one_deploy_per_project
      ON agent_tasks (project_id)
      WHERE status IN ('deploying', 'merged', 'verifying', 'rolling_back', 'rollback_failed');
  ```

  **Includes `rollback_failed`.** While a task is in `rollback_failed`, no new task can enter any deploy-stage status for that project. The manual recovery command `devloop recovery clear-task <task_id>` is the only way to transition a `rollback_failed` task to a terminal state that allows new deploys on the project.

  This index guarantees that even during crash recovery gaps (where the `deploy_mutex` row might have been cleared but the original task is still nonterminal), a second task cannot transition INTO any deploy-stage status for the same project. The transition attempt fails at the DB level with a unique constraint violation.

  This is a defense-in-depth layer on top of `deploy_mutex`. The mutex provides fast in-process coordination; the unique index provides hard DB-level enforcement. They cannot drift out of sync. **Deploy-mutex acquisition is performed inside `fence_and_transition('approved' → 'deploying')`** so admission to the deploy-stage status and mutex ownership are atomic in one transaction.
- Replace single `approved_commit_sha` with `approved_base_sha` + `approved_head_sha`
- Add CHECK: `status = 'approved' => approved_head_sha IS NOT NULL AND approved_base_sha IS NOT NULL AND review_decision = 'approved'`
- Add CHECK: `status IN ('verified', 'rolled_back') => completed_at IS NOT NULL`
- Add CHECK: `status = 'merged' => merged_commit_sha IS NOT NULL`
- Add column `project_config_id uuid REFERENCES project_configs(id)` — which exact config row was active when the task started (ensures reproducibility). Not a composite reference — uses the `project_configs.id` primary key directly.
- Add column `applied_desired_state_id uuid REFERENCES desired_state_history(id)` — the forward-deploy desired_state row the host is expected to apply for this task
- Add column `rollback_desired_state_id uuid REFERENCES desired_state_history(id) NULL` — populated by deployer in §7.5 step 10 when writing the rollback desired_state row. Verification scanner uses `COALESCE(rollback_desired_state_id, applied_desired_state_id)` when task is in `rolling_back` to find the row to check `applied_at` / `applied_status` on.
- Add column `github_pr_number int NULL` — persisted BEFORE waiting on CI (deployer idempotency checkpoint)
- Add column `agent_branch_published_at timestamptz NULL` — deployer sets this after `git push origin devloop/task/<task_id>` succeeds
- Add column `retry_count int NOT NULL DEFAULT 0` — **single retry model:** incremented inside `fence_and_transition()` only when entering a retryable state from a transient failure path (e.g., re-entering `deploying` from `approved` after a prior `failed` attempt that was requeued by an operator). Janitor does NOT touch `retry_count`. `max_retries` is a process constant (default 3); when `retry_count >= max_retries`, `fence_and_transition()` forces `failed` instead of the requested retryable state.

#### `module_locks` — unchanged

#### NEW `audit_chain_head`
```
id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1)  -- single row
last_event_id bigint NOT NULL
last_hash     bytea NOT NULL
updated_at    timestamptz NOT NULL DEFAULT now()
```

Audit insert algorithm (executed inside a transaction that takes advisory lock first):

```sql
BEGIN;
SELECT pg_advisory_xact_lock(7331);  -- constant key for audit chain
SELECT last_event_id, last_hash INTO prev_id, prev_hash FROM audit_chain_head WHERE id = 1;
INSERT INTO audit_events (..., chain_prev_id, chain_hash)
  VALUES (..., prev_id, sha256(prev_hash || canonical_payload))
  RETURNING id, chain_hash INTO new_id, new_hash;
UPDATE audit_chain_head SET last_event_id = new_id, last_hash = new_hash, updated_at = now() WHERE id = 1;
COMMIT;
```

The advisory lock serializes only audit inserts, not the rest of the work. Throughput impact is minimal for our scale.

#### NEW `quota_usage_global`
```
period_key   varchar(32) NOT NULL
metric       varchar(64) NOT NULL
limit_value  bigint NOT NULL
used_value   bigint NOT NULL DEFAULT 0
PRIMARY KEY (period_key, metric)
```

#### NEW `quota_usage_project`
```
period_key   varchar(32) NOT NULL
project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
metric       varchar(64) NOT NULL
limit_value  bigint NOT NULL
used_value   bigint NOT NULL DEFAULT 0
PRIMARY KEY (period_key, project_id, metric)
```

Two tables instead of one nullable FK column; cleaner index behavior.

Reservation pattern (either table):

```sql
UPDATE quota_usage_global
   SET used_value = used_value + $delta
 WHERE period_key = $1 AND metric = $2
   AND used_value + $delta <= limit_value
RETURNING used_value;
```

#### NEW `deploy_mutex`
```
project_id         uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE
holder_task_id     uuid NULL REFERENCES agent_tasks(id) ON DELETE SET NULL
holder_worker_id   varchar(128) NULL          -- hostname:pid of the deployer worker holding it
acquired_at        timestamptz NULL
last_heartbeat_at  timestamptz NULL           -- renewed by deployer every 60s while any stage is active
expires_at         timestamptz NULL           -- = last_heartbeat_at + interval '5 minutes' (the grace period)
lease_version      bigint NOT NULL DEFAULT 0
```

**Semantics:**

- Deploy mutex is held for the full duration of `deploying`, `merged`, `verifying`, and `rolling_back` states on any single task for the project. **Deployer is responsible for explicit renewal** via `deploy_mutex_renew(project_id, task_id, expected_lease_version)` every 60 seconds during long-running operations (CI polling, host apply wait).
- Mutex is released via `deploy_mutex_release(project_id, task_id, expected_lease_version)` on explicit terminal transitions of the task: `verified`, `rolled_back`, `failed`, `cancelled`. **`rollback_failed` is the exception:** mutex is RETAINED and released only by the manual recovery procedure (`devloop recovery clear-task <task_id>`). See §19 Decision D5.
- Crash handling: if the holding deployer crashes, `last_heartbeat_at` stops updating. After `now() > expires_at` (5 min grace), the janitor calls `deploy_mutex_clear_if_stale(project_id)` which atomically clears the row IF still stale AND increments `lease_version`. The increment fences the original holder; if it ever returns from zombie state, its next write fails (`WHERE lease_version = $expected` returns 0 rows).
- **Acquisition** is via `deploy_mutex_acquire(project_id, task_id)` stored procedure:

```sql
CREATE OR REPLACE FUNCTION deploy_mutex_acquire(p_project_id uuid, p_task_id uuid, p_worker_id varchar)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_lease bigint;
BEGIN
  INSERT INTO deploy_mutex (project_id, holder_task_id, holder_worker_id, acquired_at, last_heartbeat_at, expires_at, lease_version)
  VALUES (p_project_id, p_task_id, p_worker_id, now(), now(), now() + interval '5 minutes', 1)
  ON CONFLICT (project_id) DO UPDATE
    SET holder_task_id   = EXCLUDED.holder_task_id,
        holder_worker_id = EXCLUDED.holder_worker_id,
        acquired_at      = EXCLUDED.acquired_at,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        expires_at       = EXCLUDED.expires_at,
        lease_version    = deploy_mutex.lease_version + 1
    WHERE deploy_mutex.holder_task_id IS NULL OR deploy_mutex.expires_at < now()
  RETURNING lease_version INTO v_lease;
  RETURN v_lease;  -- NULL if mutex is held by active deployer
END;
$$;
```

This atomic acquire+upsert guarantees two approved tasks for the same project cannot both enter `deploying`.

#### NEW `desired_state_history`
```
id                     uuid PRIMARY KEY DEFAULT gen_random_uuid()
project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
seq_no                 bigint NOT NULL                      -- monotonic per project
deploy_sha             varchar(64) NOT NULL
base_sha               varchar(64) NOT NULL
action                 desired_action_enum NOT NULL         -- deploy | rollback | baseline
target_branch          varchar(128) NOT NULL                -- the branch the deploy_sha sits on (typically default branch)
signing_key_id         varchar(64) NOT NULL                 -- which key signed this
signed_bytes           bytea NOT NULL                       -- the EXACT RFC 8785 JCS-canonicalized UTF-8 bytes. Served to host verbatim; host never re-canonicalizes.
signature              bytea NOT NULL                       -- Ed25519(private_key, signed_bytes) = 64 bytes
issued_at              timestamptz NOT NULL DEFAULT now()
issued_by_task_id      uuid NULL REFERENCES agent_tasks(id)
issued_by_user_id      uuid NULL REFERENCES users(id)       -- for manual deploys, or NULL for baseline seeded at registration
-- Host apply lifecycle (v9):
apply_started_at       timestamptz NULL                     -- host agent POSTed status='started'
apply_last_heartbeat_at timestamptz NULL                    -- host agent POSTed status='heartbeat' most recently
applied_sha            varchar(64) NULL                     -- only set on final success
applied_at             timestamptz NULL                     -- only set on final success/failed/timed_out
applied_status         apply_status_enum NULL               -- success | failed | timed_out
applied_log_excerpt    text NULL                            -- redacted, size-capped
UNIQUE (project_id, seq_no)
INDEX (project_id, seq_no DESC)
```

**Host → central HTTP contract** (canonicalized to POST — all lifecycle callbacks use the same verb):

```
POST /api/v1/projects/<slug>/desired-state/applied
Content-Type: application/json
Authorization: Bearer <deploy_token>

{
  "desired_state_id": "...",
  "status": "started" | "heartbeat" | "success" | "failed",
  "applied_sha": "..." (only on success),
  "log_excerpt": "..." (optional, redacted, size-capped)
}
```

The Public API dispatches on `status`:
- `started` → `record_apply_started(desired_state_id)` stored procedure
- `heartbeat` → `record_apply_heartbeat(desired_state_id)` stored procedure
- `success` or `failed` → `record_deploy_applied(desired_state_id, status, applied_sha, log_excerpt)` stored procedure

**Late-success rejection gate (v9 fix for C2):** `record_deploy_applied()` uses `WHERE id = $1 AND applied_status IS NULL` (not `applied_at IS NULL`). When the verification scanner detects a timeout, it atomically sets `applied_status = 'timed_out'` on the row. A late success arriving after that is rejected because the WHERE clause no longer matches. Returns `false` and emits audit event `deploy_host_apply_late_after_timeout`.

**Canonicalization protocol (RFC 8785 JCS):**

The JSON object that gets signed has these fields in lexicographic order (JCS-enforced):

```json
{
  "action": "deploy",
  "base_sha": "abc...",
  "deploy_sha": "def...",
  "id": "01234567-89ab-cdef-0123-456789abcdef",
  "issued_at": "2026-04-10T12:34:56.789Z",
  "project_id": "fedcba98-7654-3210-fedc-ba9876543210",
  "seq_no": 42,
  "signing_key_id": "central-2026-04",
  "target_branch": "experiment2"
}
```

- Field order: JCS sorts keys lexicographically (`action`, `base_sha`, `deploy_sha`, `id`, `issued_at`, `project_id`, `seq_no`, `signing_key_id`, `target_branch`).
- `issued_at` is ISO 8601 UTC with millisecond precision, no timezone offset suffix other than `Z`.
- UUIDs are lowercase with dashes.
- Numbers (including `seq_no`) are plain integers, no leading zeros, no exponent.
- Strings are UTF-8 with JCS escaping rules.
- No extra whitespace; JCS specifies exact formatting.

Deployer computes JCS bytes once using an RFC 8785 implementation (e.g., `rfc8785` npm package), signs with Ed25519 private key, and stores both `signed_bytes` (the exact JCS output) and `signature` in the DB row. The ID field in the JSON must match the row's `id`, so the id is generated before JCS computation. When the host fetches the record, the Public API returns `signed_bytes` and `signature` as-is; the host verifies `ed25519_verify(trusted_pubkey, signed_bytes, signature)` and parses the JSON from `signed_bytes` to extract `deploy_sha`, `id`, etc. **The host never re-canonicalizes.**

Append-only. Never updated except for the `applied_*` columns, which are filled in **once** when the host reports back via the `record_deploy_applied()` stored procedure that enforces `WHERE id = $1 AND applied_at IS NULL`.

**Latest-per-project query** (served to host deploy agent on `GET .../desired-state`):
```sql
SELECT * FROM desired_state_history
 WHERE project_id = $1
 ORDER BY seq_no DESC
 LIMIT 1;
```
The `(project_id, seq_no DESC)` index makes this an O(log N) lookup. **There is no `desired_state_current` table or materialized view.** v3's description of that table had three incompatible variants and is removed.

#### Stored procedure `record_deploy_applied`

Used by Public API to record the host's apply status. `SECURITY DEFINER` so that `devloop_api` (which does not have direct UPDATE on `desired_state_history`) can invoke it. Enforces idempotency and emits audit event.

```sql
CREATE OR REPLACE FUNCTION record_deploy_applied(
  p_desired_state_id uuid,
  p_project_id       uuid,
  p_status           apply_status_enum,   -- 'success' | 'failed'
  p_applied_sha      varchar(64),
  p_log_excerpt      text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  -- v10 fix: gate on applied_status IS NULL (not applied_at IS NULL).
  -- When the verification scanner sets applied_status='timed_out' on timeout,
  -- this WHERE clause no longer matches, so a late success is atomically rejected.
  -- Validation: 'success' requires non-null applied_sha.
  IF p_status = 'success' AND p_applied_sha IS NULL THEN
    RAISE EXCEPTION 'record_deploy_applied: success status requires non-null applied_sha';
  END IF;

  UPDATE desired_state_history
     SET applied_sha         = p_applied_sha,
         applied_at          = now(),
         applied_status      = p_status,
         applied_log_excerpt = p_log_excerpt
   WHERE id                  = p_desired_state_id
     AND project_id          = p_project_id
     AND applied_status      IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Either already applied (idempotent retry), wrong id, or row was marked timed_out first.
    -- Distinguish cases for clearer audit.
    IF EXISTS (SELECT 1 FROM desired_state_history
                WHERE id = p_desired_state_id
                  AND project_id = p_project_id
                  AND applied_status = 'timed_out') THEN
      PERFORM append_audit_event(
        p_project_id, NULL, NULL,
        'deploy_host_apply_late_after_timeout'::audit_event_enum,
        'system', 'host-deploy-agent',
        jsonb_build_object('desired_state_id', p_desired_state_id, 'attempted_status', p_status)
      );
    ELSE
      PERFORM append_audit_event(
        p_project_id, NULL, NULL,
        'deploy_host_apply_duplicate_or_missing'::audit_event_enum,
        'system', 'host-deploy-agent',
        jsonb_build_object('desired_state_id', p_desired_state_id, 'status', p_status)
      );
    END IF;
    RETURN false;
  END IF;

  PERFORM append_audit_event(
    p_project_id, NULL, NULL,
    CASE WHEN p_status = 'success'
         THEN 'deploy_host_applied'::audit_event_enum
         ELSE 'deploy_host_apply_failed'::audit_event_enum
    END,
    'system', 'host-deploy-agent',
    jsonb_build_object(
      'desired_state_id', p_desired_state_id,
      'applied_sha',      p_applied_sha,
      'status',           p_status
    )
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION record_deploy_applied FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_deploy_applied TO devloop_api;
```

#### Stored procedure `record_apply_started` (v10, for lifecycle "started")

```sql
CREATE OR REPLACE FUNCTION record_apply_started(
  p_desired_state_id uuid,
  p_project_id       uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE desired_state_history
     SET apply_started_at = COALESCE(apply_started_at, now()),
         apply_last_heartbeat_at = now()
   WHERE id = p_desired_state_id
     AND project_id = p_project_id
     AND applied_status IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RETURN false; END IF;
  PERFORM append_audit_event(p_project_id, NULL, NULL,
    'deploy_host_apply_started'::audit_event_enum,
    'system', 'host-deploy-agent',
    jsonb_build_object('desired_state_id', p_desired_state_id));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION record_apply_started FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_apply_started TO devloop_api;
```

#### Stored procedure `record_apply_heartbeat` (v10, for lifecycle "heartbeat")

```sql
CREATE OR REPLACE FUNCTION record_apply_heartbeat(
  p_desired_state_id uuid,
  p_project_id       uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE desired_state_history
     SET apply_last_heartbeat_at = now()
   WHERE id = p_desired_state_id
     AND project_id = p_project_id
     AND applied_status IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;  -- silent on missing row; heartbeats are best-effort
END;
$$;
REVOKE ALL ON FUNCTION record_apply_heartbeat FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_apply_heartbeat TO devloop_api;
```

#### Stored procedure `record_apply_timeout` (v10 — the missing timeout writer)

This is called by the verification scanner (running inside the **deployer worker**, which owns the verifying stage) when heartbeat staleness or total timeout is detected. Marks the row `timed_out` before any rollback flow begins.

```sql
CREATE OR REPLACE FUNCTION record_apply_timeout(
  p_desired_state_id uuid,
  p_project_id       uuid,
  p_reason           varchar(64)   -- 'heartbeat_stale' | 'total_timeout'
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated integer;
BEGIN
  -- Only transitions from "no final status yet" to "timed_out". Idempotent: if already timed_out,
  -- returns false and does not re-audit. If already success/failed, also returns false.
  UPDATE desired_state_history
     SET applied_status = 'timed_out',
         applied_at     = now(),
         applied_log_excerpt = concat('timeout: ', p_reason)
   WHERE id             = p_desired_state_id
     AND project_id     = p_project_id
     AND applied_status IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RETURN false; END IF;

  PERFORM append_audit_event(
    p_project_id, NULL, NULL,
    CASE WHEN p_reason = 'heartbeat_stale'
         THEN 'host_heartbeat_timeout'::audit_event_enum
         ELSE 'host_apply_timeout'::audit_event_enum
    END,
    'system', 'deployer-verification-scanner',
    jsonb_build_object('desired_state_id', p_desired_state_id, 'reason', p_reason)
  );
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION record_apply_timeout FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_apply_timeout TO devloop_dep;
```

#### NEW `project_configs`
```
id                    uuid PRIMARY KEY
project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
version_seq           bigint NOT NULL                      -- per-project monotonic
is_active             boolean NOT NULL DEFAULT false
classifier_rules      jsonb NOT NULL
agent_roles           jsonb NOT NULL
build_commands        jsonb NOT NULL
branch_naming_pattern varchar(255) NOT NULL
allowed_modules       text[] NOT NULL                      -- e.g., ['dialer','settings','leads','devloop']
locked_modules        text[] NOT NULL                      -- e.g., ['inbox']
created_at            timestamptz NOT NULL DEFAULT now()
created_by            uuid NOT NULL REFERENCES users(id)
UNIQUE (project_id, version_seq)
PARTIAL UNIQUE INDEX (project_id) WHERE is_active = true  -- only one active per project
```

A new config version is created via the admin UI. Activation deactivates the previous version. Running tasks record their `project_config_version` so their behavior is reproducible even if config changes mid-flight.

#### NEW `signing_keys`
```
key_id         varchar(64) PRIMARY KEY
algorithm      signing_algorithm_enum NOT NULL DEFAULT 'ed25519'
public_key     bytea NOT NULL
status         signing_key_status_enum NOT NULL   -- active | retired | revoked
created_at     timestamptz NOT NULL DEFAULT now()
retired_at     timestamptz NULL
```

**Only the public part lives in DB.** The private key lives on disk at `/etc/devloop/deploy_signing_priv_<key_id>` (path consistent with §4.3 table and §19 D9), mode 0440, owned `root:devloop-dep`, loaded via systemd `LoadCredential=deploy_signing_priv`. Only the deployer worker can access it. **This is the canonical and only storage location for the private key** — there is no encrypted-in-DB variant.

**Exactly one active key enforced in DB:**
```sql
CREATE UNIQUE INDEX idx_signing_keys_one_active
    ON signing_keys ((true))
    WHERE status = 'active';
```
This partial unique index allows only a single row to have `status = 'active'` at any time. Rotation must be done in a single transaction:

```sql
BEGIN;
  UPDATE signing_keys SET status = 'retired', retired_at = now() WHERE key_id = $old AND status = 'active';
  INSERT INTO signing_keys (key_id, algorithm, public_key, status) VALUES ($new, 'ed25519', $pubkey, 'active');
COMMIT;
```

Retired keys remain valid for verification against any in-flight `desired_state_history` records that reference them, until all hosts acknowledge the new key. Deploy agent policy files accept any trusted `key_id` listed locally, so rotation is a phased rollout.

#### `audit_events` append-only enforcement — explicit SQL

Three layers:

**Layer 1: role grants** (in migrations)
```sql
REVOKE ALL ON audit_events FROM devloop_api, devloop_orch, devloop_rev, devloop_dep, devloop_wm;
GRANT SELECT ON audit_events TO devloop_api, devloop_orch, devloop_rev, devloop_dep, devloop_wm;
-- No INSERT grant directly: all inserts go through append_audit_event() stored procedure
GRANT EXECUTE ON FUNCTION append_audit_event(...) TO devloop_api, devloop_orch, devloop_rev, devloop_dep, devloop_wm;
```

**Layer 2: explicit trigger defense**
```sql
CREATE OR REPLACE FUNCTION audit_events_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; use append_audit_event() to insert';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable_update
  BEFORE UPDATE ON audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_events_no_mutate();

CREATE TRIGGER audit_events_immutable_delete
  BEFORE DELETE ON audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_events_no_mutate();

CREATE TRIGGER audit_events_immutable_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_events_no_mutate();

-- Same triggers on audit_chain_head
CREATE TRIGGER audit_chain_head_immutable
  BEFORE DELETE OR TRUNCATE ON audit_chain_head
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_events_no_mutate();
-- UPDATE is allowed on audit_chain_head but only via the stored procedure below
```

**Layer 3: append stored procedure** (SECURITY DEFINER)
```sql
CREATE OR REPLACE FUNCTION append_audit_event(
  p_project_id      uuid,
  p_task_id         uuid,
  p_report_id       uuid,
  p_event_type      audit_event_enum,
  p_actor_kind      actor_kind_enum,
  p_actor_name      varchar(128),
  p_details         jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_id   bigint;
  v_prev_hash bytea;
  v_new_hash  bytea;
  v_new_id    bigint;
  v_payload   bytea;
BEGIN
  -- Serialize chain extension
  PERFORM pg_advisory_xact_lock(7331);

  SELECT last_event_id, last_hash INTO v_prev_id, v_prev_hash
    FROM audit_chain_head WHERE id = 1 FOR UPDATE;

  v_payload := convert_to(
    jsonb_build_object(
      'project_id', p_project_id,
      'task_id',    p_task_id,
      'report_id',  p_report_id,
      'event_type', p_event_type,
      'actor_kind', p_actor_kind,
      'actor_name', p_actor_name,
      'details',    p_details,
      'created_at', now()
    )::text,
    'UTF8'
  );

  v_new_hash := digest(v_prev_hash || v_payload, 'sha256');

  INSERT INTO audit_events
    (project_id, task_id, report_id, event_type, actor_kind, actor_name, details,
     chain_prev_id, chain_hash)
  VALUES
    (p_project_id, p_task_id, p_report_id, p_event_type, p_actor_kind, p_actor_name, p_details,
     v_prev_id, v_new_hash)
  RETURNING id INTO v_new_id;

  UPDATE audit_chain_head
     SET last_event_id = v_new_id,
         last_hash     = v_new_hash,
         updated_at    = now()
   WHERE id = 1;

  RETURN v_new_id;
END;
$$;
```

Application code can never insert into `audit_events` directly. All mutations go through this function, which holds the advisory lock and atomically advances the chain head. Application bugs cannot bypass chain integrity.

#### NEW `branch_protection_checks`
```
id                  uuid PRIMARY KEY
project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
checked_at          timestamptz NOT NULL DEFAULT now()
is_protected        boolean NOT NULL
required_checks     text[] NOT NULL
allow_force_push    boolean NOT NULL
required_reviews    int NOT NULL
bypass_allowed      boolean NOT NULL
raw_response        jsonb NOT NULL
compliance_pass     boolean NOT NULL
INDEX (project_id, checked_at DESC)
```

Compliance module runs this check at project registration (blocks if failing) and periodically (every 6 hours). Failure sets project to `status='paused'` and alerts.

#### `audit_events` — modifications from v2

Add strict enum for `event_type` (instead of varchar) with these values (exhaustive list):

```
report_received, report_triaged, report_status_changed, report_thread_added,
task_created, task_status_changed, task_blocked, task_unblocked,
lock_acquired, lock_renewed, lock_released, lock_fenced,
worker_spawned, worker_heartbeat, worker_exited, worker_killed_timeout,
review_started, review_completed, review_approved, review_changes_requested,
review_api_failure, review_stale_sha, review_quota_exceeded,
deploy_mutex_acquired, deploy_mutex_renewed, deploy_mutex_released,
deploy_started, deploy_pr_created, deploy_merge_blocked, deploy_ci_waiting, deploy_ci_passed,
deploy_ci_failed, deploy_merged, deploy_desired_state_written,
deploy_host_apply_started, deploy_host_apply_heartbeat,
deploy_host_applied, deploy_host_apply_failed,
deploy_host_apply_duplicate_or_missing, deploy_host_apply_late_after_timeout,
deploy_verified,
host_apply_timeout, host_heartbeat_timeout,
deploy_rollback_started, deploy_rolled_back, deploy_rollback_failed,
health_up, health_down, health_degraded, health_alert_sent,
user_login, user_login_failed, user_logout, user_2fa_enabled, user_2fa_failed,
project_registered, project_paused, project_archived, project_config_activated,
compliance_check_passed, compliance_check_failed,
host_token_rotated, deploy_token_rotated, signing_key_rotated,
audit_chain_verified, audit_chain_mismatch
```

**Note:** This is the complete and authoritative event type list. Any new event added to the codebase must be added here via migration before use. Procedures reference these values with type-checked enum casts (e.g., `'host_apply_timeout'::audit_event_enum`), so any drift is caught at call time.

### 4.3 Encryption at rest

**Canonical secret storage model — ONE model used uniformly:**

All runtime secrets are **files on disk**, mode `0440`, owned `root:<service-group>` with group read granted to the relevant service user. Loaded into each systemd service via `LoadCredential=<name>:/etc/devloop/<name>`.

| Secret | File path | Mode | Owner | Loaded by |
|---|---|---|---|---|
| JWT signing key | `/etc/devloop/jwt_secret` | 0440 | `root:devloop-api` | `devloop-api.service` |
| OpenAI API key | `/etc/devloop/openai_api_key` | 0440 | `root:devloop-rev` | `devloop-reviewer.service` |
| Anthropic API key | `/etc/devloop/anthropic_api_key` | 0440 | `root:devloop-wm` | `devloop-worker-manager.service` |
| GitHub App deploy key (write) | `/etc/devloop/github_app_key` | 0440 | `root:devloop-dep` | `devloop-deployer.service` |
| GitHub App compliance key (read-only) | `/etc/devloop/github_app_compliance_key` | 0440 | `root:devloop-api` | `devloop-api.service` |
| Deploy signing private key | `/etc/devloop/deploy_signing_priv_<key_id>` | 0440 | `root:devloop-dep` | `devloop-deployer.service` |
| Deploy signing active key ID marker | `/etc/devloop/deploy_signing_active_key_id` | 0440 | `root:devloop-dep` | `devloop-deployer.service` |
| Data encryption key (for `users.two_factor_secret`) | `/etc/devloop/data_encryption_key` | 0440 | `root:devloop-api` | `devloop-api.service` |

**There is no database-level secret encryption layer.** The `signing_keys` table stores only public keys. 2FA secrets in `users.two_factor_secret` are encrypted using a key loaded via `LoadCredential=data_encryption_key` (file at `/etc/devloop/data_encryption_key`, group read by `devloop-api`), which is the single exception — `users.two_factor_secret` is encrypted in DB because it must survive restore operations and lives alongside user data.

**Key rotation is manual**, documented in RUNBOOK.md. Each rotation:
1. Generate new key material out-of-band
2. Write new file to disk with correct permissions
3. `systemctl reload` or `systemctl restart` the consuming service so it picks up the new credential
4. Remove old file (`shred`)
5. For `signing_keys` specifically, follow the in-DB rotation protocol (§5.4) in parallel so the `signing_keys` table reflects the active `key_id`.

This design rejects the v2 ambiguity about "encrypted in DB with rotation re-encryption paths." It is deliberately simpler: file on disk, strict permissions, systemd LoadCredential, manual rotation. The simplicity is the security property.

---

## 5. Authentication and Authorization

(Unchanged from v2 §5 except these items that were raised in round 2 feedback.)

### 5.1 Browser
- Argon2id passwords, stateful sessions, 2FA mandatory for `super_admin` + `admin`, failed-login lockout, Argon2 params: `memoryCost=65536, timeCost=3, parallelism=4`

### 5.2 Host token
- Format `<id:32>.<secret:48>`. HMAC verification with constant-time compare, stored as HMAC digest
- Read from file on host side (not env)

### 5.3 Deploy token
- Same format, separate scope (read own desired state, write own apply status)

### 5.4 Deploy signing (single global key)

- **One active `signing_key_id` at a time**, e.g., `central-2026-04`
- Canonical private key file path: `/etc/devloop/deploy_signing_priv_<key_id>`, mode `0440`, owner `root:devloop-dep`, loaded via systemd `LoadCredential=deploy_signing_priv`. The currently-active key_id is recorded in `/etc/devloop/deploy_signing_active_key_id` (mode 0440, owner `root:devloop-dep`) so the deployer knows which file to load. Path is consistent across the document.
- Public key published to every deploy agent's policy file at project registration
- **Canonicalization:** All signed payloads use **RFC 8785 JSON Canonicalization Scheme (JCS)**. The deployer computes JCS bytes from a fixed-field JSON object `{id, project_id, seq_no, deploy_sha, base_sha, action, target_branch, signing_key_id, issued_at}`, signs the bytes with Ed25519, and stores the **exact signed bytes** in `desired_state_history.signed_bytes` (not jsonb — raw bytea). The host is served the exact bytes verbatim and verifies the signature without re-canonicalizing.
- **Rotation protocol** (matches the partial unique index constraint exactly):
  1. Generate new keypair out-of-band for key_id `central-2026-10`
  2. Distribute the **new public key** to each host via manual out-of-band channel (Jonas updates each host's `policy.yml` to trust both the old and new key_id)
  3. After all hosts acknowledge (tracked via central UI or manual check), open a single transaction:
     ```sql
     BEGIN;
     UPDATE signing_keys SET status='retired', retired_at=now() WHERE key_id='central-2026-04' AND status='active';
     INSERT INTO signing_keys (key_id, algorithm, public_key, status) VALUES ('central-2026-10', 'ed25519', :pubkey, 'active');
     COMMIT;
     ```
     Order is: retire first, then insert new active. This respects the `CREATE UNIQUE INDEX idx_signing_keys_one_active ... WHERE status='active'` constraint at every instant during the transaction.
  4. Install the new private key file at `/etc/devloop/deploy_signing_priv_central-2026-10`, update `/etc/devloop/deploy_signing_active_key_id` to `central-2026-10`, `systemctl restart devloop-deployer.service`
  5. After all in-flight desired_state records with the old key_id have been applied and verified, remove old trust from host policies (manual Jonas action), and remove the old private key file
- **Deploy agents only trust key IDs listed in their local `policy.yml`.** Out-of-band pubkey distribution is the separation of authority: a compromised central cannot push a new signing key to a host, because the host will not accept it until Jonas has manually updated the host's policy.

### 5.5 GitHub auth

- **GitHub App preferred**; install per-project via admin UI OAuth flow; installation tokens minted on demand (short-lived, 1h)
- **Fallback:** fine-grained PAT scoped to single repo with required permissions only (`contents: write`, `pull_requests: write`, `actions: read`, `metadata: read`)
- **Canonical private key storage:** file on disk at `/etc/devloop/github_app_key` (mode 0440, owned `root:devloop-dep`), loaded only by deployer via systemd `LoadCredential=github_app_key`. **Not in DB, not encrypted, not duplicated.** The disk file with strict permissions plus systemd credential loading IS the storage model.
- **Separate compliance key:** The Public API has a **separate** GitHub App key (or fine-grained PAT) at `/etc/devloop/github_app_compliance_key`, owned by root with group `devloop-api`. This key has **read-only** permissions (`metadata: read`, `administration: read`) — it CAN read branch protection configuration but CANNOT modify code. The deployer cannot access this key, and the API cannot access the deployer's key. This is a clean identity separation.
- **Key rotation**: new key generated, installed to disk via out-of-band provisioning, systemd reloads the credential, old key file is removed. Cannot be automated from within central (by design — key rotation requires human action).

### 5.6 Host-side GitHub credentials (NEW)

The host's deploy agent needs to fetch the exact merged SHA from GitHub. For private repos, this requires credentials. Options:

- **Deploy key (preferred for simplicity):** SSH key registered on the host repo as a read-only deploy key. Stored at `/etc/devloop-deploy-agent/github-key`, mode 0400, owner `devloop-deployer`. Per-host, rotatable independently of central.
- **GitHub App installation token:** Deploy agent gets its own small App installation with `contents: read` scope. More complex to set up but more auditable.

**v1 choice:** Deploy key. Simple, works, explicit per-host. App installation path added in a later phase if we want per-host attribution in GitHub audit logs.

---

## 6. State Machines

### 6.1 Report status
(Unchanged from v2 §6.1. Postgres enum. Transitions enforced in code.)

### 6.2 Task status

Updated enum and transitions:

```
queued_for_lock
assigned        (must hold module lock)
in_progress     (must hold module lock)
review          (does NOT hold module lock necessarily — see §6.2.1)
changes_requested
approved
deploying
merged
verifying
verified
rolling_back
rolled_back
rollback_failed
blocked
cancelled
failed
```

**Key invariant:** `status IN ('assigned', 'in_progress')` ⇒ task currently holds `module_locks` for its `(project_id, module)`.

For `review`, `changes_requested`, `approved`, `deploying`, `merged`, `verifying`, `rolling_back`, and terminal states, **the module lock may or may not still be held** depending on whether we want to block concurrent work on the same module during review. The design decision:

- **v1 choice:** Module lock is held through `review` and released when task moves to any terminal or rollback state. This prevents two tasks racing on the same module while one is still in review.
- Lock is **extended** (renewal of `expires_at`) by the reviewer heartbeat (a job-side heartbeat in the `reviewer` queue), not by worker heartbeat.
- If `changes_requested`: task moves back to `queued_for_lock` if the lock was somehow released (shouldn't happen in normal flow; safety net), otherwise stays in `changes_requested` until worker re-spawns.

#### 6.2.1 Transitions with lock implications

| From | To | Lock action |
|---|---|---|
| (created by orchestrator with lock held) | `assigned` | holds lock |
| (created by orchestrator, lock busy) | `queued_for_lock` | does not hold lock |
| `queued_for_lock` → `assigned` | lock acquired atomically in same transaction | now holds lock |
| `assigned` → `in_progress` | no change | holds |
| `in_progress` → `review` | no change | holds |
| `in_progress` → `blocked` | **releases lock** | no longer holds |
| `in_progress` → `failed` | **releases lock** | no longer holds |
| `review` → `approved` | no change | holds |
| `review` → `changes_requested` | no change | holds |
| `review` → `blocked` | **releases lock** | no longer holds |
| `changes_requested` → `assigned` | `fence_and_transition()` atomically clears `worker_id`, `worker_handle`, `started_at`, `heartbeat_at` in the same UPDATE, resets `lease_version`, and re-verifies lock ownership. If lock still held → `assigned` (ready for re-spawn); if lock lost → `queued_for_lock`. | holds or requeues |
| `approved` → `deploying` | no change | holds |
| `deploying` → `merged` | no change | holds |
| `merged` → `verifying` | no change | holds |
| `verifying` → `verified` | **releases lock** (terminal success) | no longer holds |
| `verifying` → `rolling_back` | no change | holds |
| `rolling_back` → `rolled_back` | **releases lock** (terminal) | no longer holds |
| `rolling_back` → `rollback_failed` | **RETAINS lock** (terminal, paged, manual recovery required) | still holds until manual `devloop recovery clear-task` |

**Additional deploy-stage transitions (v8, explicit in transition table):**

| From | To | Trigger | Lock / Mutex |
|---|---|---|---|
| `deploying` → `review` | Stale SHA on agent branch OR default branch advanced during review | Deployer (fenced) | Lock retained; mutex released |
| `deploying` → `failed` | CI failed OR branch protection degraded OR PR closed-without-merge OR retry_count exhausted | Deployer (fenced) | Lock released; mutex released |
| `deploying` → `merged` | **Recovery repair transition**: used when `merged_commit_sha IS NOT NULL` on resume (prior attempt merged on GitHub but DB commit failed before transition). Deployer calls `fence_and_transition(task_id, lease, 'deploying', 'merged', payload)`. Idempotent. | Deployer (fenced) | Lock retained; mutex retained |
| `deploying` → `rolling_back` | Post-merge host apply failure case, per §7.5 step 9 | Deployer (fenced) | Lock retained; mutex retained |
| `merged` → `failed` | Unrecoverable DB inconsistency detected at resume | Deployer (fenced) | Lock released; mutex released |
| `blocked` → `queued_for_lock` | no lock held → queue for reacquire | no change |
| any non-terminal → `cancelled` | **releases lock** | no longer holds |

The lock-release action is performed **inside the same transaction** as the state transition, fenced by `lease_version`.

### 6.3 Heartbeat and lease ownership (unified across stages)

**Design principle:** `agent_tasks.lease_version` is **only incremented on ownership changes and status transitions**, never on ordinary heartbeats. This keeps the caller's in-memory lease version stable for the duration of a stage, so heartbeats don't cause self-fencing.

**Two separate stored procedures:**

```sql
-- refresh_task: ordinary heartbeat. Does NOT change lease_version.
-- Updates only heartbeat_at and renews the associated module lock.
CREATE OR REPLACE FUNCTION refresh_task(
  p_task_id         uuid,
  p_expected_lease  bigint,
  p_expected_status task_status_enum
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_project_id uuid;
  v_module     varchar;
  v_updated    integer;
BEGIN
  -- Verify ownership via lease and status; update heartbeat_at ONLY; do not bump lease
  UPDATE agent_tasks
     SET heartbeat_at = now()
   WHERE id            = p_task_id
     AND lease_version = p_expected_lease
     AND status        = p_expected_status
  RETURNING project_id, module INTO v_project_id, v_module;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;  -- fenced or wrong status; caller should abort
  END IF;

  -- Renew the associated module lock; require exactly 1 row updated
  UPDATE module_locks
     SET expires_at = now() + interval '15 minutes'
   WHERE project_id    = v_project_id
     AND module        = v_module
     AND holder_task_id = p_task_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated != 1 THEN
    -- Lock is no longer held by us. This is a lost-lock situation.
    -- Fence the task by incrementing its lease so subsequent writes fail.
    UPDATE agent_tasks SET lease_version = lease_version + 1 WHERE id = p_task_id;
    RETURN false;
  END IF;

  RETURN true;
END;
$$;
```

```sql
-- fence_and_transition: the ONLY function that increments lease_version.
-- Used for state transitions and for janitor-initiated reassignments.
-- This is called by TaskStateService.transition() under the hood.
CREATE OR REPLACE FUNCTION fence_and_transition(
  p_task_id         uuid,
  p_expected_lease  bigint,
  p_from_status     task_status_enum,
  p_to_status       task_status_enum,
  p_payload         jsonb
) RETURNS bigint  -- returns new lease_version, or NULL if fenced
LANGUAGE plpgsql AS $$
-- implementation enforces valid (from, to) pairs per the transition table,
-- applies lock/mutex release per §19 Decision D5/D6,
-- emits audit event via append_audit_event()
$$;
```

**Heartbeat loop convention:**

```pseudo
current_lease = initial_lease_from_transition;
loop every 60 seconds:
  ok = refresh_task(task_id, current_lease, expected_status);
  if not ok:
    abort worker/stage;  # fenced or lost lock
    break;
  # current_lease is unchanged; heartbeat did not bump it
  # current_lease changes only when we call fence_and_transition() for a real state change
```

**When lease_version changes:**
- `fence_and_transition()` — normal status transitions
- Janitor reclaiming a stale task — janitor calls `fence_and_transition()` to force a transition (e.g., `in_progress → failed` with reason `worker_stale`), bumping the lease
- Both deploy mutex and module lock renewals update their own lease_version fields independently of `agent_tasks.lease_version`

**Ownership by stage (who is responsible for calling `refresh_task()` every 60s):**

| Stage | Owner component | Notes |
|---|---|---|
| `assigned` | orchestrator | Orchestrator keeps this stage's lock alive until the worker manager claims it. If WM is down for > 5 min, janitor transitions task to `failed` with reason `spawn_timeout` (lock released). |
| `in_progress` | worker manager | During active Claude execution |
| `review` | reviewer worker | Reviewer renews for the duration of the OpenAI API call plus any retry window |
| `approved` | deployer worker | Deployer claims the job and begins renewing immediately on claim. If no deployer claims within 5 min, janitor transitions task to `blocked` with reason `deployer_backlog` (lock retained — task is recoverable by restarting deployer). |
| `deploying` | deployer worker | During CI polling (can take 20 min) |
| `merged` | deployer worker | Brief stage, usually <10s |
| `verifying` | deployer worker | During host apply wait (up to configurable `host_apply_timeout_seconds`, default 1200 = 20 min) |
| `rolling_back` | deployer worker | During CI + host apply of revert |

**Stale detection (janitor, every 30s):**

```sql
SELECT id, lease_version, status FROM agent_tasks
 WHERE status NOT IN ('verified', 'rolled_back', 'rollback_failed', 'failed', 'cancelled', 'queued_for_lock', 'blocked')
   AND heartbeat_at < now() - interval '4 minutes';
```

For each returned task: increment `lease_version` (fencing), and based on stage-specific policy:
- `in_progress` → transition to `failed` with reason `worker_stale`, release lock
- `review` / `deploying` / `merged` / `verifying` / `rolling_back` → the current stage owner is assumed dead; the stage's `jobs.lease_until` should also have expired. The `agent_tasks.status` is NOT transitioned by janitor directly; instead the job is requeued, and the fresh stage owner resumes from the DB checkpoint per §7.5 canonical recovery rule.

**Key point:** the task status is kept stable during crashes; fencing prevents stale writes from the original holder; resume is driven by job queue reclaim, not by status transitions from the janitor.

**Stage liveness separate from task liveness:**
- `agent_tasks.heartbeat_at` — unified task-level heartbeat (owned by current stage component)
- `jobs.lease_until` — job-level lease for the specific stage (orchestrator/reviewer/deployer queues)

These are related but distinct: task heartbeat is for "is the task making progress?", job lease is for "has this job been abandoned in the queue?". Both must be healthy for a stage to be considered live.

### 6.4 Canonical state transition SQL

All status mutations go through a single `TaskStateService.transition(task_id, from_state, to_state, expected_lease, payload)` which:

1. Validates (from, to) is in the hardcoded transition table
2. Runs UPDATE with `WHERE id=$1 AND status=$from AND lease_version=$expected`
3. Applies lock release/acquire in the same transaction if required by the transition table
4. INSERTs corresponding audit event (via the audit chain lock procedure)
5. Emits NOTIFY on the relevant channel

Returns `{success, new_lease_version}` or `{stale: true}`. No mutations bypass this function.

---

## 7. Workflows

### 7.1 Report intake
(Unchanged from v2 with token-from-file update.)

### 7.2 Orchestrator pickup

**Transaction isolation:** `REPEATABLE READ`. This prevents the config snapshot race where `classify_report` and the `project_config_id` lookup observe different rows under `READ COMMITTED`.

**Single SQL function** `orchestrate_task_for_report(report_id)` — called by orchestrator worker once per `reports` row in `status = 'new'`:

```sql
-- Caller opens transaction at REPEATABLE READ isolation
BEGIN ISOLATION LEVEL REPEATABLE READ;

-- 1. Load report with row lock
SELECT * INTO v_report FROM reports WHERE id = $report_id FOR UPDATE;

IF v_report.status != 'new' THEN
  -- Race: another orchestrator picked it. Commit and return.
  COMMIT;
  RETURN;
END IF;

-- 2. Load and lock the active project config in the SAME transaction.
-- FOR UPDATE to prevent activation of a new config mid-classification.
SELECT * INTO v_config
  FROM project_configs
 WHERE project_id = v_report.project_id AND is_active = true
 FOR UPDATE;

-- 3. Classify deterministically against v_config.classifier_rules
v_classification := classify_report_with_config(v_report, v_config);

-- 4. Handle locked modules
IF v_classification.locked_module THEN
  INSERT INTO agent_tasks (
    id, project_id, report_id, display_id,
    agent_name, module, risk_tier, status,
    project_config_id
  ) VALUES (
    gen_random_uuid(), v_report.project_id, v_report.id, v_report.display_id,
    v_classification.agent_name, v_classification.module, v_classification.risk_tier, 'blocked',
    v_config.id
  ) RETURNING id INTO v_task_id;

  INSERT INTO report_threads (report_id, author_kind, author_name, text)
  VALUES (v_report.id, 'system', 'orchestrator',
          'Module is locked. Manual Jonas approval required.');

  UPDATE reports SET status = 'triaged', updated_at = now() WHERE id = v_report.id;

  PERFORM append_audit_event(v_report.project_id, v_task_id, v_report.id,
                             'task_blocked', 'system', 'orchestrator',
                             jsonb_build_object('reason', 'locked_module', 'module', v_classification.module));
  COMMIT;
  RETURN;
END IF;

-- 5. Try to acquire module lock
INSERT INTO module_locks (project_id, module, holder_task_id, holder_worker_id,
                          acquired_at, expires_at, lease_version)
VALUES (v_report.project_id, v_classification.module, NULL, NULL,
        now(), now() + interval '15 minutes', 1)
ON CONFLICT (project_id, module) DO UPDATE
  SET holder_task_id = NULL,  -- placeholder, set after task insert
      holder_worker_id = NULL,
      acquired_at = now(),
      expires_at = now() + interval '15 minutes',
      lease_version = module_locks.lease_version + 1
WHERE module_locks.holder_task_id IS NULL
   OR module_locks.expires_at < now()
RETURNING lease_version INTO v_acquired_lease;

-- 6. Branching on lock acquisition result
IF v_acquired_lease IS NULL THEN
  -- Lock busy: create task in queued_for_lock. No IPC sent.
  -- The reconciler (§7.2.2) will retry lock acquisition periodically.
  INSERT INTO agent_tasks (
    id, project_id, report_id, display_id,
    agent_name, module, risk_tier, status, project_config_id
  ) VALUES (
    gen_random_uuid(), v_report.project_id, v_report.id, v_report.display_id,
    v_classification.agent_name, v_classification.module, v_classification.risk_tier,
    'queued_for_lock', v_config.id
  ) RETURNING id INTO v_task_id;

  UPDATE reports SET status = 'triaged', updated_at = now() WHERE id = v_report.id;

  PERFORM append_audit_event(v_report.project_id, v_task_id, v_report.id,
                             'task_created', 'system', 'orchestrator',
                             jsonb_build_object('status', 'queued_for_lock'));
  COMMIT;
  RETURN;
END IF;

-- 7. Lock acquired: create task as assigned
INSERT INTO agent_tasks (
  id, project_id, report_id, display_id,
  agent_name, module, risk_tier, status, project_config_id
) VALUES (
  gen_random_uuid(), v_report.project_id, v_report.id, v_report.display_id,
  v_classification.agent_name, v_classification.module, v_classification.risk_tier,
  'assigned', v_config.id
) RETURNING id INTO v_task_id;

-- 8. Update the lock row to point to this task
UPDATE module_locks
   SET holder_task_id = v_task_id
 WHERE project_id = v_report.project_id AND module = v_classification.module
   AND lease_version = v_acquired_lease;

UPDATE reports SET status = 'triaged', updated_at = now() WHERE id = v_report.id;

PERFORM append_audit_event(v_report.project_id, v_task_id, v_report.id,
                           'task_created', 'system', 'orchestrator',
                           jsonb_build_object('status', 'assigned'));
PERFORM append_audit_event(v_report.project_id, v_task_id, v_report.id,
                           'lock_acquired', 'system', 'orchestrator',
                           jsonb_build_object('module', v_classification.module));

COMMIT;
```

**After the transaction commits successfully**, the orchestrator process (in application code, not SQL) sends an `IPC spawn` message to worker manager over `/run/devloop/wm.sock` containing the new `task_id`. If the IPC fails (worker manager down, socket error): no action is taken at this point — the safety-net reconciler in §7.2.1 will retry.

### 7.2.1 Safety-net reconciler (orchestrator)

Runs as a periodic loop inside the orchestrator worker, every **10 seconds**:

**(a) Assigned-but-not-picked-up scanner:**
```sql
SELECT id FROM agent_tasks
 WHERE status = 'assigned'
   AND worker_id IS NULL
   AND created_at < now() - interval '30 seconds'
 ORDER BY created_at
 LIMIT 20;
```
For each returned task: re-send IPC spawn to worker manager.

**(b) Stale worker heartbeat scanner:**
```sql
SELECT id, lease_version FROM agent_tasks
 WHERE status = 'in_progress'
   AND heartbeat_at < now() - interval '4 minutes';
```
For each: call `TaskStateService.transition()` to move task to `failed` with `reason='worker_stale'`, fenced by `lease_version`. Lock is released as part of the transition.

**(c) `queued_for_lock` reconciler:**
```sql
SELECT id, project_id, module, lease_version FROM agent_tasks
 WHERE status = 'queued_for_lock'
 ORDER BY created_at   -- oldest first for fairness
 LIMIT 20;
```
For each: attempt atomic lock acquisition. If successful, transition the task to `assigned` in the same transaction (fenced), send IPC spawn. If still busy, leave alone for next iteration.

**(d) Stale deploy mutex:**
```sql
SELECT project_id, lease_version FROM deploy_mutex WHERE expires_at < now();
```
Clear any expired rows.

This reconciler is the durability backstop for the orchestration path. NOTIFY is only an optimization.

### 7.2.2 Classification

Deterministic. No AI. Uses `v_config.classifier_rules` from the transaction in §7.2.

### 7.2.1 Classification

Deterministic. No AI. Uses `project_configs.classifier_rules` for the active config of the report's project.

### 7.3 Worker execution

On receipt of `spawn` IPC from orchestrator via `/run/devloop/wm.sock`:

1. **Atomic worker claim (first thing done) — via stored procedure, not direct SQL:**

   WM calls `claim_assigned_task(task_id, worker_id, worker_handle)` (SECURITY DEFINER, granted to `devloop_wm` per §19 D26). The procedure performs the fenced update:

   ```sql
   CREATE OR REPLACE FUNCTION claim_assigned_task(
     p_task_id       uuid,
     p_worker_id     varchar,
     p_worker_handle varchar
   ) RETURNS TABLE(lease_version bigint, agent_name varchar, module varchar, project_id uuid, display_id varchar)
   LANGUAGE plpgsql SECURITY DEFINER AS $$
   BEGIN
     RETURN QUERY
       UPDATE agent_tasks
          SET status        = 'in_progress',
              worker_id     = p_worker_id,
              worker_handle = p_worker_handle,
              started_at    = now(),
              heartbeat_at  = now(),
              lease_version = agent_tasks.lease_version + 1
        WHERE id            = p_task_id
          AND status        = 'assigned'
          AND worker_id     IS NULL
        RETURNING agent_tasks.lease_version, agent_tasks.agent_name, agent_tasks.module,
                  agent_tasks.project_id, agent_tasks.display_id;
   END;
   $$;
   ```

   If empty resultset: **abort**. This is a duplicate spawn request (another WM claimed it, reconciler fired twice, or the task moved state concurrently). No filesystem work is done. Log and return. The WM has no direct UPDATE privilege on `agent_tasks` per §19 D26 — this procedure is the only path.

2. If claim succeeded: proceed with worktree setup, sandbox bring-up, and Claude spawning per §3.2. All subsequent mutations (heartbeats, state transitions) use fenced `lease_version`.

3. Heartbeat loop: call `heartbeat_task(task_id, current_lease, 'in_progress')` every 60s while Claude is running. If the call returns `false` (fenced), the worker manager aborts: sends SIGKILL to the bwrap process, tears down the worktree, and exits without writing further to the task row.

4. On Claude exit (successful):
   - Inspect worktree: `git status` and `git log <base>..HEAD` in the worktree
   - Validate commits exist and build passes
   - **Handoff via git bundle (v9/v10 canonical model, §19 D26 handoff-dir):**
     - After verifying build passes, WM produces a git bundle artifact containing the new commits:
       `git -C /var/devloop/worktrees/<task_id>/workspace bundle create /var/devloop/handoff/<task_id>.bundle origin/<default_branch>..HEAD`
     - The bundle captures commits from the default-branch base (known at spawn time) up to the current worktree HEAD — **does NOT depend on `approved_base_sha`** which is only set later at review approval.
     - `chown devloop-worker:devloop-fs /var/devloop/handoff/<task_id>.bundle && chmod 0640 ...`
     - Deployer (member of `devloop-fs` per §11) reads the bundle at the start of the `deploying` stage. WM has **no GitHub credentials** and does not push.
   - Call `fence_and_transition(task_id, current_lease, 'in_progress', 'review', {})` to move the task to review.
   - WM's responsibility ends here. No GitHub calls.

5. On Claude exit (failure):
   - `TaskStateService.transition(task_id, 'in_progress', 'failed', current_lease, {reason, exit_code})`
   - Fenced; if fenced, worker manager's responsibility is discharged.

6. Cleanup (three distinct phases):
   - **Phase 1 — Immediately after sandbox (bwrap) exits, regardless of exit code:** `shred -u /var/devloop/worktrees/<task_id>/cred/anthropic-key && rmdir /var/devloop/worktrees/<task_id>/cred`. The Anthropic credential exists only for the duration of the sandbox invocation and is destroyed as soon as Claude exits — NOT at task terminal state, because the task may still be in review/deploy stages while another task (re-spawn after `changes_requested`) could try to touch the old credential dir. Performed by devloop-wm (which is in `devloop-fs` group per §11 and thus has permission).
   - **Phase 2 — Delayed worktree cleanup, 24 hours after task terminal state:** a `devloop-worktree-cleanup.timer` systemd unit, owned by `devloop-wm`, runs:
     ```
     git worktree remove --force /var/devloop/worktrees/<task_id>/workspace
     rm -rf /var/devloop/worktrees/<task_id>
     ```
     Retained for 24h to give Jonas a debugging window.
   - **Phase 3 — Weekly:** `git worktree prune` run on every `/var/devloop/projects/<slug>/main/` bare mirror by a weekly cron unit.

**Clarification on git push:** The deployer worker is the only component with GitHub write credentials. It reads the **git bundle artifact** produced by WM from `/var/devloop/handoff/<task_id>.bundle`, unbundles it into its own per-task clone at `/var/devloop/deployer/<task_id>/`, and pushes `devloop/task/<task_id>` to `origin`. Worker manager does not touch GitHub and does not share a bare mirror with the deployer. See §7.5 step 4 for the full deployer publication flow.

**IPC idempotency:** If orchestrator's reconciler resends `spawn` IPC for a task that's already `in_progress` (because the worker manager's status response was lost), the atomic claim in step 1 returns 0 rows and the WM no-ops. No duplicate sandboxes.

### 7.4 Reviewer execution
(Unchanged from v2 conceptually; quota reservation uses the split tables.)

### 7.5 Deployer execution (canonical path)

**One authoritative flow. One recovery rule. Used by both §7.5 and §8.**

**Canonical recovery rule (applies to all stages):**
- On deployer crash or lost lease: the `jobs.deployer` row's lease expires → janitor requeues it → deployer reclaims it → resumes from the last persisted DB checkpoint.
- Task status remains in its current state (`deploying`, `verifying`, `rolling_back`) during the crash; it is **not** moved to `failed` on crash.
- Task transitions to `failed` **only** when either:
  - `retry_count >= max_retries` (default 3), OR
  - An unrecoverable inconsistency is detected (e.g., `merged_commit_sha` was persisted, but GitHub now shows a different commit on the default branch).
- Deploy mutex holder crash: janitor clears the mutex row if `expires_at < now()`; the task still holds the mutex conceptually because it remains in `deploying`/`verifying`/`rolling_back` and will re-acquire on next resume. To avoid a gap window, deploy mutex acquisition uses the same "upsert-or-grab-if-expired" pattern as module locks, and the deployer refreshes the mutex expiry on heartbeats.

**Flow:**

1. Deployer claims approved task from `jobs.deployer` queue (with lease). Retry accounting: `retry_count` is incremented by `fence_and_transition()` calls when they cause a retry-able state change; it is NOT incremented per job claim. (This simplifies the earlier design that referenced a non-existent `retry_count_last_incremented_at` field.)

2. **Atomic admission to `deploying`:** Call `fence_and_transition(task_id, expected_lease, 'approved', 'deploying', payload)`. This stored procedure performs ALL of the following in a single DB transaction:
   a. Validates the `(from, to)` pair is in the transition table.
   b. Checks the DB unique index `idx_agent_tasks_one_deploy_per_project` — if violated (another task already in a deploy-stage status for this project, including `rollback_failed`), the transaction fails and returns `{error: 'deploy_slot_busy'}`. The deployer requeues the job with delay.
   c. Acquires the `deploy_mutex` row via the same upsert pattern as module locks, fenced by mutex `lease_version`. If the mutex is held by another active deployer, transaction fails and returns `{error: 'mutex_held'}`.
   d. If both pass: the task row is updated to `status='deploying'`, mutex row is claimed, audit events are inserted.
   e. Returns the new task `lease_version`.

   **This is the atomic admission gate.** The task cannot be in `deploying` without also holding the mutex, and vice versa. A second task cannot sneak in.

3. (Merged into step 2 above.)

4. **Deployer is the sole publisher of the agent branch (§9 C1 — committed model).**

   **Handoff from worker manager to deployer uses a git bundle**, not a shared bare mirror or WM push:
   - At the end of WM's `in_progress` stage (when transitioning task to `review`), WM runs `git bundle create /var/devloop/handoff/<task_id>.bundle <approved_base_sha>..HEAD` inside its worktree.
   - The bundle file is chowned `devloop-worker:devloop-fs` mode `0640` so deployer (member of `devloop-fs` per §11) can read it.
   - WM has **no GitHub write credentials**. There is no `github_wm_push_key`.

   **Deployer reads the bundle and publishes:**
   - Deployer has its own per-task clone at `/var/devloop/deployer/<task_id>/` (owned `devloop-dep:devloop-dep`, mode `0750`), cloned fresh from `origin` at the start of the deploying stage.
   - Deployer runs `git -C /var/devloop/deployer/<task_id> bundle verify /var/devloop/handoff/<task_id>.bundle` to verify the bundle is well-formed.
   - Deployer runs `git -C /var/devloop/deployer/<task_id> fetch /var/devloop/handoff/<task_id>.bundle refs/heads/*:refs/devloop-bundle/*` to extract the commits.
   - Deployer then creates the local branch `devloop/task/<task_id>` from the extracted SHA.
   - Deployer verifies the SHA equals `approved_head_sha` (stored at review time). If mismatch: abort with `review_stale_sha`.
   - Deployer pushes: `git push origin devloop/task/<task_id>:devloop/task/<task_id>` using its GitHub App installation token.
   - Persist `agent_branch_published_at = now()` on `agent_tasks` as a checkpoint.
   - On crash between push and persist: next resume reads `git ls-remote origin devloop/task/<task_id>` and sees the ref already exists with the expected SHA — skip push, persist checkpoint, continue.

   **This is the sole path from worker output to GitHub.** No other component has GitHub write access.

5. **Live freshness checks:**
   - `git ls-remote origin devloop/task/<task_id>` → expect `approved_head_sha`
   - `git ls-remote origin <default_branch>` → expect `approved_base_sha`
   - If mismatch on either: release mutex, transition task to `review` via fenced transition, audit `review_stale_sha`, end.

4. **Live branch-protection check** (not cached): call GitHub API to verify branch protection is still configured correctly. **Short-circuit:** if the last `branch_protection_checks` row for this project is `< 5 minutes old` AND `compliance_pass = true`, accept the cached result. Otherwise perform a live call. If live call fails or protection has degraded: release mutex, task → `failed`, audit `compliance_check_failed`, end.

6. **Create PR via GitHub App:**
   - **Idempotent lookup first:** if `agent_tasks.github_pr_number` is NOT NULL, fetch the PR by that number and verify its head matches `devloop/task/<task_id>`. If yes: reuse it, skip to next step.
   - **Recovery lookup** (handles "API call succeeded, DB write failed" gap): if `github_pr_number` is NULL, query GitHub for open PRs with `head=<owner>:devloop/task/<task_id>` via `GET /repos/<owner>/<repo>/pulls?head=<owner>:devloop/task/<task_id>&state=open`. If one is found: persist its number to `agent_tasks.github_pr_number` and reuse. This prevents duplicate PRs on crash-between-call-and-commit.
   - **New creation** (only if recovery lookup returned nothing): `POST /repos/.../pulls` with `head=devloop/task/<task_id>`, `base=<default_branch>`, `title=DevLoop: <report.display_id>`, `body=<task context>`. Persist the returned PR number to `agent_tasks.github_pr_number` in the same transaction as emitting `deploy_pr_created` audit event.

6. **Wait for required CI checks:** poll every 10s, max 20 min. Deploy mutex is refreshed every 60s during this wait.
   - Crash during wait: on resume, read `github_pr_number`, resume polling. No side effect lost.
   - If CI fails: close PR, release mutex, task → `failed`, audit `deploy_ci_failed`, end.

7. **Merge** (crash-idempotent):
   - **Idempotency gate 1:** If `agent_tasks.merged_commit_sha` is already set, skip all GitHub merge calls. Proceed to step 8.
   - **Idempotency gate 2:** Query PR state via `GET /repos/<owner>/<repo>/pulls/<number>`. Branch on `state` and `merged`:
     - If `merged === true`: the PR was already merged in a prior attempt whose DB commit failed. Extract `merge_commit_sha` from the PR object, persist it to `agent_tasks.merged_commit_sha` in a dedicated transaction, then proceed to step 8. **Do NOT call merge again.**
     - If `state === 'closed' && !merged`: the PR was closed without merging — abort, transition to `failed` with reason `pr_closed_without_merge`.
     - If `state === 'open' && mergeable === false`: conflict or other blocker — transition to `review` (requires re-review), audit `deploy_merge_blocked`.
     - If `state === 'open' && mergeable === true`: proceed to actual merge.
   - **Actual merge call** (only if PR is open and mergeable): `PUT /repos/.../pulls/<n>/merge?merge_method=squash` with `sha` parameter equal to the PR's current HEAD SHA (GitHub API's native idempotency check). Read the returned `sha` as `merged_commit_sha`.
   - **Persist `merged_commit_sha`** to `agent_tasks` in the same transaction as emitting `deploy_merged` audit event.
   - Transition task to `merged` via `fence_and_transition()`.

8. **Write `desired_state_history` row:**
   - Idempotency: if `agent_tasks.applied_desired_state_id` is already set, reuse it.
   - Otherwise: INSERT a new row with the next `seq_no` for this project, signed canonical payload including `id` (generated at insert time via `gen_random_uuid()` but pre-computed so it can be included in the signed payload), `project_id`, `seq_no`, `deploy_sha`, `base_sha`, `action`, `target_branch`, `signing_key_id`, `issued_at`. Sign with the active signing key's private material (loaded via LoadCredential, never logged). Persist the new row.
   - Set `agent_tasks.applied_desired_state_id` to the new row's `id`.
   - Transition task to `verifying`.

9. **Wait for host deploy agent to report back (with explicit lifecycle):**

   The host deploy agent posts lifecycle updates to central throughout the apply:
   - `POST .../desired-state/applied {desired_state_id, status: "started", started_at}` — at clone/build start
   - `POST .../desired-state/applied {desired_state_id, status: "heartbeat", timestamp}` — every 60 seconds during long operations
   - `POST .../desired-state/applied {desired_state_id, status: "success", applied_sha, log}` — on success
   - `POST .../desired-state/applied {desired_state_id, status: "failed", reason, log}` — on failure

   Central tracks `desired_state_history.apply_started_at`, `.apply_last_heartbeat_at`, and `.applied_status`.

   **Verification scanner** (runs every 10s):
   - Read `agent_tasks` in `verifying` joined to `desired_state_history` on `applied_desired_state_id`.
   - **Success case** (`applied_status = 'success'` AND `applied_sha = merged_commit_sha`): probe `/devloop-host/healthz` for 60s continuous `up`. If pass: transition task to `verified` (releases lock + mutex), audit `deploy_verified`.
   - **SHA mismatch** (`applied_sha != merged_commit_sha`): transition to `rollback_failed`, PAGE.
   - **Failure case** (`applied_status = 'failed'`): transition to `rolling_back`.
   - **Heartbeat stale** (`apply_last_heartbeat_at < now() - interval '180 seconds'` AND `applied_status NOT IN ('success','failed')`): the host agent is not responding. Transition to `rolling_back`, audit `host_heartbeat_timeout`. Set `applied_status = 'timed_out'` on the desired_state_history row atomically (via stored procedure) to prevent a late-arriving success from being accepted.
   - **Total timeout** (`now() > apply_started_at + project.host_apply_timeout_seconds`, default 1200 = 20 minutes): even with heartbeats, the whole apply must finish within the project's `host_apply_timeout_seconds`. On breach: same as heartbeat stale — transition to `rolling_back`, set `applied_status = 'timed_out'`.

   **Idempotency note:** `record_deploy_applied` stored procedure is updated (v8) to reject any `status='success'` update if `applied_status` has already been set to `timed_out`. A late-arriving success report from a host that recovered will be rejected with audit event `deploy_host_apply_late_after_timeout`. The task has already started rollback by that point; the rejection prevents the success from racing with the rollback.

10. **Rollback** (if entered from step 9):
    - Find the previous **successful** desired_state_history row for this project: `SELECT * FROM desired_state_history WHERE project_id=$1 AND applied_status='success' AND seq_no < $current_seq ORDER BY seq_no DESC LIMIT 1`.
    - **Deterministic revert branch** named `devloop/revert/<task_id>`. Same idempotent lookup pattern as step 6: check if the revert PR already exists before creating.
    - Create a revert PR via GitHub API's revert endpoint (or manually: create the revert branch off of default_branch, apply the inverse diff as a commit, push, open PR from `devloop/revert/<task_id>` to default_branch). Persist `rollback_pr_number`.
    - Wait for CI (same crash-safe pattern as step 6).
    - Merge the revert PR. Persist `rollback_commit_sha`.
    - Write a new `desired_state_history` row with `action='rollback'`, `deploy_sha = <previous_successful.deploy_sha>`, signed payload including the `id`.
    - Transition task to... still `rolling_back` (the rollback flow is active).
    - Wait for host to apply the rollback desired_state (same verification scanner mechanism as step 9).
    - On success: transition task to `rolled_back`, release mutex, release module lock, audit `deploy_rolled_back`.
    - On failure (any kind): transition task to `rollback_failed` via fenced transition, **RETAIN both module lock and deploy mutex** (per §19 Decision D5), PAGE Jonas immediately. Manual recovery via `devloop recovery clear-task <task_id>` is the only path forward.

**Checkpoint summary** (for crash recovery reads):
- `status='deploying'`, `github_pr_number` NULL → resume at step 5 (create PR)
- `status='deploying'`, `github_pr_number` set, `merged_commit_sha` NULL → resume at step 6 (CI wait)
- `status='merged'`, `applied_desired_state_id` NULL → resume at step 8 (write desired_state)
- `status='verifying'` → verification scanner picks it up from step 9
- `status='rolling_back'`, no `rollback_pr_number` → resume at step 10 (create revert PR)
- `status='rolling_back'`, `rollback_pr_number` set, no `rollback_commit_sha` → resume at step 10 CI wait
- `status='rolling_back'`, `rollback_commit_sha` set → resume at step 10 write desired_state

Each step checks for prior state before making API calls; side effects are always persisted before their successors.

### 7.6 Closer
Fold into `verifying → verified` transition (§7.5 step 9). No separate closer service. No auto-CHANGELOG commits.

### 7.7 Health monitoring
(Unchanged, but moved to Public API under `health-monitor` module per §3.1.2.)

---

## 8. Failure Modes and Recovery

**This table is strictly synced with §7.5 canonical recovery rule.** Any discrepancy between this table and §7.5 is a bug in the table, not §7.5.

**Canonical recovery rule (authoritative):**
- Crash at any stage → job lease expires → janitor requeues → stage component resumes from last DB checkpoint.
- Task status is **NOT** moved to `failed` on crash. It remains in its current state and the resumed stage continues.
- Task is moved to `failed` ONLY in these cases:
  (a) `retry_count >= max_retries` (default 3) — explicit retry exhaustion
  (b) An unrecoverable inconsistency is detected at resume time (e.g., `merged_commit_sha` persisted but GitHub reports a different commit on default branch)
  (c) The worker manager detects that a sandboxed Claude process is stale beyond timeout (`task_timeout`, default 1800s) — this is genuine execution failure, not a crash recovery case

| Failure | Detection | Recovery |
|---|---|---|
| Frontend crash | systemd restart | Stateless; users re-login. No data loss. |
| Public API crash | systemd restart | Stateless; reports in-flight may be retransmitted by host adapter (idempotency via `reports.display_id`) |
| Orchestrator worker crash | systemd restart | Jobs with stale `lease_until` returned to pending by janitor. Tasks in `queued_for_lock` picked up by §7.2.1 reconciler. No task → `failed`. |
| Reviewer worker crash | systemd restart | Reviewer job requeued via expired lease. Task stays in `review`. On resume, reviewer re-fetches the diff and restarts the API call (incurs OpenAI retry cost but is correct). Task → `failed` only on `review_attempts >= 3`. |
| Deployer worker crash | systemd restart | Deployer job requeued. Task stays in `deploying`/`merged`/`verifying`/`rolling_back`. On resume, deployer reads DB checkpoints and resumes from the last-persisted step (see §7.5 Checkpoint summary). Task → `failed` only on retry exhaustion or unrecoverable inconsistency. |
| Worker manager crash during spawn setup | systemd restart | Task stays in `assigned` with `worker_id IS NULL` (atomic claim UPDATE was not committed). Orchestrator reconciler re-sends spawn IPC after 30s. |
| Worker manager crash during sandbox execution | systemd restart | Task in `in_progress` with `worker_id` set. On WM startup: WM looks for its own `worker_id` in DB, any tasks claimed by old pid are fenced (`lease_version` increment, status → `failed`, reason `worker_manager_restart`). Orphaned bwrap processes killed by startup sweep. |
| Sandboxed Claude hangs beyond timeout | WM periodic check | SIGKILL bwrap; task → `failed` with reason `worker_timeout`; lock released; `retry_count` not incremented (this is task failure, not crash recovery) |
| Postgres listener disconnect | Reconnect with backoff; jobs table is source of truth | No data loss; §7.2.1 reconciler + job polling cover missed notifications |
| OpenAI / GitHub / Anthropic API down | Retries with backoff; quota reservation released on final failure | Per §19 D12/D22: retries within the stage's `retry_count` budget. On budget exhaustion: task → `failed` (NOT `blocked`). Stage does not auto-transition to `blocked` on API failures. |
| Egress proxy crash | systemd restart | Outbound calls from the sandboxed Claude fail temporarily; the in-flight task is retried on next spawn. Per §19 D15, reviewer/deployer outbound does not go through the egress proxy in v1 so this only affects sandboxed Claude. |
| Host deploy agent unreachable (no apply report by deadline) | Verification scanner sees `verifying` task with `applied_at IS NULL` beyond deadline | Task → `rolling_back`, audit `host_apply_timeout`, §7.5 step 10 |
| Host applied wrong SHA (`applied_sha != merged_commit_sha`) | Verification scanner SHA check | Task → `rollback_failed`, **module lock and deploy mutex RETAINED** (per §19 D5), PAGE (critical integrity violation) |
| Module lock holder crash | Expired `expires_at` on module_locks row | Lock acquire upsert pattern clears stale row on next acquisition attempt. Tasks in `queued_for_lock` retry via §7.2.1 reconciler. |
| Deploy mutex holder crash | Expired `expires_at` on deploy_mutex row, beyond 5-minute grace period | Janitor increments `lease_version` to fence the stale holder, clears the row. The held task remains in its current state; on resume, deployer re-acquires the mutex via upsert, fenced by `lease_version`. Task → `failed` only if retry_count exhausted. |
| Audit chain mismatch | Periodic `audit_chain_verify` job | PAGE; Sev-1; do not auto-repair |
| Postgres disk full | Monitoring | PAGE; DevLoop halts writes gracefully |
| Worktree disk full | Worker manager returns error | PAGE; new spawns refused until cleared |
| Branch protection accidentally removed on host repo | Compliance module (live check at deploy + periodic check) | Project status → `paused`; PAGE |
| Signing key compromised | Manual detection | Rotation protocol (§5.4); old key retired |
| Host token leaked | Manual detection | Admin rotates via UI |
| Deploy token leaked | Manual detection | Admin rotates via UI |
| Two deploys race on same project | `deploy_mutex` serialization | Second acquisition blocks (upsert returns 0 rows); deployer requeues with delay |
| Rollback itself fails | Deployer flow step 10 | Task → `rollback_failed`, PAGE, **module lock AND deploy mutex RETAINED** (per §19 D5). Manual recovery via `devloop recovery clear-task <task_id>` is the only release path. |

---

## 9. Observability
(Same as v2 §9. Plus the worker log redaction pipe and raw debug log described in §3.2.)

## 10. Cost controls
(Same as v2 §10 but using split `quota_usage_global` / `quota_usage_project` tables per §4.2.)

---

## 11. Process and Identity Layout (Production)

```
Linux users (created at install on central server):
  devloop-front    frontend process
  devloop-api      public API process
  devloop-orch     orchestrator worker
  devloop-rev      reviewer worker (has OPENAI_API_KEY)
  devloop-dep      deployer worker (has GITHUB_APP_KEY + SIGNING_KEY)
  devloop-wm       worker manager
  devloop-egress   egress proxy
  devloop-worker   sandboxed Claude execution uid (unprivileged, no login)

  devloop-admin    migration-only user, used by root via sudo for schema changes; peer-mapped to devloop_owner Postgres role

Linux groups:
  devloop-fs           members: devloop-orch, devloop-wm, devloop-worker, devloop-dep — shared filesystem access to /var/devloop/{projects,worktrees,handoff}. devloop-dep joins the group solely to read handoff bundles; it has no access to active worktrees.
  devloop-ipc          members: devloop-orch, devloop-wm — for /run/devloop/wm.sock
  devloop-egress-clients  members: devloop-rev, devloop-dep, devloop-worker, devloop-wm — for /run/devloop/egress.sock

Postgres roles (devloop DB):
  devloop_owner    schema owner, used only during migrations; LOGIN only via peer mapping from devloop-admin OS user
  devloop_api      narrow runtime privileges
  devloop_orch     orchestration DML
  devloop_rev      reviewer DML (column-level grants)
  devloop_dep      deployer DML (column-level grants)
  devloop_wm       worker manager DML (column-level grants)

Postgres pg_ident.conf mapping:
  # MAPNAME     SYSTEM-USERNAME  PG-USERNAME
  devloop_map   devloop-admin    devloop_owner
  devloop_map   devloop-api      devloop_api
  devloop_map   devloop-orch     devloop_orch
  devloop_map   devloop-rev      devloop_rev
  devloop_map   devloop-dep      devloop_dep
  devloop_map   devloop-wm       devloop_wm

Postgres pg_hba.conf:
  local   devloop   all   peer map=devloop_map

systemd units:
  devloop-frontend.service         User=devloop-front  loopback 3101  no secrets
  devloop-api.service              User=devloop-api    loopback 3100
    LoadCredential=jwt_secret, github_app_compliance_key, data_encryption_key
  devloop-orchestrator.service     User=devloop-orch   no HTTP        no external creds
  devloop-reviewer.service         User=devloop-rev    no HTTP        LoadCredential=openai_api_key
  devloop-deployer.service         User=devloop-dep    no HTTP
    LoadCredential=github_app_key, deploy_signing_priv, deploy_signing_active_key_id
  devloop-worker-manager.service   User=devloop-wm     no HTTP        LoadCredential=anthropic_api_key
  devloop-egress-proxy.service     User=devloop-egress UNIX socket    no external creds

  All units use:
    ProtectSystem=strict
    ProtectHome=true
    PrivateTmp=true
    NoNewPrivileges=true
    ReadWritePaths=<per-unit narrowed list under /var/devloop and /var/log/devloop and /run/devloop>
    RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6  (for api, rev, dep, egress-proxy — they need outbound)
    RestrictAddressFamilies=AF_UNIX only             (for front, orch, wm which have no outbound network)
    SystemCallFilter=@system-service
    MemoryMax per role

Filesystem (mode | owner:group | access rationale):

  /opt/devloop/                        0755 | root:root            source tree, read-only for everyone
  /opt/devloop/runtime/                0755 | root:root

  /var/devloop/                        0750 | devloop-orch:devloop-fs   traversal by all devloop-fs members
  /var/devloop/projects/               0750 | devloop-orch:devloop-fs
  /var/devloop/projects/<slug>/main/   0770 | devloop-orch:devloop-fs   devloop-wm can also read via group
  /var/devloop/worktrees/              0770 | devloop-wm:devloop-fs     devloop-wm creates, devloop-worker reads/writes per-task subdirs
  /var/devloop/worktrees/<task_id>/workspace/  0770 | devloop-worker:devloop-fs  (chowned by devloop-wm at spawn; devloop-fs group allows wm inspection+cleanup)
  /var/devloop/worktrees/<task_id>/cred/       0770 | devloop-worker:devloop-fs  (per-task anthropic key; group read/write so devloop-wm can shred after sandbox exit)
  /var/devloop/handoff/                0770 | devloop-wm:devloop-fs     (WM writes bundles here; deployer reads via group)
  /var/devloop/handoff/<task_id>.bundle 0640 | devloop-worker:devloop-fs  (written by WM on review transition; deleted after deployer consumes or 24h delayed cleanup)
  /var/devloop/deployer/               0750 | devloop-dep:devloop-dep   (deployer per-task clones, created fresh per task)
  /var/devloop/deployer/<task_id>/     0750 | devloop-dep:devloop-dep   deployer's own per-task clone (separate from wm worktree)
  /var/devloop/artifacts/              0750 | devloop-api:devloop-api
  /var/devloop/private/workers/        0700 | devloop-wm:devloop-wm    raw unredacted debug logs

  /var/log/devloop/                    0755 | root:root
  /var/log/devloop/workers/<id>.log    0640 | devloop-wm:devloop-fs    redacted, readable by operators

  /run/devloop/                        0750 | devloop-wm:devloop-ipc
  /run/devloop/wm.sock                 0660 | devloop-wm:devloop-ipc
  /run/devloop/egress.sock             0660 | devloop-egress:devloop-egress-clients

  /etc/devloop/                        0750 | root:root
  /etc/devloop/jwt_secret                       0440 | root:devloop-api
  /etc/devloop/openai_api_key                   0440 | root:devloop-rev
  /etc/devloop/anthropic_api_key                0440 | root:devloop-wm
  /etc/devloop/github_app_key                   0440 | root:devloop-dep
  /etc/devloop/github_app_compliance_key        0440 | root:devloop-api
  /etc/devloop/deploy_signing_priv_<key_id>     0440 | root:devloop-dep
  /etc/devloop/deploy_signing_active_key_id     0440 | root:devloop-dep
  /etc/devloop/data_encryption_key              0440 | root:devloop-api
  /etc/devloop/db_password                      0440 | root:devloop-admin  (only for migration user if not using peer auth)
```

**Secret permission clarification:** All secret source files are mode `0440`, owned `root:<service-group>`. Mode `0400` is NOT used — it contradicts "group read by service user." systemd `LoadCredential` reads these files while still root and passes them to the service unit via a memory-backed file in `$CREDENTIALS_DIRECTORY`. The group-read permission makes the credential readable by the service user IF needed directly (e.g., via an emergency debug tool), but the normal access path is `$CREDENTIALS_DIRECTORY`.

**Egress socket membership (key for sandboxed Claude):** `devloop-worker` is in `devloop-egress-clients` so the sandbox can connect to `/run/devloop/egress.sock` via the bind-mount. This is essential for Claude to reach `api.anthropic.com` through the allowlist proxy.

**Filesystem access for sandboxed worker:**
- `/var/devloop/worktrees/<task_id>/workspace/` is chowned `devloop-worker:devloop-fs` mode 0770 by `devloop-wm` at spawn time, giving the sandboxed process full read/write on its own workspace and allowing WM (member of `devloop-fs`) to inspect and clean up after exit.
- `/var/devloop/projects/<slug>/main/` is `devloop-orch:devloop-fs` mode 0770. `devloop-wm` is in `devloop-fs`, so it can run `git worktree add` inside the local reference clone.
- `/var/devloop/handoff/` holds git bundle artifacts produced by WM at the `in_progress → review` transition. Deployer (member of `devloop-fs`) reads them at the start of the `deploying` stage and deletes them after successful consumption.
- `/var/devloop/deployer/` holds the deployer's own per-task clones (independent of WM's worktrees). `devloop-dep:devloop-dep` mode 0750 — no cross-process sharing needed since deployer does not read from WM directories (only from the handoff bundle).
- **`devloop-dep` is a member of `devloop-fs`** so it can read the handoff bundles. This is the only cross-process FS sharing, and it flows in one direction (WM writes, deployer reads).
- Traversal on `/var/devloop/` is granted to all `devloop-fs` members (execute bit via group).

---

## 12. Migration Path (unchanged from v2)

## 13. Bootstrap and Deployment

### 13.1 Server provisioning
- DNS: `devloop.airpipe.ai` already points at server
- Packages: Node 22, Postgres 16, Nginx, certbot, `bubblewrap`, iproute2 (for netns), `tinyproxy` or equivalent for egress proxy base (can write custom tiny CONNECT proxy instead)
- Create all Linux users + groups per §11
- Create Postgres roles, database, grants
- Place credential files in `/etc/devloop/` with correct ownership
- Install systemd units, reload, enable
- Nginx vhost for `devloop.airpipe.ai` with TLS via certbot
- Bootstrap admin user via interactive CLI: `sudo -u devloop-api DEVLOOP_BOOTSTRAP=1 node dist/main.js bootstrap-admin` (prompts for email and password)

### 13.2 Application deployment

**Migration auth (critical):** Migrations require the `devloop_owner` Postgres role, which is peer-mapped to the `devloop-admin` OS user (see §11 pg_ident.conf). Migrations are executed via `sudo -u devloop-admin` — this is the only use of `devloop-admin`. Runtime services cannot switch to this user and cannot access the `devloop_owner` role.

Sequence:

```
# Clone source (as root, set ownership to root for immutable read-only source)
sudo git clone https://github.com/zendoj/devloop.git /opt/devloop
sudo chown -R root:root /opt/devloop

# Build each component in its own directory
# (per §3.1 per-component topology: api, orchestrator, reviewer, deployer, worker-manager, frontend, egress-proxy)
for component in api orchestrator reviewer deployer worker-manager frontend egress-proxy; do
  cd /opt/devloop/runtime/$component
  sudo npm ci
  sudo npm run build
done

# Run migrations as the migration user (peer-auth maps to devloop_owner role)
# The schema definitions and migration entrypoint live in the api package because
# api is the primary schema owner (shared types are re-exported from api to other components).
sudo -u devloop-admin node /opt/devloop/runtime/api/dist/migrations/run.js

# Start systemd units
sudo systemctl daemon-reload
sudo systemctl enable --now devloop-frontend.service
sudo systemctl enable --now devloop-api.service
sudo systemctl enable --now devloop-orchestrator.service
sudo systemctl enable --now devloop-reviewer.service
sudo systemctl enable --now devloop-deployer.service
sudo systemctl enable --now devloop-worker-manager.service
sudo systemctl enable --now devloop-egress-proxy.service
```

### 13.3 Project registration

Admin UI flow (`/admin/projects/new`):

1. Enter project metadata (slug, name, host base URL, GitHub owner/repo, default branch, host_apply_timeout_seconds)
2. Initiate GitHub App install flow (OAuth); admin authorizes **both** Apps on host repo: `devloop-deployer-app` (write-scoped) and `devloop-compliance-app` (read-only). Two separate authorization flows.
3. **Compliance module immediately verifies branch protection** via GitHub API:
   - Default branch is protected
   - Required status checks include CI (configurable list)
   - `enforce_admins` is true
   - `allow_force_pushes` is false
   - `allow_deletions` is false
   - Required reviews (optional, configurable)
   - No bypass permissions granted to the App itself
   - **Registration is rejected** if any fail; admin must fix in GitHub and retry
4. Generate `host_token` and `deploy_token` (shown once)
5. Provide download link for deploy agent installer + policy.yml template + central public signing key
6. **Baseline desired-state seeding (new in v8):** Central fetches the current HEAD of the default branch on GitHub via the compliance App (or admin manually enters the currently-deployed SHA from the host via a form). Central then writes an initial `desired_state_history` row with `seq_no=1`, `action='baseline'` (new enum value), `deploy_sha=<current_host_sha>`, `base_sha=<current_host_sha>`, `applied_sha=<current_host_sha>`, `applied_at=now()`, `applied_status='success'`, `applied_log_excerpt='baseline seeded at project registration'`. This gives the first DevLoop-managed deploy a valid rollback target; without this step, a failed first deploy would have no previous successful row to roll back to.
6. Provide instructions for host adapter installation
7. Create initial `project_configs` version with classifier_rules, agent_roles, build_commands, etc.
8. Write `project_registered` audit event
9. Periodic compliance re-check every 6 hours; failure pauses project

### 13.4 Host adapter installation (dev_energicrm)

1. Copy host adapter module source from `/opt/devloop/host-adapter/backend/` into host project (or import as git submodule / npm dependency in the future)
2. Add import to `app.module.ts`
3. Create `/etc/devloop-host/` with mode 0750 owned by host app user
4. Place `host_token` at `/etc/devloop-host/host_token` (mode 0400)
5. Place `config.yml` at `/etc/devloop-host/config.yml`
6. Restart host backend
7. Verify: open host app, press Ctrl+Shift+D, submit test bug → appears in central dashboard

### 13.5 Deploy agent installation (on dev_energicrm server)

1. Install binary: `sudo dpkg -i devloop-deploy-agent_1.0.0_amd64.deb` (or `npm install -g` path; TBD at implementation)
2. Create user `devloop-deployer` with narrow sudoers entry for the deploy command
3. Place credentials:
   - `/etc/devloop-deploy-agent/deploy-token` (0400)
   - `/etc/devloop-deploy-agent/keys/central-2026-04.pub` (0444, out-of-band delivered)
   - `/etc/devloop-deploy-agent/github-key` (0400, read-only deploy key on the host repo)
   - `/etc/devloop-deploy-agent/config.yml` (0440)
   - `/etc/devloop-deploy-agent/policy.yml` (0440)
4. Create `/opt/dev_energicrm/releases/` directory
5. Enable: `systemctl enable --now devloop-deploy-agent.service`
6. Verify: deploy agent appears in central dashboard as `connected`; first poll succeeds

### 13.6 Build phases
(Same as v2 §13.6 with an extra Phase 0.5 for compliance module.)

---

## 14. Resolved Questions

(Previously §14 open questions; now decisions made.)

- DB: same Postgres instance, separate `devloop` database ✓
- Frontend: Next.js ✓
- Email/SMS alerts: dashboard + email for MVP; SMS later ✓
- Backup retention: 30 days raw + 1 year aggregated
- 2FA: mandatory for admin roles from day one ✓
- Auto-rollback: yes on health failure; always alert Jonas ✓
- `xhigh` reasoning: reserved for `critical` risk tier only ✓
- Sandbox: bwrap ✓ (fallback rootless podman if bwrap infeasible)
- Claude network: Claude CLI in sandbox, egress via UNIX-socket CONNECT proxy with allowlist ✓
- Deploy command on host: release-directory pattern with build + pm2 restart + health wait ✓
- GitHub auth: App preferred; fine-grained PAT as bootstrap fallback if App setup blocks first phase ✓

---

## 15. Glossary (updated)

(Existing terms unchanged; added:)
- **Egress proxy** — `devloop-egress` service running an HTTP CONNECT proxy on a UNIX socket with a strict hostname allowlist
- **Compliance module** — module in Public API that verifies and monitors GitHub branch protection on registered projects
- **Deploy mutex** — per-project lock preventing concurrent deploy flows
- **Audit chain head** — single-row table holding the last audit hash; advisory lock serializes chain extension

---

## 16. Document Status

| Step | Reviewer | Status |
|---|---|---|
| v1 drafted | Claude | Done |
| v1 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 11 critical + 12 important |
| v2 drafted | Claude | Done |
| v2 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 10 critical + 12 important |
| v3 drafted | Claude | Done |
| v3 reviewed by `gpt-5.4` reasoning=high (calibrated prompt) | OpenAI | Done — changes_requested, 8 critical + 7 important |
| v4 drafted | Claude | Done |
| v4 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 6 critical + 6 important |
| v5 drafted | Claude | Done |
| v5 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 8 critical + 8 important |
| v6 drafted | Claude | Done |
| v6 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 6 critical + 5 important |
| v7 drafted | Claude | Done |
| v7 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 10 critical + 4 important |
| v8 drafted | Claude | Done |
| v8 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 6 critical + 6 important |
| v9 drafted | Claude | Done |
| v9 reviewed by `gpt-5.4` reasoning=high | OpenAI | Done — changes_requested, 4 critical + 6 important |
| v10 drafted (this revision — 4 micro-fixes; final per Jonas plan X) | Claude | Done |
| v10 review | OpenAI | Pending |
| Jonas approval | Jonas | Pending |

---

## 17. Threat Model and Accepted Risks

This is the honest accounting requested by round 2 feedback.

### 17.1 Actors and assets

**Storage model per §4.3 and §19 D13:**

**File-backed runtime secrets** (on disk, mode 0440, loaded via systemd LoadCredential, NEVER in DB):
- GitHub App deploy key (`/etc/devloop/github_app_key`)
- GitHub App compliance key (`/etc/devloop/github_app_compliance_key`)
- OpenAI API key (`/etc/devloop/openai_api_key`)
- Anthropic API key (`/etc/devloop/anthropic_api_key`)
- Deploy signing private key (`/etc/devloop/deploy_signing_priv_<key_id>`)
- JWT signing secret (`/etc/devloop/jwt_secret`)
- Data encryption key (`/etc/devloop/data_encryption_key`)

**DB-resident data:**
- Public keys (`signing_keys.public_key` only — private keys are file-backed)
- Encrypted 2FA TOTP secrets (`users.two_factor_secret`, encrypted with file-backed `data_encryption_key`)
- Argon2id hashed passwords (`users.password_hash`)
- HMAC-SHA256 digests of host tokens and deploy tokens (`projects.host_token_hmac`, `projects.deploy_token_hmac`)
- Bug report content (`reports`, `report_threads` — redacted before insert, may still contain PII)
- Audit events (`audit_events` — append-only, hash-chained)
- All operational state tables (`agent_tasks`, `module_locks`, `deploy_mutex`, `desired_state_history`, `jobs`, etc.)

**Actors:**
- **Jonas** — legitimate operator, root on both central and host servers
- **External attacker** — internet-facing via devloop.airpipe.ai
- **Supply-chain attacker** — via npm dependencies
- **Compromised Claude output** — via prompt injection from untrusted report content

**Assets:**
- Host project source code (modifiable via merged commits)
- Host project runtime (controllable via deployed commits)
- Secrets stored in central DB (GitHub App key, OpenAI key, signing key, 2FA secrets)
- Bug report content (may contain customer PII)
- Audit trail (forensic value)

**Actors:**
- Jonas — legitimate operator, root on both central and host servers
- External attacker — internet-facing
- Supply-chain attacker — via npm dependencies
- Compromised Claude output — via prompt injection from untrusted report content

### 17.2 Adversary goals and mitigations

| Adversary goal | Mitigation | Residual risk |
|---|---|---|
| Inject malicious code into host project | Non-bypassable review via OpenAI with 7-category rubric; branch protection enforced at onboarding; deploy agent allowlist policy on host-side | **High residual** if central is compromised: central authors + reviews + merges + signs. See §17.3. |
| Exfiltrate secrets from central | Process identity separation, secret isolation per service, systemd LoadCredential, encrypted at rest, egress allowlist | Moderate; concentrated in deployer+reviewer users |
| Exfiltrate data via sandboxed Claude | Sandbox has no general network, only egress proxy with hostname allowlist; sandbox worktree is isolated; redaction of logs | Prompt injection in report content could cause Claude to include bad patches that reach review. Mitigation: reviewer is independent and specifically checks for scope violations. |
| Force a rogue deploy | Signing key required, signature verified on host; host policy limits allowed paths and file counts; pull-only transport from central | **High residual** if central is compromised AND signing key is on compromised machine |
| Tamper with audit | DB role-level grants (INSERT+SELECT only), trigger defense, hash-chain integrity | Low; chain verifier catches retroactive tampering |
| Compromise host directly | DevLoop does not hold host root; host deploy agent has narrow sudoers entry limited to deploy command | Low (from DevLoop; unrelated risks exist) |
| Compromise of `devloop-worker` uid | Sandbox limits filesystem + network + syscalls; any RCE limited to /workspace + /tmp + egress proxy | Low (effective isolation via bwrap) |
| Compromise of `devloop-egress` | Proxy is small (~200 LOC) and auditable; runs with minimal privileges | Low |

### 17.3 The central compromise scenario (accepted risk)

**Scenario:** An attacker gains code execution as `devloop-dep` (the most privileged central user).

**Consequences:**
- Attacker has the signing key → can sign malicious desired_state records
- Attacker has GitHub App key → can create PRs and merge them on the host repo
- Attacker can author any code within the allowlisted paths and push it
- The deploy agent on the host will accept and apply this, because:
  - Signature is valid (signed with the real key)
  - Path allowlist is respected (attacker chooses paths accordingly)
  - Branch protection does not prevent App merges with `contents: write`
  - The review step can be falsified by the attacker bypassing central's own reviewer module

**Residual mitigations the attacker still faces:**
- Audit chain will record the events (but a root attacker could also have altered the chain head table with `devloop_owner` — **chain integrity only helps forensics after the fact**)
- Deploy agent's host policy file is on the host, not on central: if Jonas has configured tight allowlists, attacker is bounded by them
- **Out-of-band signing key distribution** means a compromised central cannot push a new signing key identity to hosts; Jonas must manually accept new keys
- Manual rollback path: Jonas can directly push a revert to GitHub, stop the deploy agent on the host, or remove trusted keys from host policy
- Health monitoring would show anomalies post-deploy

**What is NOT mitigated:**
- A compromised central CAN ship a malicious commit within policy bounds before Jonas notices
- Time-to-detection depends entirely on Jonas's vigilance

**Why this is acceptable for v1:**
- The same residual risk exists in any single-operator system where one machine has write access to prod
- Alternatives (multi-party review, HSM, separate signer organization) require multiple humans or infrastructure that a one-person MVP cannot justify
- The pull-based deploy transport + host-side policy + out-of-band key distribution together provide meaningful defense in depth against the **easy** central-compromise attacks (e.g., simple webshell) even if they do not defeat a sophisticated, targeted attacker who can wait, study, and author policy-compliant malicious code

**Future hardening (roadmap, not v1):**
- Move signing key to HSM (YubiHSM2 or cloud KMS)
- Introduce a separate "release engineer" human who manually co-signs each deploy
- Add commit-signature verification on host that requires a key only Jonas holds offline
- Require reproducible-build proofs from an independent builder

**These are documented to be explicit. They are not implemented in v1. Jonas acknowledges this trade-off.**

### 17.4 Prompt injection risk

Bug reports are user-supplied content that becomes part of the prompt to Claude. A malicious report could attempt to make Claude exfiltrate data, write outside scope, or inject bad code.

**Mitigations:**
- Redaction applied to report content before it enters the prompt
- Sandbox worktree limits what Claude can read beyond its task files
- Egress proxy limits what Claude can contact (only Anthropic API)
- Reviewer stage is an independent model with a strict rubric — prompt injection from the report would have to survive into the code diff AND fool the reviewer
- `changes_requested` loop has a max of 3 attempts before escalation
- All report content is logged for forensics

**Residual risk:** A clever prompt injection that produces code which passes automated review is possible in theory. Rate: unknown; mitigations: reviewer is a different model from the coder, review rubric specifically includes "scope violation" and "unexpected dependencies" checks.

---

## 18. Backup, Restore, and Disaster Recovery

### 18.1 Backup matrix

| Asset | Frequency | Method | Destination | RPO | RTO | Encrypted at rest |
|---|---|---|---|---|---|---|
| Postgres `devloop` DB | Daily + continuous WAL | `pg_basebackup` + WAL archiving | `/var/backups/devloop/pg/` + remote off-site (rsync to a second server or object storage) | 5 min (via WAL) | 30 min | Yes (disk + transport) |
| `/var/devloop/artifacts/` | Daily | `rsync --delete` | `/var/backups/devloop/artifacts/` + remote | 24 h | 2 h | Yes |
| `/var/devloop/projects/*/main/` (bare clones) | Not backed up (re-clonable from GitHub) | — | — | n/a | 1 h to re-clone | n/a |
| `/etc/devloop/` credentials | On change only | Manual by Jonas | **Offline** (encrypted backup on separate device, offline key escrow) | n/a | Manual | Yes |
| `signing_keys` private key files | On key rotation | Manual | Offline escrow (paper or encrypted USB in safe) | n/a | Manual | Manual |
| `/etc/devloop-deploy-agent/` on each host | On install + change | Host-local backup or manual documentation | — | n/a | Manual | Yes |

### 18.2 Restore order

1. Provision new server with packages + users + groups per §11
2. Restore Postgres `devloop` DB from basebackup + WAL (to point-in-time closest to failure)
3. Restore `/var/devloop/artifacts/` from rsync backup
4. Restore `/etc/devloop/` credentials from offline escrow (manual)
5. Restore `signing_keys` from offline escrow (manual) OR rotate to new keys if old keys were compromised
6. Re-clone `/var/devloop/projects/*/main/` from GitHub
7. Start services
8. Verify audit chain integrity (`npm run audit-chain-verify`)
9. Check the latest `desired_state_history` row per project against host's actual state. The `/devloop-host/version` endpoint was removed (§3.4.1), so use one of:
   (a) Read the deploy agent's `state.json` on the host (via SSH) for `last_applied_sha` and `last_applied_seq_no`
   (b) Read the `current` symlink target on the host (e.g., `readlink /opt/dev_energicrm/current` → `/opt/dev_energicrm/releases/<sha>`)
   (c) Compare (a) or (b) to the latest `desired_state_history.applied_sha` in central DB. If they diverge, write a corrective `desired_state_history` row.
10. Notify all hosts' deploy agents to re-poll (or just wait 15s)

### 18.3 RPO/RTO targets

- **RPO (max data loss):** 5 minutes of DB state, 24 hours of artifacts (screenshots), 0 seconds of credentials (escrowed separately)
- **RTO (max downtime):** 2 hours to fully restore (bare-metal reinstall) or 30 minutes (same-server recovery)

### 18.4 Restore drill cadence

Quarterly. Jonas runs a restore to a throwaway VM, verifies audit chain, verifies a sample of projects' desired_state matches expected state. Documented in RUNBOOK.md.

### 18.5 Key loss recovery

Encryption key loss = no recovery of encrypted secrets. Recovery = manual re-entry of every secret (GitHub App re-installation, signing key rotation, 2FA re-enrollment, token re-issuance). This is a Sev-1 event with a documented runbook, not a transparent re-encrypt path.

---

---

## 19. Authoritative Decision Table

**This section is the canonical source for every "pick one" decision in the document.** Any other section that appears to contradict this table is wrong. Reviewers and implementers should check this table first when a detail seems ambiguous.

| # | Decision | Value | Rationale | Enforced by |
|---|---|---|---|---|
| **D1** | Claude execution model | Claude CLI runs **inside bwrap sandbox**. Egress to `api.anthropic.com` via bind-mounted UNIX socket proxy with SNI allowlist. | Sandbox isolation + explicit allowlisted egress. | §3.2 |
| **D2** | Worker dispatch | **IPC-driven from orchestrator** to worker manager over `/run/devloop/wm.sock`. No `worker` DB queue. Safety-net reconciler re-sends IPC if task sits in `assigned` with no `worker_id`. | Simpler than dual consumer pattern. | §3.1.6, §7.2, §7.2.1 |
| **D3** | `desired_state_current` | **Does not exist.** Latest desired state served from `desired_state_history` via indexed query (`ORDER BY seq_no DESC LIMIT 1`). | Simpler; avoids trigger-maintained materialization. | §4.2 |
| **D4** | Module lock scope | Held through **all** non-terminal, non-blocked states (from `assigned` through `verifying`/`rolling_back`). Released on transition to `verified`, `rolled_back`, `failed`, `cancelled`. **NOT released on `rollback_failed`** (see D5). | Prevents concurrent work on same module during review and deploy. | §6.2, §6.2.1, §7.5 |
| **D5** | `rollback_failed` lock/mutex policy | **Both module lock AND deploy mutex RETAINED** on transition to `rollback_failed`. Released only by manual recovery command `devloop recovery clear-task <task_id>`. | `rollback_failed` is a Sev-1 stuck state requiring human inspection. Auto-release could mask the problem. | §4.2, §6.2.1, §7.5, §8 |
| **D6** | Deploy-stage uniqueness | **DB-enforced** via partial unique index on `agent_tasks(project_id) WHERE status IN ('deploying','merged','verifying','rolling_back','rollback_failed')`. At most one task in any deploy-stage status (including the stuck `rollback_failed` state) per project. `rollback_failed` MUST be included so a stuck task blocks new deploys until manual recovery. Defense in depth over `deploy_mutex`. | `deploy_mutex` alone can have crash recovery gaps; unique index has no gaps. `rollback_failed` inclusion matches D5 lock retention. | §4.2 |
| **D7** | Heartbeat lease semantics | **Ordinary heartbeats do NOT increment `agent_tasks.lease_version`.** Only `fence_and_transition()` bumps lease. This prevents callers from self-fencing. Module lock `expires_at` renewed in-place. `ROW_COUNT = 1` check on lock renewal fences on lost lock. | Caller's in-memory lease is stable for the whole stage. | §6.3 |
| **D8** | Signing canonicalization | **RFC 8785 JCS** applied to a fixed-field JSON object. Signed bytes stored verbatim as `bytea` in `desired_state_history.signed_bytes`. Host verifies against raw bytes; never re-canonicalizes. | Deterministic, interoperable, byte-exact verification. | §4.2, §5.4 |
| **D9** | Signing key model | **Single global Ed25519 key** with `key_id` versioning. Active key_id stored at `/etc/devloop/deploy_signing_active_key_id`. Private key at `/etc/devloop/deploy_signing_priv_<key_id>`. Exactly one `signing_keys` row with `status='active'` enforced by partial unique index. Public keys distributed to hosts **out-of-band** during rotation. | Simple; separation of authority via OOB key distribution. | §4.2, §4.3, §5.4, §11 |
| **D10** | Branch name format | **Plain branch names** (e.g., `experiment2`, `main`). Never `refs/heads/` prefix. Agent branches named `devloop/task/<task_id>`. Revert branches named `devloop/revert/<task_id>`. | Matches GitHub API defaults; deterministic names enable idempotent recovery lookups. | §3.4.2, §4.2, §7.5 |
| **D11** | PR creation idempotency | Deterministic branch name + **recovery lookup before creation**: query GitHub for open PRs with `head=devloop/task/<task_id>` before creating a new one. Persist `github_pr_number` after discovery or creation. | Crash-between-API-call-and-DB-commit → no duplicate PRs on retry. | §7.5 |
| **D12** | Crash recovery rule | Task status NEVER moved to `failed` on crash. Job lease expires → janitor requeues → resume from DB checkpoint. Task → `failed` only on `retry_count >= max_retries` OR unrecoverable inconsistency detected at resume time (e.g., merged SHA mismatch). | Crashes are transient; resume is correct; give-up is deliberate. | §7.5, §8 |
| **D13** | Secret storage | **File on disk**, mode `0440`, owned `root:<service-group>`, loaded via systemd `LoadCredential`. No DB-level encryption of runtime secrets except `users.two_factor_secret` (the single exception). | Simple, auditable, recoverable. | §4.3, §11, §17.1 |
| **D14** | GitHub auth | **Two separate GitHub Apps** (different App registrations, not two installations of one App): (a) `devloop-deployer-app` with write permissions (`contents:write`, `pull_requests:write`, `actions:read`, `metadata:read`) — used by deployer; (b) `devloop-compliance-app` with read-only permissions (`metadata:read`, `administration:read`) — used by Public API compliance module. Two separate App private key files; two separate identities in GitHub. Deployer cannot read API's key; API cannot read deployer's key. | GitHub permission scopes are app-level, not installation-level, so least-privilege separation requires two distinct Apps. | §5.5 |
| **D15** | Egress proxy enforcement | **Enforced only for sandboxed Claude** in v1. Reviewer and deployer have direct AF_INET outbound. Proxy enforcement for reviewer/deployer is a roadmap hardening item, not v1 scope. | Honest docs; sandbox is where enforcement matters most. | §3.1.7, §11, §17 |
| **D16** | Report transport | Browser → host adapter → central (NOT browser → central direct). Host adapter holds `host_token` server-side and proxies POSTs. | Token stays off the browser. | §7.1 |
| **D17** | Deploy transport | **Pull-based**. Central writes desired state; host deploy agent polls and applies. Central NEVER makes outbound deploy calls to host. | Reduces deploy-transport attack surface. | §2.3, §3.4.2 |
| **D18** | Transaction isolation for orchestrator | `REPEATABLE READ`. Project config row locked `FOR UPDATE`. | Prevents config snapshot race. | §7.2 |
| **D19** | Audit mutation path | All runtime roles have EXECUTE on `append_audit_event()` only. **No direct INSERT, UPDATE, DELETE, or TRUNCATE** on `audit_events`. Advisory lock serializes chain extension. Explicit BEFORE triggers on UPDATE/DELETE/TRUNCATE. | Defense-in-depth for audit immutability. | §4.2 |
| **D20** | Migration identity | **Dedicated `devloop-admin` OS user**, peer-mapped via `pg_ident.conf` to `devloop_owner` Postgres role. Runtime services cannot switch to this user. | Separates migration from runtime privileges. | §11, §13.2 |
| **D21** | Fallback polling cadence | Reconciler scans every **10 seconds** for stale/missed work across multiple dimensions (assigned-without-worker, stale-heartbeat, queued_for_lock, stale-deploy-mutex). No 24-hour time cutoff. | NOTIFY is optimization; polling is durability. | §7.2.1 |
| **D22** | Retry budget | `retry_count` max = 3 for deploy stages; max = 3 for review; stage-specific defaults configurable. On exceeded: task → `failed`. | Prevents infinite loops and cost runaway. | §7.5 |
| **D23** | Worktree cleanup timing | **Anthropic credential file:** shredded immediately after bwrap/sandbox exits (NOT at task terminal state — credential must not linger while task moves through review/deploy). **Worktree directory:** retained 24h after task terminal state, then deleted by delayed cron. **Weekly:** `git worktree prune` on bare mirrors. | Credential should only exist while Claude is actively running. Worktree retained for debugging. | §3.2, §7.3 |
| **D24** | Classifier | Fully deterministic per `project_configs.classifier_rules`. **No AI in classification.** First-match-wins rule list with `devloop-dev` as generalist fallback. Locked modules set task `status='blocked'` without worker notification. | Deterministic routing; no AI creativity where it doesn't belong. | §7.2, §7.2.2 |
| **D25** | Threat model acceptance | Central compromise = production compromise. Accepted risk for single-operator MVP. HSM, separate signer organization, multi-party review are documented roadmap items, NOT v1 scope. | Honest single-operator scope. | §17 |

### D26. Authoritative RBAC matrix

**This is the single source of truth for every runtime Postgres role's privileges.** All service sections reference this table. No service section has its own privilege list. Drift between this table and reality is a bug in the service section.

**Core principle:** Runtime roles have **no direct DML** on security-sensitive tables. Only `EXECUTE` on specific stored procedures. The state machine, audit chain, and locking invariants are enforced at the DB boundary.

#### Tables and procedures

| Object | `devloop_api` | `devloop_orch` | `devloop_rev` | `devloop_dep` | `devloop_wm` |
|---|---|---|---|---|---|
| **Tables — read** | | | | | |
| `users` | SELECT | — | — | — | — |
| `sessions` | SELECT, INSERT, UPDATE(`last_seen_at`, `revoked_at`) | — | — | — | — |
| `projects` | SELECT, UPDATE(`status`, `branch_protection_verified_at`) | SELECT | SELECT | SELECT | SELECT |
| `reports` | SELECT, INSERT, UPDATE(`status`, `corrected_description`) | SELECT, UPDATE(`status`) | — | — | — |
| `report_threads` | SELECT, INSERT | INSERT (via stored proc) | INSERT (via stored proc) | INSERT (via stored proc) | — |
| `report_artifacts` | SELECT, INSERT | — | — | — | — |
| `agent_tasks` | SELECT | SELECT | SELECT (own task) | SELECT (own task) | SELECT (own task) |
| `module_locks` | SELECT | SELECT | SELECT | SELECT | SELECT |
| `deploy_mutex` | SELECT | SELECT | — | SELECT | — |
| `desired_state_history` | SELECT | — | — | SELECT | — |
| `project_configs` | SELECT, INSERT, UPDATE(`is_active`) | SELECT | — | — | — |
| `signing_keys` | SELECT(public_key, status, created_at) | — | — | SELECT(public_key, status, created_at) | — |
| `branch_protection_checks` | SELECT, INSERT | — | — | SELECT | — |
| `host_health` | SELECT, INSERT | — | — | SELECT | — |
| `host_health_alerts` | SELECT, INSERT, UPDATE(`acknowledged_*`) | — | — | — | — |
| `quota_usage_global` | SELECT | — | UPDATE (via stored proc only) | UPDATE (via stored proc only) | — |
| `quota_usage_project` | SELECT | — | UPDATE (via stored proc only) | UPDATE (via stored proc only) | — |
| `jobs` | INSERT (orchestrator queue only) | SELECT, UPDATE, INSERT | SELECT, UPDATE | SELECT, UPDATE | — |
| `audit_events` | SELECT (read-only for dashboard search) | SELECT | SELECT | SELECT | SELECT |
| `audit_chain_head` | — | — | — | — | — |
| **Stored procedures — EXECUTE** | | | | | |
| `append_audit_event(...)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `record_deploy_applied(...)` (final success/failed for host apply) | ✓ | — | — | — | — |
| `record_apply_started(...)` (host apply lifecycle "started") | ✓ | — | — | — | — |
| `record_apply_heartbeat(...)` (host apply lifecycle "heartbeat") | ✓ | — | — | — | — |
| `orchestrate_task_for_report(...)` | — | ✓ | — | — | — |
| `classify_report_with_config(...)` | — | ✓ | — | — | — |
| `fence_and_transition(...)` (THE ONLY function that bumps `agent_tasks.lease_version` and changes status) | — | ✓ | ✓ | ✓ | ✓ |
| `refresh_task(...)` (heartbeat, no lease bump) | — | ✓ | ✓ | ✓ | ✓ |
| `claim_assigned_task(task_id, worker_id, worker_handle)` (WM's atomic spawn claim — replaces direct UPDATE) | — | — | — | — | ✓ |
| `acquire_module_lock(...)` | — | ✓ | — | — | — |
| `release_module_lock(...)` | — | ✓ | — | — | — |
| `renew_module_lock(...)` | — | ✓ | ✓ | ✓ | ✓ |
| `deploy_mutex_acquire(...)` | — | — | — | ✓ | — |
| `deploy_mutex_renew(...)` | — | — | — | ✓ | — |
| `deploy_mutex_release(...)` | — | — | — | ✓ | — |
| `deploy_mutex_clear_if_stale(project_id)` (orchestrator reconciler) | — | ✓ | — | — | — |
| `record_desired_state(...)` (signs and inserts) | — | — | — | ✓ | — |
| `reserve_quota(...)` | — | — | ✓ | ✓ | — |
| `reconcile_quota(...)` | — | — | ✓ | ✓ | — |

#### Rules

1. **No direct INSERT, UPDATE, or DELETE on `audit_events` or `audit_chain_head` by any runtime role.** Only `append_audit_event()`. Enforced via `REVOKE` at migration time.
2. **No direct UPDATE on `agent_tasks.status`, `module_locks`, `deploy_mutex`, `desired_state_history` `applied_*` columns, `signing_keys` private key material, or any `lease_version` column** by any runtime role. Only via the listed stored procedures.
3. **SECURITY DEFINER** is used for the stored procedures that need to mutate tables outside the caller's direct grants (audit append, record_deploy_applied, fence_and_transition, deploy_mutex_*, record_desired_state). The function is owned by `devloop_owner` and callable by the listed runtime role via `GRANT EXECUTE`.
4. **Column-level grants** enforce narrow writes where needed (e.g., `devloop_api` UPDATE on `sessions(last_seen_at, revoked_at)` only).
5. Migrations as `devloop_owner` are the only path that can change grants or create new procedures.

**Conflict resolution:** If any other section contradicts §19, §19 wins. Pull requests that change §19 must be reviewed with the highest scrutiny because every downstream section depends on its contents.

---

*End of document.*
