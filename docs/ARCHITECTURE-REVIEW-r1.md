# Architecture review — round 1

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=12814 completion=15081, reasoning=11264

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **[Severity: Critical] Task can start without holding the module lock** — **Sections:** §§7.2 (steps 5–8), 7.3 (step 2)  
   **Problem:** In §7.2, when lock acquisition fails, the task remains `assigned`, and §7.2 step 8 still emits `devloop_task_ready`. In §7.3, the worker claims any task with `status='assigned'`. That means a worker can begin work on a module it does not own, defeating the entire module-serialization design.  
   **Recommended fix:** Add an explicit `waiting_on_lock`/`queued` state. Only emit `devloop_task_ready` after successful lock acquisition. Worker claim SQL must verify that `module_locks.holder_task_id = agent_tasks.id` before transitioning to `in_progress`.

2. **[Severity: Critical] Module lock lease is never renewed** — **Sections:** §4.2 (`module_locks`), §7.3 (heartbeat), §8  
   **Problem:** `expires_at` is set at acquisition time to `now() + 60 minutes`, but no lock-renewal path is defined. Any task exceeding 60 minutes, entering review loops, or waiting on human input can silently lose the lock and allow a second task to enter the same module.  
   **Recommended fix:** Renew `module_locks.expires_at` on each worker heartbeat and on owner transitions, guarded by `lease_version` and current holder identity. Treat lock renewal as part of the same lease/fencing protocol as task ownership.

3. **[Severity: Critical] No fencing tokens for stale worker/reviewer/deployer writes** — **Sections:** §4.2 (`lease_version`), §§7.3.1, 7.4, 7.5, 8  
   **Problem:** The document introduces `lease_version`, but it does not require every state mutation to use compare-and-swap semantics. After stale-task recovery, a previously running subprocess can still transition state, append artifacts, or release a lock after ownership has moved. This is a classic split-brain failure.  
   **Recommended fix:** Every mutating operation must include `WHERE lease_version = <claimed_version>` and increment it atomically on success. Issue explicit fencing tokens per claim for worker, reviewer, and deployer phases, and reject stale writes.

4. **[Severity: Critical] Agent runtime exposes privileged control token to the model and lacks real isolation** — **Sections:** §§7.3, 7.3.1, 11  
   **Problem:** §7.3.1 says the worker writes an internal task-transition token into the prompt. That gives the model a secret capable of mutating workflow state. Combined with untrusted repo content, prompt injection, local network reachability, and the fact the worker runs as child processes of the main backend, this is not a safe execution model. The statement in §11 about “sandbox isolation via systemd unit settings on the parent” is also not credible when the process manager is PM2.  
   **Recommended fix:** Do not put secrets in prompts. Replace HTTP+token with a worker-mediated capability interface over stdio/IPC. Run agents in a separate sandboxed runtime (container/VM/namespace) with a dedicated user, restricted mounts, no ambient credentials, and no arbitrary localhost/network access.

5. **[Severity: Critical] A compromised central control plane can directly drive production-host deployment** — **Sections:** §§3.3, 5.3, 7.5, 11  
   **Problem:** The host deploy endpoint executes a shell command on the production host (`git pull && pm2 restart ...`) based on a centrally signed request. If central is compromised, or the per-project deploy secret is exposed, the attacker gets a direct path to alter and restart production code. That is too much authority concentrated in the control plane.  
   **Recommended fix:** Replace the shell-command webhook with a pull-based deploy agent or CI/CD mechanism on the host that accepts only a signed commit/tag/artifact and performs a fixed, audited deployment flow under a least-privileged service account. I would not approve the current direct-shell deploy model for a production CRM.

6. **[Severity: Critical] Reviewed code is not strongly bound to deployed code** — **Sections:** §§3.3, 7.4, 7.5  
   **Problem:** The reviewer approves a branch HEAD SHA, then the deployer squash-merges later, and the host performs `git pull`. If the base branch advances, or if other commits land before host pull, the code actually deployed may differ from what was reviewed. `expected_version` is sent, but no host-side enforcement is specified.  
   **Recommended fix:** Record both approved branch SHA and base SHA. Require the PR to be up to date or use a merge queue. Deploy the exact merged commit or an immutable artifact derived from it. The host must fetch and check out that exact SHA, and central must verify `/version` matches it after deployment.

7. **[Severity: Critical] Rollback is not a defined, testable protocol** — **Sections:** §7.5 (step 12), §3.3, §14 (item 6)  
   **Problem:** The rollback section offers multiple incompatible mechanisms: GitHub API revert, local `git revert`, or a host webhook rollback action. The host adapter contract in §3.3 does not define rollback behavior, and the state machine does not cover rollback sub-failures. This is not an executable recovery plan.  
   **Recommended fix:** Pick one rollback mechanism and specify it completely: trigger, API contract, idempotency behavior, verification, and failure handling. Add explicit states such as `rollback_pending`, `rolled_back`, and `rollback_failed`, and test them end-to-end before production use.

