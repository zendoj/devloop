# Architecture review — round 5

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=32612 completion=18555, reasoning=15356

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Heartbeat lease self-fences the current owner** — §6.3, §3.2, §7.3  
   **Severity:** critical  
   **Problem:** `heartbeat_task()` increments `agent_tasks.lease_version` on every heartbeat but returns only `boolean`. The caller therefore has no way to learn the new lease version and will use a stale `expected_lease` on the next heartbeat or transition, causing false fencing under normal operation. The same function also renews `module_locks` without checking that exactly one lock row was updated, so a task can continue after silently losing its lock.  
   **Recommended fix:** Make heartbeat one of:
   - non-fencing for the task row (`heartbeat_at` only; do **not** bump `agent_tasks.lease_version` on ordinary heartbeats), or
   - return the new task lease version (and, if needed, lock lease version) and require callers to replace their in-memory lease after every successful heartbeat.  
   Also enforce `ROW_COUNT = 1` on the `module_locks` renewal and fail/fence if the lock is absent or no longer held by the task.

2. **Deployer flow is missing the branch-push step it depends on** — §7.3, §7.5  
   **Severity:** critical  
   **Problem:** §7.3 says worker manager does not push to GitHub and that the deployer pushes the locally committed agent branch “at the start of its own stage.” But §7.5 has no such step. It immediately does `git ls-remote origin <agent_branch>` and expects `approved_head_sha`, which will fail if the branch exists only in the local bare mirror. This leaves the core deploy path incomplete.  
   **Recommended fix:** Add an explicit, checkpointed deployer step before freshness checks:
   - locate the approved local branch in the bare mirror,
   - push it to `origin` idempotently,
   - persist the branch name / remote ref checkpoint,
   - then run the remote freshness checks and PR creation flow.

3. **Stale deploy-mutex clearing allows overlapping logical deploy flows** — §4.2, §7.5, §8  
   **Severity:** critical  
   **Problem:** After a deployer crash, the janitor clears `deploy_mutex` once `expires_at` lapses, but the original task remains in `deploying` / `verifying` / `rolling_back`. A newer task can then acquire the mutex and emit a newer `desired_state_history` row while the old task still exists. The old task can later time out and enter rollback, potentially reverting the newer successful deploy. There is no invariant preventing multiple nonterminal deploy-stage tasks from being live for one project across crash recovery.  
   **Recommended fix:** Introduce a project-level active-deploy invariant that is independent of the heartbeat lease. A different task must not acquire the project deploy slot while another task is still nonterminal in `deploying` / `merged` / `verifying` / `rolling_back`. Crash recovery should transfer ownership of the **same** task, not free the project for unrelated tasks unless the prior task is explicitly abandoned/superseded in one transaction.

4. **`rollback_failed` lock and mutex semantics are contradictory** — §4.2, §6.2.1, §7.5, §8  
   **Severity:** critical  
   **Problem:** The document says opposite things about `rolling_back -> rollback_failed`:
   - §4.2 says deploy mutex is released on terminal transition `rollback_failed`
   - §6.2.1 says module lock is released on `rolling_back -> rollback_failed`
   - §7.5 step 10 says on rollback failure, “do not auto-release mutex or lock”
   - §8 repeats “mutex NOT auto-released”  
   This is a direct contradiction on a critical production recovery path.  
   **Recommended fix:** Choose one canonical policy and make §§4.2, 6.2.1, 7.5, and 8 all match it. Then encode that policy in `TaskStateService.transition()` and the DB procedures so it cannot drift.

5. **Sandbox networking as written is not executable under the declared unit hardening** — §3.2, §11  
   **Severity:** critical  
   **Problem:** §3.2 requires `devloop-wm` to run `ip netns add devloop-task-<id>`, but §11 runs worker manager as an unprivileged user with `NoNewPrivileges=true` and `RestrictAddressFamilies=AF_UNIX only`. An unprivileged process in that confinement cannot create named network namespaces via `ip`; that requires capabilities and netlink access the design does not grant.  
   **Recommended fix:** Either:
   - remove the `ip netns add` step entirely and rely on `bwrap --unshare-net`, or
   - introduce a narrowly scoped privileged helper with explicit capabilities and a documented API.  
   Also align the systemd hardening with the actual mechanism you choose.

