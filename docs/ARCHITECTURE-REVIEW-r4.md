# Architecture review — round 4

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=26201 completion=25246, reasoning=22341

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Worker manager / sandbox permissions do not line up with the declared filesystem and group model** — **Sections:** §3.2, §11  
   **Severity:** critical  
   **Problem:** §3.2 requires `devloop-wm` to run `git worktree add` inside `/var/devloop/projects/<slug>/main` and create/manage `/var/devloop/worktrees/<task_id>`. But §11 makes `/var/devloop/` and `/var/devloop/projects/<slug>/main/` `0750` owned by `devloop-orch:devloop-orch`; `devloop-wm` is not in that group. Separately, §3.2 says the sandboxed `devloop-worker` uid connects to `/run/devloop/egress.sock`, but §11 does not include `devloop-worker` in `devloop-egress-clients`. As written, the worker path cannot function.  
   **Recommended fix:** Define an explicit permissions matrix that matches the runtime path: shared groups/ACLs for bare mirrors and worktrees, add `devloop-worker` to `devloop-egress-clients`, and ensure all required parent directories are traversable by the processes that actually use them.

2. **Module-lock semantics are broken once a task leaves `in_progress`** — **Sections:** §6.2, §6.3, §3.2, §3.1.4, §3.1.5, §4.1  
   **Severity:** critical  
   **Problem:** The design says the module lock is held through `review`, `approved`, `deploying`, `merged`, `verifying`, and `rolling_back` (§6.2). But the only documented lock-renew path is the worker-manager heartbeat in §3.2, which applies to `in_progress`. §6.3 explicitly says review/deploy stages use `jobs.lease_until`, not `agent_tasks.heartbeat_at`, and neither reviewer nor deployer is given a documented fenced lock-renew procedure. Result: a task can still be active in review/deploy while its module lock expires and is acquired by another task for the same module.  
   **Recommended fix:** Either narrow the lock scope to end at `in_progress`, or add explicit reviewer/deployer/verifier lock-renew procedures tied atomically to stage lease renewal, with fencing and stale handling documented at the DB boundary.

3. **`deploy_mutex` is not actually safe across crash/expiry/verification waits** — **Sections:** §7.5, §7.2.1(d), §8  
   **Severity:** critical  
   **Problem:** §7.5 says a crashed task “still holds the mutex conceptually,” while §7.2.1(d) clears expired `deploy_mutex` rows and §8 still talks about fencing stale deploy state to `failed`. There is no DB-enforced rule preventing another approved task for the same project from acquiring the mutex after expiry while the first task is still in `deploying`/`verifying`/`rolling_back`. This is especially dangerous during host-apply wait, where no explicit mutex renewer is defined.  
   **Recommended fix:** Enforce project deploy exclusivity in the database, not “conceptually.” Options: non-expiring holder rows released only on explicit terminal transitions, or an acquisition function that atomically checks both the mutex row and absence of any other nonterminal deploy-stage task for that project. Also document who renews/retains the mutex during `verifying` and rollback.

4. **Desired-state signing is not specified precisely enough to be interoperable or safely verifiable** — **Sections:** §3.4.2, §4.2  
   **Severity:** critical  
   **Problem:** The host is told to verify an Ed25519 signature over “canonical payload bytes,” but the document never defines the canonicalization algorithm. At the same time, `signed_payload` is stored as `jsonb`, which does not preserve the originally signed byte representation. That leaves the core trust check underdefined.  
   **Recommended fix:** Specify an exact encoding and canonicalization format (e.g. RFC 8785 JCS, or fixed-field CBOR), define exact timestamp format/precision, and store/serve the exact signed bytes (`text`/`bytea`) rather than relying on re-serialization of `jsonb`.

5. **Critical-path sections still contradict each other** — **Sections:** §3.1.5, §4.2, §7.5, §8, §18.2  
   **Severity:** critical  
   **Problem:** v4 says `desired_state_current` is removed (§0, §4.2), but §3.1.5 still grants deployer UPDATE on it and §18.2 restore step 9 still relies on it. Also §7.5 says crash recovery does not move tasks to `failed`, but §8 still says stale deploy state is fenced to `failed`; §7.5 says wrong applied SHA is `rollback_failed`, while §8 says `rolling_back`. Finally, the workflow/procedures reference audit event values not present in the enum list in §4.2, including `deploy_host_apply_duplicate_or_missing` and `host_apply_timeout`.  
   **Recommended fix:** Make one section authoritative for deploy-state behavior and align all others to it. Remove all `desired_state_current` references, reconcile §8 exactly to §7.5, and update the audit enum list to include every event used by procedures/flows.

6. **The bootstrap/deployment instructions are not executable as written under the declared auth model** — **Sections:** §4.1, §3.1.2, §3.1.6, §4.3, §11, §13.2  
   **Severity:** critical  
   **Problem:** §4.1 says Postgres auth is Unix-socket peer auth with OS-user-to-role mapping. But §13.2 runs migrations as OS user `devloop-api` while requesting owner role `devloop_owner`; that cannot work unless an additional auth path exists. Separately, §11’s unit definitions omit credentials required elsewhere: API is missing the compliance key and data-encryption key, and worker manager is declared to have “no external creds” despite §3.1.6/§4.3 requiring the Anthropic key.  
   **Recommended fix:** Define an actual migration path compatible with peer auth (dedicated maintenance OS user, temporary local auth rule, or postgres-runner) and make the systemd credential lists in §11 match the required credentials in §§3.1/4.3 exactly.

