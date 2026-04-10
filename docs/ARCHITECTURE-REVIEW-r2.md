# Architecture review — round 2

**Reviewer:** gpt-5.4 (reasoning_effort=high)
**Document reviewed:** /opt/devloop/docs/ARCHITECTURE.md
**Date:** 2026-04-10

**Tokens:** prompt=16273 completion=19284, reasoning=15357

---

## Verdict
changes_requested

## Critical issues (must fix before approval)
1. **Internet-exposed services share one OS identity and receive all secrets** — **Sections:** §3.1, §3.2, §3.3, §4.1, §11  
   **Severity:** critical  
   **Problem:** The frontend, public backend, and worker manager all run as `devloop-runtime`, and §11 says **all units** receive `openai_api_key`, `jwt_secret`, `data_encryption_key`, `github_app_private_key`, and `deploy_signing_private_key`. With peer auth in §4.1, compromise of any internet-facing process can become DB compromise and deploy-signing compromise. This collapses the intended trust boundaries.  
   **Recommended fix:** Split processes by privilege and OS identity. At minimum: frontend on its own user with no DB access and no secrets; public API on a separate user/role with only session/auth/report intake privileges; privileged reviewer/deployer/signer services isolated behind internal queues with separate DB roles and only the secrets they need. Do not load all credentials into all units.

2. **The claimed blast-radius reduction is not actually achieved** — **Sections:** §1 (Goal 6), §2.2, §3.4.2, §5.5, §7.5  
   **Severity:** critical  
   **Problem:** The same central control plane authors code, reviews it, merges it via GitHub write privileges, and signs desired state. The host deploy agent only verifies a signature from central plus local allowlist policy. A compromised central can still create malicious commits within allowed paths, merge them, and cause deployment. The pull model removes push transport, but not concentrated authority.  
   **Recommended fix:** Either redesign with a genuinely independent trust domain, or change the threat model and remove Goal 6. For approval, the architecture must be truthful about central-compromise consequences. A defensible redesign would require host-side verification against an authority central cannot unilaterally forge (e.g., separate signer/HSM, separate merge authority, or independently verified provenance constraints).

3. **Deploys are not serialized per project; `desired_state` last-writer-wins is unsafe** — **Sections:** §4.2 (`desired_state`), §7.5, §8 (“Two deploys to the same project race”)  
   **Severity:** critical  
   **Problem:** A single `desired_state` row with overwrite semantics is not sufficient. Two approved tasks for the same project can race, causing one deployment intent to overwrite another before verification completes. That breaks causality, makes rollback ambiguous, and can skip validation of an earlier merged fix. “Audit any overwrites” is not an acceptable recovery model for production deploy control.  
   **Recommended fix:** Introduce a per-project deploy mutex/queue and serialize deployment/verification/rollback. Replace overwrite-only state with a versioned `desired_state_history` plus compare-and-set sequence numbers. Rollback must target a specific deployed version, not “whatever the previous row was.”

4. **`blocked` recovery violates the lock invariant** — **Sections:** §6.2, §7.2.1  
   **Severity:** critical  
   **Problem:** §6.2 says moving to `blocked` automatically releases the module lock. The same section also allows `blocked -> assigned`. That permits a task to re-enter `assigned` without reacquiring the lock, contradicting the rest of the design where `assigned` means the task is the active lock holder.  
   **Recommended fix:** Change recovery to `blocked -> queued_for_lock`, or explicitly reacquire the lock atomically in the same transaction as the transition back to `assigned`. Document the invariant: a task may only be `assigned`/`in_progress` if it currently holds the module lock.