6. **RBAC is still internally inconsistent on critical tables** — §3.1.3, §3.1.5, §3.1.6, §4.1, §4.2  
   **Severity:** critical  
   **Problem:** The document still gives incompatible descriptions of who may mutate security-sensitive data:
   - §3.1.3 says orchestrator has direct INSERT on `audit_events`
   - §4.2 says runtime roles have **no direct INSERT** and must use `append_audit_event()`
   - §4.1 still references `desired_state_current` even though it was removed
   - §4.1 and §3.1.6 disagree about direct worker-manager updates vs stored-procedure-only mutations  
   For a system that autonomously deploys to production, auth boundaries cannot be ambiguous.  
   **Recommended fix:** Add one authoritative privilege matrix and make all service sections reference it. Remove obsolete `desired_state_current` references everywhere. Ensure the prose, grant snippets, and stored-procedure boundaries are identical.

7. **Branch-name canonicalization is inconsistent between central and host policy** — §3.4, §4.2  
   **Severity:** critical  
   **Problem:** The host policy example uses `allowed_deploy_branches: [refs/heads/experiment2]`, while the signed payload example uses `"target_branch": "experiment2"`. §3.4 step 2 compares `target_branch` directly against the allowlist. As written, valid deploys can be rejected, or implementers will invent ad hoc normalization.  
   **Recommended fix:** Pick one canonical branch representation and enforce it end-to-end. Plain branch names are simplest and match GitHub’s default-branch APIs better than full refs. Validate and normalize both stored `target_branch` and host policy entries to that form.

8. **GitHub side-effect idempotency is incomplete around PR creation/revert creation** — §7.5  
   **Severity:** critical  
   **Problem:** The deployer claims crash-safe checkpointing, but steps 5 and 10 still have a classic side-effect gap: a PR or revert PR can be created in GitHub, then the DB transaction that persists `github_pr_number` / `rollback_pr_number` can fail. On retry, the current spec will create duplicates because the checkpoint is absent.  
   **Recommended fix:** Before creating a PR, do a deterministic recovery lookup (e.g. by task-specific branch, label, or title) and reuse an existing matching PR if present. Document the same recovery lookup for revert PRs. The written flow must cover “external call succeeded, DB write failed.”

## Important issues (should address)
1. **Bootstrap/deployment paths are not executable as written** — §3.1, §13.2  
   **Severity:** high  
   **Problem:** Component layout says `runtime/api/`, `runtime/orchestrator/`, `runtime/reviewer/`, `runtime/deployer/`, etc., but §13.2 builds `runtime/backend` and runs migrations from `runtime/backend/dist/migrations/run.js`. That does not match the stated topology.  
   **Recommended fix:** Update §13.2 to the actual repository/package layout and exact migration entrypoint.

2. **Restore runbook still references the removed `/version` endpoint** — §3.3, §18.2  
   **Severity:** high  
   **Problem:** §3.3 explicitly removes `/version`, but §18.2 step 9 still tells the operator to query `/devloop-host/version`.  
   **Recommended fix:** Replace that step with the real recovery check, e.g. deploy-agent `state.json`, current symlink target, or GitHub + host local state comparison.

3. **Threat-model asset inventory still contradicts the chosen storage model** — §17.1, §4.3  
   **Severity:** high  
   **Problem:** §17.1 says the asset inventory reflects file-backed secret storage, then immediately lists “Secrets stored in central DB (GitHub App key, OpenAI key, signing key, 2FA secrets).” That is false per §4.3 and weakens the document’s credibility.  
   **Recommended fix:** Split assets into:
   - file-backed runtime secrets on disk
   - DB-resident encrypted/user data (`two_factor_secret`, token digests, etc.)