## Important issues (should address)
1. **Spawn path lacks an explicit atomic worker claim** — **Sections:** §3.1.6, §7.2, §7.2.1  
   **Severity:** high  
   **Problem:** The reconciler re-sends spawn IPC for `assigned` tasks with `worker_id IS NULL` after 30s, but §3.1.6 does not say worker manager first performs a DB compare-and-set claim before worktree setup. If setup is slow or WM crashes mid-start, duplicate sandboxes are possible.  
   **Recommended fix:** On receipt of `spawn`, first atomically claim the task (`status='assigned' AND worker_id IS NULL`) and persist `worker_id/worker_handle`; only then do filesystem work and spawn Claude.

2. **Host deploy-agent config is internally inconsistent/incomplete** — **Sections:** §3.4.2  
   **Severity:** high  
   **Problem:** The sample policy uses `allowed_branches`, while the execution flow refers to `allowed_deploy_branches`. The health check uses `http://localhost:<health_port>/healthz`, but no `health_port` or equivalent endpoint config is defined.  
   **Recommended fix:** Pick one field name, define the exact config schema once, and include the health-check target in that schema.

3. **Signing-key rotation and file-path documentation conflict** — **Sections:** §4.2, §4.3, §5.4, §11  
   **Severity:** medium  
   **Problem:** §4.2 enforces exactly one active key and shows “retire old, then insert new,” but §5.4 says “add new active, then retire old,” which violates the unique index. Private-key file paths also differ (`/etc/devloop/deploy-signing/<key_id>.priv` vs `/etc/devloop/deploy_signing_priv`).  
   **Recommended fix:** Make one rotation sequence and one path convention authoritative and use it everywhere.

4. **Audit privilege descriptions still conflict with the append-only DB design** — **Sections:** §3.1.2, §3.1.3, §3.1.4, §3.1.5, §4.2  
   **Severity:** medium  
   **Problem:** Service sections still state direct `INSERT` on `audit_events` for multiple runtime roles, while §4.2 explicitly revokes direct DML and requires `append_audit_event()`. For an audit system, that ambiguity matters.  
   **Recommended fix:** Remove all direct-INSERT language from service role descriptions and make the stored-procedure-only model the sole documented path.

5. **Secret file permission narrative is inconsistent** — **Sections:** §4.3, §11  
   **Severity:** medium  
   **Problem:** The document says secret source files are mode `0400` and also says group read is granted to the relevant service user. Both cannot be true at once. `data_encryption_key` is also described as readable by both API and deployer via a single owner/group entry.  
   **Recommended fix:** Either switch to `0440` with explicit groups, or state clearly that the source files are root-readable only and systemd `LoadCredential` is the mechanism that hands credentials to services.

6. **Threat-model asset inventory is not aligned with the actual storage model** — **Sections:** §4.3, §5.5, §17.1  
   **Severity:** medium  
   **Problem:** §17.1 says GitHub App key, OpenAI key, and signing key are stored in the central DB, but §§4.3/5.5 say they are file-backed only. This is inaccurate threat-model documentation.  
   **Recommended fix:** Update §17.1 and related text so the asset inventory matches the actual storage locations.

## Suggestions (optional improvements)
- Generate the role/privilege matrix in the doc from migrations or a single source file; drift is already visible.
- Add a one-page “lease/renew owner by stage” table covering `module_locks`, `deploy_mutex`, `jobs.lease_until`, and `agent_tasks.heartbeat_at`.
- Store the desired-state signed blob as an opaque field returned verbatim by the API; avoid reconstructing anything on the host.
- Add an install-time self-test that validates every declared OS user can read/write exactly the paths and sockets it needs.
- Rename the duplicate §7.2.1 subsections to avoid citation ambiguity.

## Strengths
- The single-operator trust model is stated honestly; central compromise is explicitly documented as accepted v1 risk.
- Separation of OS users, Postgres roles, and service credentials is materially better than earlier drafts.
- The pull-based deploy model plus host-side signature verification and local policy constraints is a good MVP defense-in-depth design.
- `desired_state_history` with host echoing `desired_state_id` is a strong improvement for idempotency and auditability.
- LISTEN/NOTIFY is correctly treated as an optimization, with periodic reconciler loops as the real durability backstop.
- The host release-directory pattern and atomic cutover / revert split are well thought through.
- The audit-chain design is much stronger now that DB-side append procedures and immutability triggers are specified.

## Open questions central must resolve
- Does worker manager own task-state transitions directly, or does it emit IPC to orchestrator and let orchestrator mutate DB state? The doc currently implies both.
- If module locks remain held past `in_progress`, which exact component renews them in `review`, CI wait, `verifying`, and rollback?
- Does Claude CLI actually support a UNIX-socket HTTP CONNECT proxy in the exact form shown, or is a shim/proxy adapter required?
- Are rollback checkpoint fields such as `rollback_pr_number` and `rollback_commit_sha` already present in the inherited v2 schema, or do they still need to be made explicit in v4?