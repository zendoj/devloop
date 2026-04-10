# Architecture review — round 3

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=18519 completion=20797, reasoning=17311

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Public API cannot perform its stated deploy-agent and compliance duties** — §3.1.2, §3.4, §5.5, §7.5, §13.3  
   **Problem:** The Public API is the only HTTP surface for host deploy agents, but §3.1.2 explicitly says it has **no access to `desired_state*`**. That means it cannot serve `GET .../desired-state` or persist `PUT .../desired-state/applied`, both of which are required by §3.4 and §7.5. Separately, the API owns the `compliance` module and project registration flow, but §3.1.2 gives it **no GitHub credential**, while §13.3 requires it to verify branch protection via GitHub immediately at registration and every 6 hours.  
   **Recommended fix:** Either:
   - give the API narrowly scoped access it actually needs (`SELECT` on current desired state; constrained write path for `applied_*`; GitHub App install/compliance credential), **or**
   - move desired-state serving / apply-status recording / compliance checks into a dedicated internal service or worker and make the API a thin front-end to that service.  
   **Severity:** critical

2. **Worker execution dispatch is still internally inconsistent** — §2.1, §3.1.3, §3.1.6, §7.2  
   **Problem:** §7.2 enqueues `jobs(queue='worker')` and emits `NOTIFY devloop_worker_wakeup`, but the topology and component descriptions say the worker manager is reached via **UNIX socket IPC from orchestrator**, not by consuming a DB queue. No component is clearly defined as the consumer of `jobs.queue='worker'`, and the worker manager’s DB role does not state job-claim rights. This leaves the core “task becomes actual Claude execution” path unresolved.  
   **Recommended fix:** Pick one model and make all sections match:
   - **Option A:** orchestrator claims worker jobs and immediately IPCs the worker manager after commit; no `worker` DB queue.
   - **Option B:** worker manager is the `worker` queue consumer with explicit lease/claim/retry semantics and DB grants.  
   **Severity:** critical

3. **Sandboxed Claude cannot access its workspace or egress socket as written, and Anthropic credential ownership is contradictory** — §3.2, §3.1.6, §3.1.7, §11  
   **Problem:** In §3.2, `bwrap` runs Claude as `--uid 65534 --gid 65534`. In §11, `/var/devloop/worktrees/<task_id>/` is `0770 devloop-wm:devloop-wm`, and `/run/devloop/egress.sock` is `0660 devloop-egress:devloop-egress-clients`. UID/GID 65534 is neither the owner nor the listed group, so the sandboxed process cannot reliably read/write `/workspace` or connect to the proxy socket. Also, §3.1.6 says worker manager has **no external credentials**, yet §3.2 injects `ANTHROPIC_API_KEY` into the sandbox. That is both a functional contradiction and inconsistent with §11’s “Secrets are never in environment variables.”  
   **Recommended fix:** Define one concrete credential and permission model:
   - run the sandbox as a dedicated `devloop-worker` uid/gid that has access to the worktree and egress socket;
   - or adjust ownership/mode specifically for per-task workspace/socket access;
   - and explicitly assign Anthropic credential ownership to the component that launches Claude, preferably via a short-lived file or bind-mounted credential rather than an env var if you want to keep the “no env secrets” claim.  
   **Severity:** critical

4. **`desired_state_current` is not actually specified; the document describes three incompatible implementations** — §3.1.5, §4.2, §7.5  
   **Problem:** §4.2 says `desired_state_current` is “**materialized view or plain table populated by trigger**,” then says it is “**populated by trigger on `desired_state_history` insert**,” and §3.1.5 says the deployer has `UPDATE` on it, while §7.5 step 8 says it is updated **via trigger**. A materialized view is not maintained by row trigger the way described, and “never updated directly” conflicts with deployer `UPDATE` privilege. This object is on the host poll critical path and cannot be left ambiguous.  
   **Recommended fix:** Choose one:
   - plain table maintained transactionally by trigger/stored procedure, with **no direct UPDATE by runtime roles**; or
   - no separate table at all, and serve “latest desired state per project” from `desired_state_history` using an indexed query/view.  
   **Severity:** critical

