# Architecture review — round 8

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=44455 completion=22096, reasoning=18845

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Agent-branch publication path is contradictory and unresolved**  
   **Section:** §3.1.6, §7.3, §7.5 (step labeled “4. Deterministic agent-branch name and push”), §11, §19 D26  
   **Severity:** critical  
   **Problem statement:** The document now describes two incompatible models for getting the worker-produced branch onto GitHub:
   - §7.3 says the **deployer** is the only component with GitHub write credentials and pushes from the worker-produced local branch.
   - §7.5 says the **worker manager** must already have pushed the branch using a new `github_wm_push_key`.
   - §3.1.6, §11, and §19 D26 do not consistently define that new WM credential, privilege set, or handoff contract.
   
   This is on the core execution path; as written, implementation cannot be done without picking a different architecture than the one documented.  
   **Recommended fix:** Pick exactly one owner for branch publication and propagate it everywhere.
   - Preferred: keep **deployer** as the only GitHub-writing component, and define a concrete handoff artifact from WM to deployer (shared bare mirror, `git bundle`, patch artifact, etc.).
   - If WM is the pusher, then explicitly add the credential, service configuration, RBAC, recovery semantics, and remove all contrary text saying deployer is the only writer.

2. **Host apply lifecycle is not supported by the schema/procedure contract, and late-success protection is still broken**  
   **Section:** §3.4, §4.2 (`desired_state_history`, `record_deploy_applied`, `audit_event_enum`), §7.5 step 9  
   **Severity:** critical  
   **Problem statement:** The runtime flow now requires `started` and `heartbeat` callbacks, `apply_started_at`, `apply_last_heartbeat_at`, timeout-to-`timed_out`, and rejection of late success after timeout. But:
   - `desired_state_history` does **not** define `apply_started_at` or `apply_last_heartbeat_at`.
   - `record_deploy_applied()` only supports final `apply_status_enum` updates, not `started`/`heartbeat`.
   - The procedure still gates only on `applied_at IS NULL`; if timeout sets only `applied_status='timed_out'`, a late success can still overwrite the row.
   - §7.5 references audit events not present in the “exhaustive” enum list (`host_heartbeat_timeout`, `deploy_host_apply_late_after_timeout`; also `deploy_merge_blocked` is referenced earlier in §7.5 and missing from the enum list).
   - Even the HTTP contract drifts (`PUT` in §3.4 vs `POST` lifecycle updates in §7.5).
   
   This makes the verify/rollback path non-implementable as written.  
   **Recommended fix:** Define one exact contract for host apply state:
   - either add explicit lifecycle columns to `desired_state_history`,
   - or add a separate `desired_state_apply_events` / `desired_state_apply_status` structure,
   - split “start/heartbeat” from “final result” stored procedures if needed,
   - make late-success rejection explicit at the DB boundary (`WHERE applied_at IS NULL AND applied_status IS NULL`, or equivalent),
   - and add every referenced audit event to the enum list.

3. **`changes_requested → assigned` cannot be re-spawned because per-claim worker fields are never cleared**  
   **Section:** §6.2.1, §7.2.1(a), §7.3 step 1  
   **Severity:** critical  
   **Problem statement:** Worker claim requires:
   ```sql
   WHERE status='assigned' AND worker_id IS NULL
   ```
   and the reconciler only re-sends spawn IPC for `assigned` tasks where `worker_id IS NULL`. After the first WM claim, `worker_id` and `worker_handle` are set, but no transition is documented that clears them when a task re-enters `assigned` from `changes_requested`. Result: a task can get stuck permanently after its first review loop.  
   **Recommended fix:** Make `fence_and_transition(... -> 'assigned')` explicitly clear `worker_id`, `worker_handle`, `started_at`, and any other per-claim fields, and document that as part of every re-entry-to-`assigned` path.

