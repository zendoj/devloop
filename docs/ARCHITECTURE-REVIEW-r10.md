# Architecture review — round 10

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=47969 completion=22161, reasoning=19352

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Deployer can access active worktrees and per-task Anthropic credentials** — Sections: §11, §3.2  
   **Problem:** `devloop-dep` is a member of `devloop-fs`, while `/var/devloop/worktrees/<task_id>/workspace/` and `/var/devloop/worktrees/<task_id>/cred/` are group-accessible (`0770`), and the copied Anthropic key is group-readable (`0440`, group `devloop-fs`). This directly contradicts the claim in §11 that deployer “has no access to active worktrees,” and it lets the deployer read task credentials and modify live worker state. That is a real auth-boundary failure within the stated process-separation model.  
   **Recommended fix:** Remove `devloop-dep` from `devloop-fs`. Create a dedicated handoff group/ACL only for `/var/devloop/handoff/`, and ensure active worktrees/cred dirs are inaccessible to deployer.  
   **Severity:** high

2. **`verifying` can hang forever if the host never sends `started` or `heartbeat`** — Sections: §7.5 step 9, §4.2 (`desired_state_history.apply_started_at`, `apply_last_heartbeat_at`), §8  
   **Problem:** The timeout logic only triggers from `apply_last_heartbeat_at` staleness or `apply_started_at + host_apply_timeout_seconds`. Both fields are nullable. If the host deploy agent never begins the apply, or cannot reach central before its first callback, neither condition fires. The task can remain in `verifying` indefinitely while holding the module lock and deploy mutex. §8 says “no apply report by deadline” rolls back, but §7.5 does not implement that case.  
   **Recommended fix:** Add an explicit “apply never started” timeout keyed from a non-null timestamp such as desired-state issuance time or `verifying_started_at`, and define the corresponding scanner branch, audit event, and rollback behavior.  
   **Severity:** high

3. **`assigned` and `approved` lease ownership is incomplete and internally inconsistent** — Sections: §6.3, §7.2.1, §7.5  
   **Problem:** §6.3 says orchestrator owns heartbeats for `assigned` and janitor fails it after 5 minutes; deployer owns `approved` and janitor blocks it after 5 minutes. But the stale-task policy in §6.3 does not define actions for `assigned` or `approved`, and §7.2.1 implements neither heartbeat renewal nor timeout transitions for those states. This leaves normal WM/deployer outage behavior unspecified and can break the invariant that `assigned` holds the module lock.  
   **Recommended fix:** Make one model canonical and implement it end-to-end: either (a) truly heartbeat `assigned`/`approved` with explicit timeout scanners and transitions, or (b) stop claiming they are heartbeated stages and rely only on queue lease/age-based transitions. Update §6.3, §7.2.1, and §7.5 consistently.  
   **Severity:** high

4. **Stored-procedure privilege model is inconsistent with the RBAC matrix** — Sections: §4.1, §6.3 SQL snippets, §19 D26  
   **Problem:** The runtime roles are documented as having no direct UPDATE on `agent_tasks`, `module_locks`, or `deploy_mutex`, yet `refresh_task()` is shown without `SECURITY DEFINER`, and `deploy_mutex_acquire()` is shown the same way. `claim_assigned_task()` is `SECURITY DEFINER` but does not lock down `search_path`. Under the stated RBAC, these functions either cannot work or are insufficiently hardened for security-definer use.  
   **Recommended fix:** Do a full procedure sweep and make every mutating runtime-callable function explicit and consistent: `SECURITY DEFINER`, fixed `search_path`, owned by `devloop_owner`, and granted only via `EXECUTE`. Show canonical DDL for at least `refresh_task`, `fence_and_transition`, `claim_assigned_task`, `deploy_mutex_*`, and `record_desired_state`.  
   **Severity:** high

5. **Desired-state wire format is undefined for exact signed bytes** — Sections: §3.4.2, §4.2 (`desired_state_history.signed_bytes`, canonicalization protocol)  
   **Problem:** The host verification path depends on the exact signed bytes, but the HTTP representation is not specified. The document says `signed_bytes` and `signature` are served “as-is,” yet the transport is JSON and the fields are stored as `bytea`. Without an explicit encoding contract, implementers can easily serialize them differently and break signature verification. This is a critical-path interoperability hole.  
   **Recommended fix:** Specify the exact API schema and encoding, e.g. `signed_bytes_b64` and `signature_b64` as base64url strings in JSON, plus the precise host decode/verify procedure and a worked example response.  
   **Severity:** high

6. **Git-bundle handoff remains contradictory and not fully executable as written** — Sections: §7.3 step 4, §7.5 step 4, §0 C1  
   **Problem:** §7.3 says WM creates the bundle from `origin/<default_branch>..HEAD` and explicitly says it does not depend on `approved_base_sha`. §7.5 step 4 reintroduces `git bundle create ... <approved_base_sha>..HEAD`, even though `approved_base_sha` does not exist when WM exits `in_progress`. In addition, the deployer extraction flow assumes named refs (`refs/heads/*`) in the bundle, but the document describes a rev-range bundle, so the extraction/ref resolution path is not fully specified. This is still inconsistent on the core publication path.  
   **Recommended fix:** Pick one ref-based handoff format and use it everywhere. For example: bundle an explicit named ref (`devloop/task/<task_id>`) with prerequisites, record the expected head SHA, and specify the exact deployer command that imports that ref and verifies it against `approved_head_sha`. Remove all `approved_base_sha..HEAD` references from WM-side bundle creation.  
   **Severity:** high