5. **`agent_tasks.project_config_version` foreign key is invalid SQL / wrong relation** — §4.2 (`agent_tasks`, `project_configs`)  
   **Problem:** `agent_tasks.project_config_version bigint REFERENCES project_configs(version_seq)` is not valid against the schema shown, because `project_configs.version_seq` is only unique **per project** via `UNIQUE (project_id, version_seq)`, not globally unique. Even if Postgres allowed it, it would not prove the task references the config version for the same project.  
   **Recommended fix:** Replace with either:
   - `project_config_id uuid REFERENCES project_configs(id)`, or
   - a composite foreign key `(project_id, project_config_version) REFERENCES project_configs(project_id, version_seq)`.  
   **Severity:** critical

6. **`queued_for_lock` tasks can stall forever after missed `NOTIFY` or orchestrator restart** — §7.2, §8  
   **Problem:** In §7.2, when a module lock is busy, the task is created in `queued_for_lock` and **no job is enqueued**; the document says “lock-release path will wake this task.” That makes wakeup dependent on `NOTIFY devloop_lock_released`. §8’s “jobs table is source of truth” does not help here because these tasks are **not jobs**. If orchestrator is down or disconnected when the `NOTIFY` fires, a queued task can remain stuck indefinitely under normal failure conditions.  
   **Recommended fix:** Add a periodic reconciler that scans `queued_for_lock` tasks and retries lock acquisition by `(project_id, module)` regardless of notifications. Keep `NOTIFY` only as a latency optimization.  
   **Severity:** critical

7. **Deployer stale/crash recovery contradicts itself** — §6.3, §7.5, §8  
   **Problem:** §6.3 says stale review/deploy jobs are reclaimed and requeued via `jobs.lease_until`. §7.5 says deploy recovery resumes from DB checkpoints. But §8 says if the deploy mutex holder crashes, janitor releases the mutex and “**tasks with stale deploy state [are] fenced to `failed`**,” while also claiming they are “retried cleanly.” There is no defined `failed -> resume` transition, and failing a partially checkpointed deploy is not equivalent to resuming it.  
   **Recommended fix:** Document one recovery rule only. For example: stale deploy jobs release/reclaim the job lease, the same task is requeued, recovery resumes from checkpoint, and the task is only moved to `failed` after explicit retry exhaustion or an unrecoverable inconsistency. Align mutex release, task state, and requeue behavior.  
   **Severity:** critical

8. **Host apply acknowledgements are not tied to a specific desired-state record** — §3.4, §4.2, §7.5  
   **Problem:** The deploy agent polls by project slug and reports back to `PUT /api/v1/projects/<slug>/desired-state/applied`, but the document never requires the agent to echo a specific `desired_state_history.id` or `seq_no`. That creates a normal race: delayed or retried apply reports can mark the wrong row as applied, especially around rollback or back-to-back deploys.  
   **Recommended fix:** Include an immutable `desired_state_id` (or `(project_id, seq_no)`) in the signed desired-state payload and require the deploy agent to echo it back. Update exactly one row with `WHERE id = $1 AND applied_at IS NULL` for idempotency.  
   **Severity:** critical

## Important issues (should address)
1. **Project config snapshot is race-prone during orchestration** — §4.2, §7.2  
   **Problem:** `classify_report(report)` appears to use the active project config, and later the task stores `project_config_version` via a separate `SELECT ... WHERE is_active = true`. Under `READ COMMITTED`, those can observe different config versions if an activation happens mid-transaction. That defeats the reproducibility goal.  
   **Recommended fix:** Read and lock the active config row once at the start of orchestration and pass that exact config/version through classification and task creation, or run the transaction at `REPEATABLE READ`.  
   **Severity:** high

2. **Host branch-policy semantics are unclear for post-merge deploys** — §3.4.2, §4.2, §7.5  
   **Problem:** The sample host policy allowlists `refs/heads/experiment2`, but the deploy flow merges to the repo’s default branch and deploys the merged SHA. The desired-state schema does not clearly carry signed provenance for “source branch” enforcement. As written, `allowed_branches` is either ineffective or will reject valid deploys depending on implementation.  
   **Recommended fix:** Define exactly what branch/provenance the host validates:
   - target branch only (likely default branch), or
   - signed source-branch / PR provenance carried in desired-state payload.  
   **Severity:** high