4. **The “authoritative” RBAC/mutation boundary no longer matches the documented workflows**  
   **Section:** §4.1, §6.3, §7.2.1(d), §7.3 step 1, §19 D26  
   **Severity:** critical  
   **Problem statement:** The document says sensitive tables are mutated only through stored procedures, and that §19 D26 is authoritative. But the workflows contradict that:
   - §7.3 step 1 has WM doing a direct `UPDATE agent_tasks ... status='in_progress', lease_version=lease_version+1`.
   - §6.3 says **orchestrator** owns `assigned`-stage heartbeats via `refresh_task()`, but §19 D26 does not grant `refresh_task` to `devloop_orch`.
   - §7.2.1(d) says the orchestrator clears stale deploy mutex rows, but no `deploy_mutex_clear_if_stale()` procedure/grant exists in D26 for it.
   
   This is both a security-boundary inconsistency and a correctness problem.  
   **Recommended fix:** Either:
   - add explicit procedures such as `claim_assigned_task(...)` and `deploy_mutex_clear_if_stale(...)`, grant them in D26, and remove direct SQL from service flows,
   - or revise the owner model so the documented actors only use the procedures they are actually allowed to execute.

5. **Rollback desired-state tracking is under-specified, so rollback verification cannot be correlated reliably**  
   **Section:** §4.2 (`agent_tasks.applied_desired_state_id`), §7.5 steps 8–10  
   **Severity:** critical  
   **Problem statement:** The task has one `applied_desired_state_id`. Step 8 uses it for the forward deploy desired state. Step 10 creates a second desired-state row for rollback, then says the same verification scanner mechanism is used, but never specifies:
   - whether `applied_desired_state_id` is overwritten,
   - or whether a separate rollback desired-state pointer exists.
   
   Without an explicit checkpoint, crash recovery and verification can read the wrong desired-state row.  
   **Recommended fix:** Make this explicit in schema and flow:
   - either redefine the field as “current desired_state_id” and overwrite it on rollback issuance,
   - or add `rollback_desired_state_id`,
   - then update the verification scanner and checkpoint summary accordingly.

6. **Executable SQL still references a non-existent task status (`wont_fix`)**  
   **Section:** §4.2 (`idx_agent_tasks_stale`), §6.2, §6.3  
   **Severity:** critical  
   **Problem statement:** The task status enum in §6.2 does not include `wont_fix`, but both the partial index and stale-detection query still reference it. If `agent_tasks.status` is an enum as described, this is a migration/runtime SQL error.  
   **Recommended fix:** Either add `wont_fix` to the task-state enum and transition table, or remove every `wont_fix` reference from index predicates, queries, and recovery policy text.

## Important issues (should address)
1. **Retry accounting is still internally inconsistent and not fully enforceable**  
   **Section:** §0 (v8 C4), §4.2 (`agent_tasks.retry_count` comment), §7.5 step 1, §8, §19 D22  
   **Severity:** high  
   **Problem statement:** The changelog says janitor never touches `retry_count` and that it is incremented only inside `fence_and_transition()`. But §4.2 still says `retry_count` is “incremented by janitor on requeue,” and the failure/retry text still talks about in-stage API retries against a persistent budget. There is also no visible schema field for `max_retries`.  
   **Recommended fix:** Define one model only. Best fix: persist stage attempt counters explicitly (`review_attempts`, `deploy_attempts`, etc.) or document the exact retryable transitions that increment `retry_count`, and update schema comments plus D22 to match.

2. **`baseline` desired-state bootstrap is not fully specified on the host side**  
   **Section:** §13.3 step 6, §3.4, §4.2 (`desired_state_history.action`)  
   **Severity:** high  
   **Problem statement:** Central now writes `action='baseline'` at project registration, but the host deploy-agent flow is written around `deploy`/`rollback` behavior. The current `desired_state_history` table comment still documents only `deploy | rollback`, and the first-poll behavior for a brand-new host/state file is not defined.  
   **Recommended fix:** Either:
   - seed the host agent’s `state.json` during installation/registration and ensure baseline rows are never actionable,
   - or define `baseline` end-to-end: schema enum, host-agent handling, and first-poll semantics.

