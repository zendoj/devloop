# Architecture review — round 6

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=37961 completion=18750, reasoning=15870

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Runtime RBAC and mutation boundaries are still internally inconsistent** — **Sections:** §3.1.3, §3.1.4, §3.1.5, §4.1, §6.4, §19  
   **Severity:** critical  
   **Problem:** The document still describes direct runtime DML that bypasses the DB-enforced state-machine/audit model it claims to rely on. Examples: §3.1.3 gives orchestrator direct `audit_events` insert capability; §3.1.4 and §3.1.5 describe direct `agent_tasks.status` updates; §4.1 still mentions `desired_state_current`. That conflicts with §6.4 (“No mutations bypass this function”) and §19’s “authoritative” stance. In a system like this, the architecture must make one enforcement model true at the DB boundary, not just in app code.  
   **Recommended fix:** Make the DB mutation model canonical and exclusive: revoke direct runtime writes to `agent_tasks.status`, `module_locks`, `deploy_mutex`, `desired_state_history`, and `audit_events`; grant only `EXECUTE` on the specific SECURITY DEFINER procedures/functions needed (`fence_and_transition`, `refresh_task`, `record_desired_state`, `deploy_mutex_*`, `append_audit_event`, etc.). Then update §3 and §4 so the privilege story is consistent everywhere.

2. **`rollback_failed` can let a second task enter `deploying` before mutex acquisition** — **Sections:** §4.2, §7.5 steps 2–3, §19 D5–D6  
   **Severity:** critical  
   **Problem:** On `rollback_failed`, the design retains the `deploy_mutex` (§19 D5), but the deploy-stage uniqueness index excludes `rollback_failed` (§4.2), and the deployer transitions `approved → deploying` *before* acquiring the mutex (§7.5). Result: a new task on the same project can legally enter `deploying`, then fail to acquire the retained mutex, at which point the document calls the situation “inconsistent” after the state change has already occurred. That is a real state-machine hole, not a mere documentation issue.  
   **Recommended fix:** Make deploy admission atomic. Acceptable fixes include:  
   - acquire/check `deploy_mutex` before transitioning into any deploy-stage status, or  
   - move mutex acquisition into `fence_and_transition()` for `approved → deploying`, or  
   - extend the DB invariant so `rollback_failed` also blocks new deploy-stage entry until manual clear.  
   The important point is: a task must not be able to reach `deploying` unless it has the project deploy slot.

3. **Worker-manager filesystem permissions break post-run inspection and cleanup** — **Sections:** §3.2 (filesystem prep steps 3–4), §7.3 steps 4 and 6, §11  
   **Severity:** critical  
   **Problem:** §3.2 and §11 say the per-task workspace and credential directory are chowned to `devloop-worker:devloop-worker`. But §7.3 requires `devloop-wm` to run `git status`, inspect commits, and shred/remove the per-task credential file after Claude exits. With the ownership/mode shown, `devloop-wm` no longer has access. This is a real functional bug on the main execution path.  
   **Recommended fix:** Redesign the per-task directory ACL/ownership model so both `devloop-worker` and `devloop-wm` have the specific access they need. For example: workspace owned by `devloop-worker:devloop-fs` with `0770`, plus ACLs if needed; credential directory readable by `devloop-worker` but removable by `devloop-wm` after exit. Also document which user runs the delayed cleanup timer.

4. **GitHub merge is still not crash-idempotent** — **Sections:** §7.5 step 7, §7.5 step 10, §7.5 checkpoint summary  
   **Severity:** critical  
   **Problem:** The PR-creation gap was fixed, but the same problem still exists for merge. If GitHub accepts the merge and the process crashes before `merged_commit_sha` is persisted, resume logic sees `merged_commit_sha IS NULL` and re-enters the merge path. There is no documented “read PR state first” recovery step to detect an already-merged PR and recover the merge commit SHA. The same hole exists for rollback merge and `rollback_commit_sha`.  
   **Recommended fix:** Before any merge API call, query the PR first. If it is already merged, persist `merge_commit_sha`/`rollback_commit_sha` from GitHub and continue. Only call the merge endpoint if the PR is still open and the expected head SHA matches. Update the checkpoint summary to include these cases explicitly.

5. **Retry-accounting references a schema field that does not exist** — **Sections:** §7.5 step 1, §4.2 `agent_tasks`  
   **Severity:** critical  
   **Problem:** §7.5 step 1 says deployer increments `retry_count` only if `retry_count_last_incremented_at < claimed_at`, but §4.2 defines `retry_count` and does not define `retry_count_last_incremented_at` (or any equivalent field). That makes retry-budget behavior non-implementable as written on a critical recovery path.  
   **Recommended fix:** Add the missing schema field and its update rules, or replace this logic with a different, fully specified attempt-accounting mechanism tied to the job lease/claim token. Then sync §4.2, §7.5, and §19 D22.

6. **The network trust-boundary documentation is still not honest about actual v1 behavior** — **Sections:** §2.1, §2.2, §3.1.7, §7.5 step 9, §19 D15  
   **Severity:** critical  
   **Problem:** §19 D15 correctly says egress-proxy enforcement is only for sandboxed Claude in v1. But §2.2 still says Reviewer → OpenAI and Deployer → GitHub go “via egress proxy,” and §2.2 also says Deployer → host adapter is “not used” while §7.5 step 9 has the deployer probing host health. That overstates isolation and understates outbound trust edges. Per your rubric, dishonest/stale threat-surface documentation is blocking.  
   **Recommended fix:** Rewrite §2.1/§2.2 to match actual v1 behavior exactly: reviewer and deployer have direct outbound AF_INET, and central does perform host-health GETs if that remains in the design. If a different component should perform that probe, document that instead and remove the contradictory edge.