3. **The host “atomic symlink swap” and failure handling are incorrect as written** — §3.4.2  
   **Problem:** `ln -sfn` is not the safe atomic cutover pattern you are claiming here, and step 11 says “DO NOT swap symlink; previous release stays active” even though step 8 already swapped the symlink before `post_deploy_command` and health checks. So the document’s local-cutover semantics are contradictory.  
   **Recommended fix:** Use a temp symlink + `mv -T`/`rename` pattern, and split failure handling into:
   - pre-cutover failure: do not switch;
   - post-cutover failure: either immediately restore previous symlink locally before reporting failure, or explicitly report that cutover occurred and central must roll back.  
   **Severity:** high

4. **“Exactly one active signing key” is not enforced in the database** — §4.2 (`signing_keys`), §5.4  
   **Problem:** The text says exactly one key has `status='active'`, but no DB constraint is defined to enforce it. Rotation as written can also transiently create two actives unless done carefully.  
   **Recommended fix:** Add a partial unique index enforcing one active key and perform rotation in a single transaction.  
   **Severity:** medium

5. **Secret storage source-of-truth is inconsistent across sections** — §4.3, §5.5, §11, §3.1.4–§3.1.5  
   **Problem:** Some sections describe secrets as encrypted in the DB with rotation, while others describe them as root-owned files loaded via `LoadCredential`, and §5.5 specifically says the GitHub App private key is both in a secret table and loaded via `LoadCredential`.  
   **Recommended fix:** State one authoritative storage model per secret class and keep the sections consistent. For MVP, file-backed `LoadCredential` is perfectly defensible if that is the actual choice.  
   **Severity:** medium

6. **Deploy-time branch-protection verification is only as fresh as the last periodic compliance check** — §7.5 step 4, §13.3  
   **Problem:** Step 4 says “Verify branch protection is still current” by reading the compliance module’s last result, but the periodic re-check cadence is 6 hours. That is not actually current.  
   **Recommended fix:** Either perform a live GitHub check before merge, or enforce a strict max-age on the cached result and fail closed if stale.  
   **Severity:** medium

7. **Audit append-only enforcement is not fully specified at the DB boundary** — §4.2, §17.2  
   **Problem:** The design relies on role grants and an advisory-lock insertion algorithm, but the document does not explicitly define the promised trigger defense (`BEFORE UPDATE/DELETE RAISE EXCEPTION`) or a DB-enforced insert path for chain maintenance.  
   **Recommended fix:** Add explicit append-only triggers on `audit_events` and `audit_chain_head`, and make chain advancement happen through one DB function/procedure so application bugs cannot silently bypass it.  
   **Severity:** medium

## Suggestions (optional improvements)
- Add oldest-first fairness rules and an index for `queued_for_lock` reacquisition to avoid starvation on busy modules.
- Prefer `project_config_id` over version-number references; it simplifies joins and avoids composite-key churn.
- Make the desired-state signed payload format explicit now: field list, canonical JSON/binary encoding, signature input bytes, and versioning.
- Consider removing `desired_state_current` entirely and serving the latest row from `desired_state_history`; at MVP scale that may be simpler and safer.
- Add an explicit dead-letter / retry-budget policy for reviewer and deployer jobs.
- Log and expose host-reported `seq_no` / desired-state ID in the UI so Jonas can diagnose replay or out-of-order apply reports quickly.

## Strengths
- The threat model in §17 is materially more honest than many docs at this stage; it clearly states that central compromise is production compromise in this single-operator model.
- Separation of OS users, Postgres roles, and systemd credentials is well thought through for an MVP.
- The move to pull-based deployment plus host-side signature verification and local policy enforcement is a solid defense-in-depth choice for this scope.
- `deploy_mutex` plus append-only `desired_state_history` with monotonic `seq_no` is a strong correction to the earlier last-writer-wins problem.
- The state machine work in §6 is much cleaner than typical MVP docs; the lock implications are mostly explicit.
- Checkpointed deploy flow with explicit rollback path in §7.5 is directionally strong.
- Branch-protection verification at onboarding and periodic compliance re-checking is a good practical control.
- Backup/restore in §18 is concrete enough to be operationally useful.

## Open questions central must resolve
- Which component is the long-term owner of GitHub App credentials and compliance API calls: Public API, deployer, or a separate internal service?
- What is the exact desired-state signature format and canonicalization scheme?
- What exact identifier does the host echo back on apply-status reporting, and what does `state.json` track: SHA only, or SHA + `seq_no`/desired-state ID?
- Who is the authoritative consumer of Claude-execution work items: orchestrator or worker manager?
- Is the host policy intended to enforce target branch, source-branch provenance, or both after merge?