3. **Threat-model asset inventory still contains stale and misleading text**  
   **Section:** §17.1  
   **Severity:** medium  
   **Problem statement:** §17.1 correctly lists file-backed runtime secrets, but later still says: “Secrets stored in central DB (GitHub App key, OpenAI key, signing key, 2FA secrets).” That contradicts §4.3 and weakens the document’s claim of being an honest threat model.  
   **Recommended fix:** Remove the stale line and re-run a final threat-model consistency sweep so assets, storage model, and mitigations all agree.

4. **The final consistency sweep is not actually complete**  
   **Section:** §3.2, §6.3, §11  
   **Severity:** medium  
   **Problem statement:** There are still cross-section drifts that will confuse implementers:
   - §3.2 still says WM calls `TaskStateService.heartbeat(...)` even though §6.3 renamed the canonical function to `refresh_task(...)`.
   - §11’s filesystem table says workspaces are `devloop-worker:devloop-fs`, but the explanatory text at the bottom says they are chowned to `devloop-worker:devloop-worker`.
   
   These are not just editorial; they affect permissions and code paths.  
   **Recommended fix:** Do one more cross-reference sweep and make §19/D26 plus the schema/procedure names the only source of truth for callable operations and file ownership.

5. **`audit_chain_head` bootstrap/genesis row is not specified**  
   **Section:** §4.2 (`audit_chain_head`, `append_audit_event()`), §13.2  
   **Severity:** medium  
   **Problem statement:** `append_audit_event()` assumes a row exists in `audit_chain_head WHERE id = 1`, but the architecture never states where that genesis row is inserted. Without it, the first audit append fails.  
   **Recommended fix:** Seed the genesis row in the initial migration and add a startup self-check that verifies it exists before any service starts consuming work.

6. **Desired-state freshness window still drifts between sections**  
   **Section:** §0 (v8 I4), §3.4.2  
   **Severity:** medium  
   **Problem statement:** v8 says freshness is configurable via `max_desired_state_age_hours` with default 168h, but the deploy-agent flow text still says reject if older than 24h.  
   **Recommended fix:** Update the host-agent flow text to reference the policy value, not a fixed 24h constant.

## Suggestions (optional improvements)
- Add an automated “document-to-schema” consistency check that validates:
  - every enum value referenced in workflows exists,
  - every stored procedure named in flows exists in D26,
  - and every actor that owns a stage has the required EXECUTE privilege.
- Add end-to-end crash-recovery tests for:
  - `changes_requested` re-spawn,
  - merge succeeded / DB commit failed,
  - host success arriving after timeout,
  - rollback verification after central crash.
- If the sandbox is the only proxy client in v1, shrink the egress allowlist to only the Anthropic endpoints it actually needs.
- Consider a structured handoff artifact between WM and deployer (`git bundle` or patch artifact) instead of relying on loosely described local git state.
- Add boot-time self-tests for `audit_chain_head`, active signing key uniqueness, and all expected `SECURITY DEFINER` procedures.

## Strengths
- The single-operator trust model is documented honestly; §17 does not pretend central compromise is solved.
- The deploy-stage uniqueness invariant in the DB plus `deploy_mutex` is strong defense in depth.
- Separation of OS users, Postgres roles, and file-backed credentials is well thought through for an MVP of this scope.
- The signed desired-state design using Ed25519 + stored canonical bytes is a solid, implementable choice.
- Pull-based deployment with host-side signature verification and local policy is a meaningful safety boundary for v1.
- The document clearly tries to move critical invariants to the DB boundary instead of trusting application code.

## Open questions central must resolve
- Which component is the sole publisher of worker-generated branches to GitHub, and what exact handoff artifact/credential model supports that?
- What is the exact DB/API contract for host apply lifecycle events (`started`, `heartbeat`, final result, timeout, late success)?
- How is rollback’s desired-state ID tracked on the task: overwrite `applied_desired_state_id`, or add a separate rollback pointer?
- What is the single persistent retry-budget model, and where is `max_retries` stored/configured?
- How should a freshly installed host agent treat the registration-time `baseline` row on its first poll?
- Is `wont_fix` a real task state that must exist, or should it be purged everywhere from the task workflow?