5. **Heartbeat and lease handling for `review` is internally inconsistent** — **Sections:** §4.2 (`agent_tasks` index on `('in_progress','review')`), §7.4, §8  
   **Severity:** critical  
   **Problem:** `review` tasks are included in heartbeat-based stale detection, but the reviewer flow does not renew `heartbeat_at`. The janitor described in §8 can therefore fence or recycle legitimate review work. More broadly, worker liveness and queue-claim liveness are conflated.  
   **Recommended fix:** Separate worker heartbeats from stage ownership. Use `heartbeat_at` only for worker-owned execution, and rely on `jobs.lease_until` for reviewer/deployer stages unless those stages also renew a dedicated task lease. Recovery logic must be stage-specific and explicit.

6. **Deploy timeout behavior and crash recovery are not consistently defined** — **Sections:** §7.5 step 12, §8 (“Host deploy agent unreachable”), §3.1 (`jobs`)  
   **Severity:** critical  
   **Problem:** §7.5 says host apply failure/timeout transitions to `rolling_back`; §8 says the same condition transitions to `failed`. In addition, the GitHub side-effect sequence (create PR, wait CI, merge, write desired state) is not idempotently specified. A crash after merge but before DB persistence is a realistic case and currently underdefined.  
   **Recommended fix:** Define one authoritative timeout path and encode it in the state machine. Add explicit idempotent checkpoints: persist PR number before waiting, detect already-merged branches on retry, persist merged SHA before issuing desired state, and make retries resume from durable checkpoints rather than replay API side effects.

7. **GitHub branch-protection prerequisites are missing, so review/CI are bypassable** — **Sections:** §5.5, §7.5, §13.3  
   **Severity:** critical  
   **Problem:** The design assumes non-bypassable review and CI, but there is no requirement that the repo’s default branch is protected, that direct pushes are disabled, that required checks exist, or that the App cannot bypass them. With `contents: write`, a misconfigured repo defeats the architecture’s safety claims.  
   **Recommended fix:** Make branch-protection validation a hard onboarding prerequisite and periodic compliance check. Require: protected default branch, no direct push by the App to default, required status checks configured, and merge constraints matching the deploy flow.

8. **Host-side GitHub fetch credentials are missing from the architecture** — **Sections:** §3.4.2, §7.5, §13.5  
   **Severity:** critical  
   **Problem:** The deploy agent is expected to `git fetch origin` exact SHAs, but the document never defines how the host authenticates to GitHub for a private repo, how those credentials are stored, rotated, or scoped. This is a missing production dependency at the deploy boundary.  
   **Recommended fix:** Add a host-side read-only GitHub credential model now: deploy key, read-only GitHub App installation, or fine-grained read token. Specify storage location, rotation process, blast radius, and install steps.

9. **The Claude execution model is still unresolved and contradictory** — **Sections:** §3.2, §7.3 step 7, §14 question 9  
   **Severity:** critical  
   **Problem:** The document describes both running the Claude CLI inside the sandbox and calling Anthropic from the worker manager via SDK, then states the decision is pending. This is the core execution path for the system. As written, the architecture is not executable.  
   **Recommended fix:** Choose one model before implementation and specify it fully: where model inference happens, what runs in the sandbox, what data crosses the process boundary, what network policy is required, and how outputs become filesystem changes.

10. **Deploy-signing key management is inconsistent between global-key and per-project-key models** — **Sections:** §2.2, §4.2 (`projects.deploy_signing_pubkey`), §4.3, §11, §13.3  
   **Severity:** critical  
   **Problem:** §13.3 says a keypair is generated per project, but §11 loads a single `deploy_signing_private_key` credential into units. The schema stores public keys per project but does not define where corresponding private keys live, how key IDs are conveyed, or how rotation works. This is a core security boundary.  
   **Recommended fix:** Pick one coherent design: either one global signing key with explicit `key_id` and rotation protocol, or per-project keys stored in a proper secrets store with versioning. Define canonical signed payload format, host behavior during rotation, and recovery from compromise.

