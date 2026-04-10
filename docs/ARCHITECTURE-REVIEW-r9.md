# Architecture review — round 9

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=46384 completion=12142, reasoning=10172

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Late-success rejection fix is not actually reflected in the SQL** — §4.2 (`desired_state_history` narrative and `record_deploy_applied`) — The prose says v9 changed the gate to `WHERE applied_status IS NULL` so a timeout-marked row rejects a late host success. But the actual `record_deploy_applied()` SQL still uses `AND applied_at IS NULL`. That reintroduces the exact bug v9 claims to have fixed and makes the document internally inconsistent on a production deploy path. **Recommended fix:** change the function to gate on `applied_status IS NULL`, update the surrounding commentary to match, and add an explicit timeout → late-success integration test that must return `false` and emit `deploy_host_apply_late_after_timeout`. **Severity:** critical

2. **Timeout path cannot be implemented within the stated RBAC/mutation model** — §4.1, §4.2, §7.5 step 9, §19 D26 — Step 9 requires the verification scanner to atomically set `desired_state_history.applied_status='timed_out'` before rollback. But no stored procedure for that write exists, and `devloop_dep` has no direct `UPDATE` privilege on `desired_state_history`. As written, the timeout path either breaks the documented DB mutation boundary or cannot be implemented. **Recommended fix:** add a SECURITY DEFINER procedure such as `record_apply_timeout(desired_state_id, project_id)` (or equivalent), grant EXECUTE to the component that owns verification, define idempotency/audit behavior, and reference it consistently in §7.5 and §19 D26. **Severity:** critical

3. **Worker→deployer handoff is still internally inconsistent and not executable as written** — §7.3 step 4, §7.5 step 4, §11 — v9 says the handoff is a git bundle, but the body still drifts in three ways: (a) §7.3 still says deployer reads the branch/SHA from the bare mirror, not solely from the bundle; (b) §7.5 says WM creates the bundle at `in_progress → review` using `<approved_base_sha>..HEAD`, but `approved_base_sha` does not exist until review approval; and (c) §11 does not document `/var/devloop/handoff/` or give deployer the access needed to read it. This is the core publication path to GitHub, so the architecture is not implementable as written. **Recommended fix:** make one canonical handoff design end-to-end: define exactly what WM bundles using data available before review approval, remove all stale bare-mirror handoff text from §7.3, add `/var/devloop/handoff/` to §11 with owner/group/mode/cleanup, and document the deployer’s read access path explicitly. **Severity:** critical

4. **Host deploy-agent callback contract still drifts on verb and payload** — §3.4 responsibilities, §4.2 host→central contract, §7.5 step 9 — §4.2 says the canonical host callback is `POST /.../desired-state/applied`, but §3.4 still says the agent “POST[s] back to `PUT /api/v1/projects/<slug>/desired-state/applied`”. Step 9 also uses fields (`started_at`, `timestamp`, `reason`, `log`) that do not match the canonical schema (`log_excerpt`; no documented `reason`/timestamps). This is the wire contract between central and the host agent on the deploy/rollback path. **Recommended fix:** publish one canonical verb/path and one canonical request schema, update all sections to match exactly, and ideally treat that schema as generated/shared contract code or OpenAPI. **Severity:** critical

## Important issues (should address)
1. **Heartbeat API naming still drifts across sections** — §3.2, §6.3, §7.3 — The doc alternates between `TaskStateService.heartbeat`, `heartbeat_task`, and `refresh_task`. The semantics are mostly clear, but the critical lease/heartbeat path should not have three names. **Recommended fix:** pick one canonical stored procedure name and one wrapper/service name, then purge stale references.

2. **Crash-recovery rule is overstated as “all stages” when WM/in-progress is treated differently** — §7.5 intro, §8 failure table — The canonical recovery text says crash recovery applies to all stages, but §8 explicitly handles worker-manager crash during sandbox execution by fencing and failing the task. That exception is reasonable, but it must be stated clearly. **Recommended fix:** narrow the “canonical recovery rule” to the resumable stages (reviewer/deployer queues) and document WM/in-progress as a non-resumable stage.

3. **The document is not fully self-contained for some core areas** — §7.4, §12, §13.6, §7.1 — Several sections say “unchanged from v2” without including the normative content here. For an authoritative v9 implementation document, that leaves gaps unless implementers also carry a frozen v2. **Recommended fix:** inline the reviewer workflow, migration path, and any still-normative v2 content, or append a normative annex/reference snapshot.

4. **Threat-model asset inventory still contains stale DB-secret text** — §17.1 — After correctly listing file-backed runtime secrets, the assets list later says “Secrets stored in central DB (GitHub App key, OpenAI key, signing key, 2FA secrets)”. That conflicts with §4.3 and weakens confidence in the threat-model section. **Recommended fix:** remove the stale bullet and keep §17.1 aligned with the file-backed secret model.

5. **GitHub auth still has two effective canonicals** — §5.5, §14, §19 D14 — D14 says the v1 decision is two separate GitHub Apps; §5.5 and §14 still preserve PAT as a fallback path. That may be operationally defensible, but it creates ambiguity about whether the implementation must support two auth codepaths. **Recommended fix:** state explicitly whether PAT is “documented emergency/manual fallback only” or a supported v1 runtime mode.

6. **Host apply lifecycle validation is underspecified at the DB boundary** — §4.2, §7.5 step 9 — The procedures/contract do not specify validation such as “`success` requires non-null `applied_sha`”, “`started`/`heartbeat` must not set final fields”, or how `reason` is stored for failure. **Recommended fix:** encode these rules in the stored procedures and document them in the canonical HTTP schema.

## Suggestions (optional improvements)
- Generate §19 D26 privileges and the host-agent callback schema from migrations/OpenAPI so doc drift stops recurring.
- Add end-to-end tests for: timeout then late success, deployer crash before/after push persistence, rollback timeout, and bundle handoff resume.
- Consider a dedicated `devloop-handoff` group/path instead of broadening `devloop-fs`.
- Document bundle artifact cleanup/retention alongside worktree cleanup.
- Add explicit `audit_chain_head` bootstrap/seed behavior to the migration section.

## Strengths
- The threat model is substantially more honest than earlier rounds, especially around single-operator trust and central-compromise consequences (§17.3, §19 D25).
- The DB-enforced deploy-stage uniqueness plus deploy mutex is a strong defense-in-depth choice for correctness (§4.2, §19 D6).
- Separation of OS users, DB roles, and file-backed secrets is well thought through for an MVP on one server (§2, §4.3, §11).
- Crash-idempotent GitHub interactions are handled carefully: deterministic branch names, PR discovery before create, merge-state checks before merge (§7.5, §19 D10-D12).
- Pull-based deployment with host-side signature verification and local policy limits is a sensible transport design for this trust model (§2.3, §3.4.2, §5.4).
- The audit design shows good discipline: append-only procedure, chain head serialization, DB-level immutability controls (§4.2, §19 D19).

## Open questions central must resolve
- What exact stored procedure and role ownership will mark a desired state as `timed_out`?
- What is the canonical WM bundle creation input if `approved_base_sha` is not available until after review?
- Will deployer be added to `devloop-fs`, or will a separate handoff directory/group be introduced?
- Is PAT fallback actually implemented in v1, or is GitHub App the only supported runtime mode?
- Is the reviewer workflow from v2 still normative, and if so, where is the frozen authoritative text?