8. **[Severity: Critical] Audit immutability is not actually enforced against the application role** — **Sections:** §§4.1, 4.2 (`audit_events`), 13.1 (step 3)  
   **Problem:** A trigger blocking UPDATE/DELETE is not sufficient if the same DB role can alter the table, disable/drop the trigger, or truncate data. §13.1 step 3 grants broad privileges, which is inconsistent with the “append-only” claim.  
   **Recommended fix:** Use separate database roles: a non-login owner/migration role owns schema objects, and the app role gets INSERT/SELECT only on `audit_events`, with no ALTER/TRIGGER/TRUNCATE privileges. For a system like this, also consider cryptographic event chaining and/or shipping to an external immutable log sink.

9. **[Severity: Critical] The task/report state machine is incomplete and contradictory** — **Sections:** §§6.1, 6.2, 6.3, 7.3, 7.5, 8  
   **Problem:** The workflows use task status `failed` in §§7.3, 7.5, and 8, but `failed` does not exist in §6.2. `merged` and `verified` both map to report `fix_deployed`; both deployer and closer update report state; and `wont_fix` does not define what happens to active tasks and held locks. This is not a complete state machine for an autonomous production system.  
   **Recommended fix:** Define one authoritative transition table with all states, owners, guards, retries, and terminal conditions. Enforce it in code and with DB constraints. Explicitly define cancellation semantics and lock-release behavior when a report becomes `wont_fix` or a task is manually blocked.

10. **[Severity: Critical] A second autonomous code-change path bypasses the main review/deploy controls** — **Sections:** §7.6 (step 6)  
   **Problem:** The closer auto-updates `CHANGELOG_DEV.md` via a separate commit/PR and auto-merges it if “ChatGPT approves.” That is an additional autonomous merge path outside the stated non-bypassable reviewer/deployer flow. Even if “only docs,” it still mutates the production repo under weaker controls.  
   **Recommended fix:** Remove this from MVP. If retained later, route it through the exact same review, CI, merge, and deployment controls as any other code change.

11. **[Severity: Critical] Runtime files and likely processes are owned by the human operator account** — **Sections:** §13.1 (steps 3–4), §11  
   **Problem:** The bootstrap instructions create runtime directories owned by `jonas:jonas`, and the process layout does not establish dedicated service identities. That collapses operator and runtime trust boundaries and makes compromise/forensics materially worse.  
   **Recommended fix:** Create dedicated non-login service accounts for backend, worker, and deploy components; assign least-privilege file ownership; separate human SSH access from service identities; and keep secrets readable only by the relevant service account.

## Important issues (should address)
1. **[Severity: High] LISTEN/NOTIFY is treated like a queue, but the recovery scan is not durable enough** — **Sections:** §§3.1, 7.2 (step 2), 8  
   **Problem:** The fallback poller for new reports scans only `created_at > now() - interval '24h'`. If the service is down longer than that, or clocks drift, work can be stranded. `NOTIFY` is best-effort wakeup, not durable delivery.  
   **Recommended fix:** Make the database state the source of truth. Poll all outstanding work states without a 24-hour cutoff, or implement an outbox/jobs table with ack/retry semantics.

2. **[Severity: High] Host token authentication is inefficient and mismatched to the schema** — **Sections:** §5.2, §4.2 (`projects`)  
   **Problem:** Verifying bearer tokens by bcrypt against multiple projects is O(n), expensive, and DoS-prone. The “first 8 chars” lookup hint is described but not modeled in the schema.  
   **Recommended fix:** Use a token ID plus random secret, or store an indexed HMAC/SHA-256 digest of the full token and compare in constant time. Reserve bcrypt for human passwords, not machine tokens.

3. **[Severity: High] GitHub PATs are too coarse for this trust level** — **Sections:** §5.4, §4.2 (`github_token_encrypted`)  
   **Problem:** Long-lived PATs with `repo` scope are over-privileged and harder to audit and rotate safely. A single stolen token can exceed the intended per-project blast radius.  
   **Recommended fix:** Use a GitHub App or, at minimum, fine-grained PATs restricted to one repo and only the required permissions.

4. **[Severity: High] Disaster recovery is incomplete, and the encryption-key-loss recovery plan is incorrect** — **Sections:** §§4.1, 4.3, 8  
   **Problem:** `pg_dump` does not cover `/var/devloop/artifacts`, logs, local repo state, or the encryption key. Also, §8 says key loss can be fixed by UI rotation “which re-encrypts with new key”; that is impossible without decrypting the old values first.  
   **Recommended fix:** Define and test full backup/restore, including artifacts and key material. Treat encryption-key loss as a credential re-entry event, not transparent re-encryption.

5. **[Severity: Medium] Health and version endpoints expose more information than necessary** — **Sections:** §§3.3, 7.7  
   **Problem:** Anonymous callers can learn DB status, service version, and commit SHA from host endpoints. That increases reconnaissance value for attackers.  
   **Recommended fix:** Minimize anonymous responses, rate-limit aggressively, and keep detailed health/version data authenticated or private.