## Important issues (should address)
1. **`quota_usage` schema and reservation SQL are incorrect as written** — **Sections:** §4.2 (`quota_usage`)  
   **Severity:** high  
   **Problem:** The table definition shows both `period_key` as a primary key and a composite primary key `(period_key, project_id, metric)`. Also, using `project_id = $2` will not match rows where `project_id IS NULL` for global quotas.  
   **Recommended fix:** Correct the schema to a single composite key or split global/project quotas into separate tables. Use `IS NOT DISTINCT FROM` or separate SQL paths for global rows.

2. **Audit hash-chain construction is not concurrency-safe as specified** — **Sections:** §4.2 (`audit_events`)  
   **Severity:** high  
   **Problem:** The document describes `chain_prev_id`/`chain_hash` but does not define a serialized DB-side insert algorithm. Concurrent inserts can fork the chain or compute against the same predecessor, creating false tamper alerts or ambiguity.  
   **Recommended fix:** Compute chain linkage in the DB under an advisory lock or single-row chain-head table, or partition chains explicitly. If chain integrity matters, make the insertion algorithm deterministic and testable.

3. **Atomicity claim for lock acquisition + task readiness is not fully specified** — **Sections:** §0, §7.2  
   **Severity:** high  
   **Problem:** The summary claims lock acquisition and task readiness are atomic together, but §7.2 narrates lock acquisition, task insert, and worker-job insert as separate steps without explicitly putting them in one transaction. A crash between them can strand locks or orphan tasks/jobs.  
   **Recommended fix:** State and implement one DB transaction covering lock acquire, `agent_tasks` insert/update, job enqueue, and audit emission. Add failure-injection tests around every boundary.

4. **Core project/agent configuration model is missing from the schema** — **Sections:** §3.3, §7.2.1, §7.3.1  
   **Severity:** high  
   **Problem:** The workflow depends on `classifier_rules`, agent roles, allowed file paths, build/test commands, and likely branch naming conventions, but these are not represented in the schema or versioned config model. That makes multi-project rollout and migration unclear.  
   **Recommended fix:** Add explicit config tables or a versioned signed config artifact model. Include validation, auditability, and migration strategy.

5. **`/devloop-host/version` authentication and rotation are incomplete** — **Sections:** §3.4.1, §5.4, §13.4  
   **Severity:** high  
   **Problem:** The endpoint requires a separate bearer credential “rotated daily,” but there is no provisioning flow, no rotation protocol, and the install steps do not include it.  
   **Recommended fix:** Either fully specify this credential lifecycle or remove the endpoint and use a different verification mechanism.

6. **Worker and deploy logs can leak secrets/PII to central** — **Sections:** §3.2, §4.2 (`desired_state.applied_log`), §9  
   **Severity:** high  
   **Problem:** Worker stdout/stderr and deploy logs are captured centrally, and `applied_log` is stored as unbounded text. Build/deploy output commonly contains secrets, paths, stack traces, and customer data. Redaction is not defined.  
   **Recommended fix:** Add redaction rules, size caps, retention limits, and least-privilege UI access. Prefer storing truncated excerpts plus hashes, with full logs kept locally on the host unless explicitly needed.

7. **Host deployment checkout is not clean or atomic** — **Sections:** §3.4.2, §13.5  
   **Severity:** high  
   **Problem:** `git fetch && git checkout <sha>` on a mutable working tree can preserve local residue, leave dirty state after failed builds, and make later deploys nondeterministic.  
   **Recommended fix:** Use a clean worktree or fresh clone per deploy, `reset --hard` + `clean -fdx`, and switch atomically (e.g., release directory/symlink pattern). Persist an explicit last-known-good release pointer.

8. **Workers share a loopback-enabled network namespace they do not need** — **Sections:** §3.2  
   **Severity:** high  
   **Problem:** The document says “none for now” with respect to local sockets, but workers are still placed in a shared loopback-only netns. That needlessly permits cross-worker communication and future accidental exposure of local services.  
   **Recommended fix:** Give each worker its own private netns or no network namespace at all if no networking is required.