## Important issues (should address)
1. **Branch naming is still inconsistent on the worker/deployer path** — **Sections:** §3.2 step 1, §7.5 step 4, §19 D10  
   **Severity:** high  
   **Problem:** The sandbox worktree is created on `experiment2/agent/<agent>/<displayId>` in §3.2, while §7.5/§19 D10 say agent branches are `devloop/task/<task_id>`. Since PR idempotency and recovery depend on deterministic branch naming, the doc needs one clear story for local branch name vs remote ref name.  
   **Recommended fix:** Either create the local worktree on the canonical `devloop/task/<task_id>` branch too, or explicitly document the local→remote mapping and where it is persisted.

2. **Secret-storage details still drift across sections** — **Sections:** §4.3, §5.4, §11, §17.1, §19 D9/D13  
   **Severity:** high  
   **Problem:** §4.3 still references `/etc/devloop/deploy_signing_priv` and says secret files are mode `0400`, while §5.4/§11/§19 use `/etc/devloop/deploy_signing_priv_<key_id>` and `0440`. §17.1 then reintroduces DB-resident GitHub/OpenAI/signing secrets in the asset list. These are exactly the kinds of cross-section drifts v6 claims to have eliminated.  
   **Recommended fix:** Normalize all secret path/mode/storage text to the §19 decisions and remove stale storage claims from §4.3/§17.1.

3. **Credential-file cleanup timing is contradictory** — **Sections:** §3.2, §7.3, §19 D23  
   **Severity:** high  
   **Problem:** §3.2 says the per-task Anthropic key is shredded after Claude exits; §7.3 says immediate cleanup occurs “at task terminal state.” Those are not equivalent. Waiting until task terminal leaves a reusable API credential on disk across review/deploy stages.  
   **Recommended fix:** Make the rule explicit: shred the per-task credential immediately after sandbox exit, regardless of later task status; only the worktree remains for 24h.

4. **Failure-mode table still drifts from the canonical retry rule** — **Sections:** §7.5, §8, §19 D12/D22  
   **Severity:** medium  
   **Problem:** §8 still says some external dependency failures (“OpenAI / GitHub / Anthropic API down”, “Egress proxy crash”) lead to `blocked`, while the canonical deploy/review recovery rule says crash/retry exhaustion semantics drive `failed`. Operators need one consistent failure taxonomy.  
   **Recommended fix:** Reconcile §8 row-by-row against §7.5/§19 so each failure has exactly one terminal behavior.

5. **The Claude→proxy transport mechanism is not concrete enough for a critical path** — **Sections:** §3.2, §3.1.7  
   **Severity:** medium  
   **Problem:** The sandbox sets `HTTP_PROXY`/`HTTPS_PROXY` to `unix:///run/egress.sock`, but the document does not state the exact, tested mechanism by which Claude CLI will speak to an HTTP CONNECT proxy over a UNIX socket. If the CLI/runtime stack does not support that proxy URL form, the core worker path will not function.  
   **Recommended fix:** Commit to a concrete, tested mechanism: either documented native CLI support, or a small shim/bridge inside the sandbox. This should not remain implicit.

## Suggestions (optional improvements)
- Add an explicit crash-window test matrix for: PR created/DB write failed, merge succeeded/DB write failed, rollback merge succeeded/DB write failed, WM restart during sandbox run, and `rollback_failed` recovery.
- Generate the privilege matrix in §3/§4 from migrations or from one source file to stop cross-section drift.
- Add a DB constraint or transition-guard coverage table for all status-dependent nullable columns (`github_pr_number`, `merged_commit_sha`, `applied_desired_state_id`, `rollback_pr_number`, `rollback_commit_sha`).
- Document host-side/manual recovery commands alongside the `rollback_failed` policy so Jonas has an executable runbook, not just a state label.

## Strengths
- §17 is materially more honest than earlier versions about the single-operator trust model and accepted residual risk.
- The host deploy agent flow in §3.4.2 is well thought through: atomic symlink swap, explicit pre/post-cutover split, local rollback, and halt-on-unknown-state are all solid choices for this scope.
- The desired-state signing model (§4.2, §5.4) is strong for an MVP: Ed25519, raw signed bytes stored verbatim, no host-side re-canonicalization, and out-of-band pubkey rollout.
- The combination of reconciler polling, fenced transitions, and persisted checkpoints is a good production pattern for this kind of autonomous workflow.
- The DB-level deploy-stage uniqueness invariant is a good defense-in-depth addition.
- The audit append path is much better than typical MVPs: append-only, serialized chain extension, and explicit DB-level mutation blocking.

## Open questions central must resolve
- After fixing the RBAC drift, is the intent **fully proc-only DB mutation**, or are some direct column updates still intentionally allowed?
- Which invariant should actually gate new deploys after `rollback_failed`: deploy mutex availability, task-status uniqueness, or both?
- What exact mechanism will Claude CLI use to reach the UNIX-socket proxy, and has it been tested with the chosen CLI/runtime version?
- Which component is the authoritative caller for the post-apply external health probe: deployer or Public API health-monitor?
- Which OS user/service owns the 24h worktree cleanup and how will it retain the permissions needed once the per-task directory ownership model is corrected?