6. **[Severity: High] The single backend process is a reliability and operability bottleneck** — **Sections:** §§3.1, 11  
   **Problem:** API, orchestrator, worker manager, reviewer, deployer, and health monitor all share one Node process. A crash, memory leak, or event-loop stall takes out the full control plane and complicates incident diagnosis.  
   **Recommended fix:** Split at least API/control-plane from worker execution. Consider isolating deployer as well.

7. **[Severity: High] The schema does not strongly enforce status vocabularies and invariants** — **Sections:** §§4.2, 6  
   **Problem:** Critical status/event columns are plain `varchar`, and important invariants are only in prose. This invites invalid states and migration drift over time.  
   **Recommended fix:** Use DB enums/check constraints, partial indexes, and invariant checks such as “`approved` requires `approved_commit_sha`” and “terminal task states cannot hold active locks.”

8. **[Severity: High] Cost caps are described but not enforceable under concurrency as written** — **Sections:** §10, §11  
   **Problem:** Per-hour and per-day caps are configuration ideas, but no atomic reservation/accounting model is defined. Concurrent workers can overshoot caps before any one request observes the limit.  
   **Recommended fix:** Implement DB-backed quota reservations before external API calls, then reconcile actual usage afterward.

9. **[Severity: High] Session model is unresolved where revocation behavior matters** — **Sections:** §§4.2 (`oauth_sessions`), 5.1  
   **Problem:** “Optional table if we choose stateful sessions” leaves logout, forced invalidation, stolen-cookie response, and audit scope unresolved. For a privileged admin console, this is not minor.  
   **Recommended fix:** Decide now. Prefer stateful server-side sessions with explicit revocation and session inventory.

10. **[Severity: High] Host adapter packaging/versioning is not deployable as written** — **Sections:** §§3.3, 13.2  
   **Problem:** The installation path references `/opt/devloop/host-adapter/...`, which is not a distributable artifact for remote host projects. The frontend re-export path has the same issue.  
   **Recommended fix:** Publish the host adapter as a versioned package/artifact with explicit compatibility, upgrade, and rollback rules.

11. **[Severity: Medium] A core worker dependency is still marked TBD** — **Sections:** §7.3 (step 6), §13.3 (phase 3)  
   **Problem:** “Exact CLI flags TBD” is attached to the central agent execution path. That means the core contract between orchestrator, worker, and agent is not fully specified.  
   **Recommended fix:** Freeze the agent runner contract before implementation approval: invocation model, allowed tools, output protocol, exit codes, and resource limits.

12. **[Severity: Medium] Bootstrap secret handling is weak** — **Sections:** §13.1 (steps 6, 11)  
   **Problem:** Secrets are placed in `.env` files, and the bootstrap admin password is passed via CLI arguments, which can leak via shell history, process lists, or backups.  
   **Recommended fix:** Use a secret manager or one-time bootstrap token flow, and avoid passing raw passwords on the command line.

## Suggestions (optional improvements)
- Prefer a DB outbox/inbox pattern over raw `LISTEN/NOTIFY` as the primary orchestration mechanism.
- Use GitHub webhooks or merge queue signals instead of polling check-runs every 10 seconds.
- Store artifacts in object storage rather than local FS if you expect growth beyond a few projects.
- Time-partition `audit_events` and `host_health`; both will grow quickly.
- Add fault-injection/integration tests that crash the system at every state transition boundary.
- Produce a signed provenance record linking report → task → review decision → merged commit → deployed version.
- Replace per-project PAT storage with short-lived installation tokens if you adopt a GitHub App.

## Strengths
- Clear separation between central control plane and thin host adapter.
- Trust boundaries are explicitly called out in §2, which is the right starting point.
- The intent to make review non-bypassable and bind approval to a specific SHA is good.
- The design does think about failure modes, rollback, locks, health monitoring, and cost controls rather than treating them as afterthoughts.
- Append-only audit logging is the right goal, even though the enforcement needs strengthening.
- The phased delivery plan in §13.3 is practical and makes sequencing visible.

## Open questions central must resolve
- What is the exact worker isolation model: container, VM, namespace sandbox, or something else? “PM2 + systemd on parent” is not enough.
- Is the intended deployment trust model truly direct central-to-host command triggering, or should deployment become pull-based from the host side?
- What is the single authoritative task/report state machine, including `failed`, cancellation, rollback sub-states, and lock-release ownership?
- How will lease fencing be enforced across worker, reviewer, and deployer so stale actors cannot mutate state?
- How will central prove that the exact reviewed code is the exact deployed code?
- What is the final rollback mechanism, and has it been tested end-to-end on a real host?
- How will audit immutability be enforced at the Postgres role/ownership level?
- What is the full backup/restore and key-management plan, including encryption key escrow and recovery?
- How will the host adapter be packaged, versioned, and updated across host projects?