## Important issues (should address)
1. **Threat-model asset inventory still contains stale contradictory text** — Section: §17.1  
   **Problem:** The section correctly says runtime secrets are file-backed, but later still lists “Secrets stored in central DB (GitHub App key, OpenAI key, signing key, 2FA secrets).” That contradicts §4.3 and the earlier bullets in the same section.  
   **Recommended fix:** Remove the stale asset bullet and re-run a threat-model consistency sweep so §17 says exactly one thing about secret storage.  
   **Severity:** medium

2. **Desired-state freshness window drifted back to 24h in the host flow** — Sections: §0 (v8 I4), §3.4.2 step 1  
   **Problem:** The changelog says freshness is configurable with default 168 hours plus a reissue command, but the deploy-agent flow still says “not older than 24h.” That is a live cross-section inconsistency on the host verification path.  
   **Recommended fix:** Add the config field to the example config and make §3.4.2 use the same canonical `max_desired_state_age_hours` rule described in the changelog.  
   **Severity:** medium

3. **Stale procedure naming remains in the worker/sandbox sections** — Sections: §3.2, §7.3, §6.3  
   **Problem:** The document still refers to `TaskStateService.heartbeat()` / `heartbeat_task()` in places, while the canonical function is `refresh_task()`. This is implementation-confusing on a critical path already under heavy revision.  
   **Recommended fix:** Normalize all references to `refresh_task()` and remove the old names entirely.  
   **Severity:** medium

4. **Host failure reason is generated but not stored structurally** — Sections: §3.4.2 steps 7/9/12, §4.2 host→central contract, `record_deploy_applied()`  
   **Problem:** The deploy agent produces useful failure reasons such as `policy_violation`, `build_failed`, and `post_deploy_failed_reverted_locally`, but the final apply API/procedure only persists `applied_status`, `applied_sha`, and `log_excerpt`. That loses structured failure data needed for triage and reporting.  
   **Recommended fix:** Add an `applied_failure_reason` enum/text column and carry it through the HTTP contract and stored procedures, or explicitly document that reason is folded into `log_excerpt` and not machine-readable.  
   **Severity:** medium

5. **Reviewer stage is too underspecified in this version of the document** — Sections: §7.4, §4.2 (`approved_base_sha`, `approved_head_sha`)  
   **Problem:** This document now depends on reviewer output populating `approved_base_sha`, `approved_head_sha`, `review_decision`, and the handoff to deployer, but §7.4 is effectively “unchanged from v2 conceptually.” For a canonical “final” doc, that is too thin for a core path.  
   **Recommended fix:** Inline a concise canonical reviewer flow in this version: inputs, exact outputs written, retry behavior, and the transition/enqueue semantics on `approved` vs `changes_requested`.  
   **Severity:** medium

## Suggestions (optional improvements)
- Add `status_entered_at` on `agent_tasks` and `desired_state_history`-level `issued_at`/`verifying_started_at` use to simplify timeout logic and make scanners less inference-heavy.
- Add a dedicated audit enum for “apply_not_started_timeout” if you implement the missing no-start timeout path.
- Make the desired-state GET response schema explicit with a request/response example alongside the POST apply-status contract.
- Add an install-time preflight that verifies unprivileged user namespaces and the exact `bwrap` behavior needed on the target kernel/systemd setup.
- Consider using ACLs instead of coarse shared groups for handoff files; the current group model is where the most serious separation bug came from.
- Add alerting/metrics on queue age for `assigned`, `approved`, `verifying`, and `rollback_failed`.

## Strengths
- The single-operator trust model is documented honestly overall; central-as-trust-root is explicitly acknowledged rather than obscured.
- The deploy-stage DB invariant (`idx_agent_tasks_one_deploy_per_project`) plus mutex is a strong defense-in-depth design.
- LISTEN/NOTIFY is correctly treated as an optimization; the polling/reconciler backstop is well thought through.
- Pull-based deployment with host-side signature verification and local policy enforcement is the right transport design for this scope.
- Crash-idempotency around PR creation, merge detection, and deploy checkpoints is materially stronger than typical MVP docs.
- Backup/restore and baseline desired-state seeding are unusually well specified for an MVP.
- The append-only audit chain is enforced at the DB boundary, not just by application convention.

## Open questions central must resolve
- What is the exact canonical HTTP response shape for `GET .../desired-state`, including binary encoding for `signed_bytes` and `signature`?
- What exact bundle/ref format is authoritative for WM→deployer handoff, and what exact deployer command sequence consumes it?
- Are `assigned` and `approved` truly heartbeated task states, or should they be modeled as queue-lease-only waiting states with age-based transitions?
- What exact reviewer operation writes `approved_base_sha` / `approved_head_sha` and enqueues the deployer job?
- How is drift between central’s mirrored policy fields (`deploy_allowlist_paths`, `deploy_denied_paths`) and the host’s actual `/etc/devloop-deploy-agent/policy.yml` detected and reconciled?
- What kernel/systemd prerequisites are mandatory for the sandbox model on the target host (userns enabled, `bwrap` behavior, loopback assumptions)?