4. **Egress proxy is not actually enforced for reviewer/deployer** — §2.1, §2.2, §3.1.7, §11  
   **Severity:** medium  
   **Problem:** Trust-boundary diagrams say reviewer and deployer call external APIs “via egress proxy,” but the units are allowed direct AF_INET/AF_INET6 outbound and no firewall/netns rule forces proxy-only egress. For those services, the proxy is currently descriptive, not enforced.  
   **Recommended fix:** Either enforce proxy-only egress (nftables owner rules, per-service network namespaces, etc.) or rewrite the security claims so only sandboxed Claude is described as proxy-enforced in v1.

5. **Signing-key file paths are inconsistent** — §4.3, §5.4, §11  
   **Severity:** medium  
   **Problem:** §4.3 uses `/etc/devloop/deploy_signing_priv`, while §5.4 and §11 use `/etc/devloop/deploy_signing_priv_<key_id>` plus `deploy_signing_active_key_id`.  
   **Recommended fix:** Keep one canonical path scheme and propagate it to the secret inventory, rotation protocol, and systemd `LoadCredential` examples.

6. **Worktree retention and cleanup contradict each other** — §7.3  
   **Severity:** medium  
   **Problem:** Step 6 says worktrees are retained for 24h for debugging, but also says `git worktree remove --force` as cleanup. Those are not compatible if both happen immediately.  
   **Recommended fix:** Separate immediate credential cleanup from delayed worktree removal and state exactly when each happens.

7. **Deploy-agent health check input is unspecified** — §3.4  
   **Severity:** medium  
   **Problem:** Step 13 uses `http://localhost:<health_port>/healthz`, but no `health_port`, `healthcheck_url`, or `healthcheck_command` exists in the deploy-agent config example.  
   **Recommended fix:** Add an explicit health-check configuration field and use that consistently in deploy verification.

8. **`project_config_id` / `project_config_version` terminology still drifts** — §4.2  
   **Severity:** low  
   **Problem:** `agent_tasks` stores `project_config_id`, but the `project_configs` section still says running tasks record `project_config_version`.  
   **Recommended fix:** Normalize all prose to `project_config_id` unless a separate version field is actually stored.

## Suggestions (optional improvements)
- Add a single appendix with:
  - task states
  - who owns heartbeat in each state
  - whether module lock is held
  - whether deploy mutex is held
  - what releases each lock/mutex
- Add an invariant at the DB level preventing more than one nonterminal deploy-stage task per project if that matches the intended design.
- Make PR/revert branch names deterministic from `task_id` so recovery lookups are straightforward.
- Add integration tests for the exact crash windows around:
  - PR creation before DB commit
  - merge before DB commit
  - host apply timeout followed by deployer restart
  - stale mutex clearing
- Consider storing a `desired_state_superseded_by` pointer if later deploys are ever allowed to overtake earlier verifying tasks.
- Add a small “authoritative interfaces” section for the egress proxy and worker-manager IPC payload schemas.

## Strengths
- The single-operator trust model is mostly documented honestly, including the accepted consequence that central compromise implies production compromise.
- Separation of OS users, Postgres roles, and per-service credentials is substantially better thought through than a typical MVP.
- The host-side pull model with signed desired state and local policy checks is a strong defense-in-depth choice for this scope.
- The release-directory deployment pattern and explicit pre-cutover vs post-cutover failure split are well designed.
- The move to append-only `desired_state_history` with per-project `seq_no` is sound.
- The document correctly recognizes LISTEN/NOTIFY as an optimization and includes reconcilers/polling backstops.
- Audit append-only enforcement at the DB boundary is much better specified than in earlier drafts.

## Open questions central must resolve
- What is the exact canonical branch format everywhere: `main` / `experiment2` or full refs like `refs/heads/main`?
- What exact mechanism will the deployer use to push the local approved branch to GitHub before PR creation, and where is that checkpoint persisted?
- Will ordinary heartbeats fence by changing `agent_tasks.lease_version`, or is lease version reserved only for ownership changes/reclaims?
- What is the canonical policy for `rollback_failed`: release mutex, hold mutex, release module lock, or hold both?
- Is proxy-only egress for reviewer/deployer a real control in v1, or only for sandboxed Claude?
- What config source defines the deploy agent’s local health check target?