9. **Reporter secret handling is inconsistent with the deploy-agent standard** — **Sections:** §3.4.1, §13.4  
   **Severity:** medium  
   **Problem:** The deploy agent explicitly avoids env vars to reduce leakage, but the host adapter still uses `DEVLOOP_HOST_TOKEN` in environment variables.  
   **Recommended fix:** Use the same secret-handling standard on hosts for both components, or clearly justify why the reporter threat model is different.

10. **Backup/restore remains too high-level for a single-operator production system** — **Sections:** §0, §4.3, §11, §13, §14  
   **Severity:** high  
   **Problem:** The document mentions DB + artifacts + key escrow, but not the full backup set, encryption, restore order, RPO/RTO, or restore-test cadence. Bare clones, config, credentials, and audit verification state are all operationally relevant.  
   **Recommended fix:** Define an explicit backup matrix and tested restore procedure, including secrets recovery assumptions, desired-state history, repo mirrors, and quarterly restore drills.

11. **HTTPS and endpoint validation are not enforced in the data model/install flow** — **Sections:** §4.2 (`projects.host_base_url`), §13.3, §13.5  
   **Severity:** medium  
   **Problem:** `host_base_url` is free-form and the install steps do not require HTTPS-only transport, certificate validation rules, or restrictions on internal/private address targets.  
   **Recommended fix:** Enforce `https://` for production projects, validate certificates/hostnames, and explicitly document any exceptions for development.

12. **Current-state-only `desired_state` weakens forensics and recovery** — **Sections:** §4.2 (`desired_state`)  
   **Severity:** medium  
   **Problem:** Overwriting the single current row loses structured deploy intent/apply history. Audit logs help, but not as a first-class deployment ledger.  
   **Recommended fix:** Add an append-only `desired_state_history` table keyed by project and sequence number, and keep `desired_state` as a materialized current pointer if needed.

## Suggestions (optional improvements)
- Add a dedicated signer service or HSM/KMS-backed signing path so deploy signatures are not issued by the same public runtime that handles browser and host traffic.
- Add failure-injection tests for every deploy boundary: after PR creation, after CI pass, after merge, after desired-state write, after host apply acknowledgment, and during rollback.
- Consider a smaller-TCB implementation language for the host deploy agent if it is intended to be the “security keystone.”
- Add continuous repo-configuration checks in the admin UI: branch protection, required checks, App permissions, and webhook/Actions status.
- Consider commit provenance/attestation verification on the host side rather than trusting only central-issued desired state.
- Add explicit retention policies for reports, artifacts, screenshots, and deploy logs.

## Strengths
- Good move from push-based deployment to a pull-based host deploy agent (§2.2).
- Durable `jobs` table with `LISTEN/NOTIFY` only as a wake-up path is the right direction (§3.1, §4.2).
- Removing direct DB access and internal tokens from Claude is a major improvement (§0, §7.3).
- Fenced task mutations with `lease_version` and explicit lock renewal materially improve stale-worker safety (§0, §4.2, §6.3).
- Audit immutability via DB privileges plus trigger is stronger than app-only enforcement (§0, §4.2).
- Atomic quota reservation before external API calls is well considered (§0, §4.2, §10).
- The document is much more explicit about state machines and transitions than most drafts of this type (§6).

## Open questions central must resolve
- What is the accepted threat model for central compromise? Is central compromise allowed to equal repo/deploy compromise, or is an independent admission authority required?
- What is the final Claude execution architecture: SDK outside sandbox, CLI inside sandbox, or something else?
- Is deploy signing global or per-project, and what is the rotation/versioning protocol?
- How will host servers authenticate read-only fetches from GitHub for private repositories?
- What onboarding checks will enforce GitHub branch protections and non-bypassable CI?
- How are agent roles, classifier rules, allowed paths, and build/test commands stored, versioned, and migrated?
- How will deploys be serialized per project, and what is the authoritative version/sequence mechanism?
- Will `/devloop-host/version` remain in the design, and if so how are its credentials provisioned and rotated?