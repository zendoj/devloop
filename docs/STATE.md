# DevLoop — Build State

**Last updated:** 2026-04-11 (Fas 5 lit the full pipeline end-to-end)
**Current branch:** `main` — local HEAD in sync with `origin/main`
**Status:** **Phase 5 complete.** The DevLoop central runtime now drives a real end-to-end loop: a bug filed via `POST /api/reports` classifies → creates a queued task → acquires a module lock → a worker clones the project repo + commits a stub fix to a `devloop/task/T-N` branch + pushes to GitHub → a reviewer fetches the diff via the GitHub Compare API and runs gpt-5.4 reasoning=medium on it → the task is approved → the deployer Ed25519-signs a canonical JCS desired-state payload and calls `record_desired_state` → a host agent (dry-run) drives the apply lifecycle → the deployer's verifier transitions the task to `verified`.

Every transition is audited via the hash-chained `audit_events` table. The whole loop takes ~20–30 seconds per bug on a cold cache. Verified with 7 end-to-end runs (T-3..T-9 all `verified`).

**The Fas 3 worker is still a stub** — it appends a marker note to `DEVLOOP_TASKS.md` instead of running Claude in a sandbox. Everything ELSE on the path is real: real repos, real signing, real reviews, real audit. Swapping the stub for Claude is the only remaining piece before this is a real product.

This file tracks *what is built right now*. For the full design see
[ARCHITECTURE.md](ARCHITECTURE.md); for how to operate it see
[RUNBOOK.md](RUNBOOK.md).

Whoever picks this up next: start here, then skim commit messages
from `a7f6d8f` (Fas 0.4) forward — each commit explains the phase,
the review rounds, and the verification that was done.

---

## Overview

DevLoop is a central runtime for AI-assisted bug fixing across multiple
host projects. Hosts run a thin deploy agent; everything else
(orchestration, review, deploy signing, audit chain) lives in central.
This repository contains the central runtime.

Reachable at: **https://devloop.airpipe.ai**

Tech:
- **API:** NestJS 11 + Fastify 5 + TypeORM 0.3 (raw SQL, no entity classes yet)
- **Web:** Next.js 15 (App Router, Server Components, vanilla CSS)
- **DB:** Postgres 16 via Unix-socket peer auth
- **Runtime host:** this machine; Nginx in front (FileMaker's bundled nginx, which `include`s `/etc/nginx/sites-enabled/*`)

---

## Phase status

| Phase | Scope | Status | Commit | Review |
|---|---|---|---|---|
| 0.1 | NestJS scaffold, strict 127.0.0.1 bind, sync-guard | ✓ | (pre-a7f6d8f) | — |
| 0.2 | TypeORM DataSource, migration runner, enums (migration 001) | ✓ | `43e671a` | — |
| 0.3 | users, sessions, projects, audit chain (migrations 002-003) | ✓ | `77a656a` | — |
| 0.4 | agent_tasks, module_locks, deploy_mutex (migration 004) | ✓ | `a7f6d8f` | — |
| 0.5 | state-machine SECURITY DEFINER procs (migration 005) | ✓ | `3925398` | — |
| 0.6 | jobs queue, quota reservation (migration 006) | ✓ | `2480d3c` | — |
| 0.7 | deploy-path tables + host apply lifecycle (migration 007) | ✓ | `c1d3ca7` | gpt-5.4 medium, 4 rounds → approved |
| 0.8 | host_health, host_health_alerts, branch_protection_checks (migration 008) | ✓ | `c71056c` | gpt-5.4 medium, 2 rounds → approved |
| 0.9a | Argon2id passwords + DB-backed sessions + login/logout (migrations 009-010) | ✓ | `3d04612` | gpt-5.4 medium, 2 rounds → approved |
| 0.9b | TOTP 2FA + AES-256-GCM data encryption + HKDF challenge tokens (migration 011) | ✓ | `cdec99a` | gpt-5.4 medium, 1 round → approved |
| 0.9c | Bootstrap admin CLI + Next.js login frontend + Nginx vhost + systemd | ✓ | `04d0162` | gpt-5.4 medium, 1 round → fixes applied |
| 1a | App shell (sidebar nav, user badge, stub pages for all sections) | ✓ | (commit after 0.9c) | — (UI only) |
| 1b | `GET /api/projects` list + real data Projects page | ✓ | `6e3cba4` | — |
| 1c | Reports intake: migration 012 + /api/reports + /reports list/new/detail UI + thread + stub orchestrator (migration 012) | ✓ | (Fas 1c commit) | gpt-5.4 medium, 1 round → critical race fix |
| 1d | Project register form + /api/projects (POST) + /projects/:slug detail, host/deploy tokens minted with HMAC and returned once | ✓ | (Fas 1d commit) | — (in Fas 1 bundle review) |
| 1e | Stub orchestrator `orchestrate_task_for_report` (migration 012) + race fix `idx_agent_tasks_display_id_per_project` + advisory lock (migration 014) | ✓ | `4692ae9` | gpt-5.4 flagged race, fixed |
| 1f | Tasks page with real queue + Overview stats endpoint (`/api/overview/stats`) | ✓ | `9b60a14` | — |
| Fas 1 polish | addThread atomic FK→404, `new URL()` host_base_url parse, shared slug validator | ✓ | `efcb9a9` | gpt-5.4 round 2 → approved |
| 2 | Real classifier + Worker Manager service | ✓ | `7c8d1e4` | (see Fas 2-5 bundle) |
| 3 | Worker runtime: real git clone + branch + commit + push | ✓ | `d45726f` | (see Fas 2-5 bundle) |
| 4 | Reviewer service with real gpt-5.4 reasoning=medium on the diff | ✓ | `e930d29` | (see Fas 2-5 bundle) |
| 5 | Deployer (Ed25519 signed desired state) + Host Agent (dry-run apply) | ✓ | `ec46707` | (see Fas 2-5 bundle) |
| 2-5 bundle | gpt-5.4 reasoning=medium, 7 rounds, changes_requested x6 → approved round 7 | ✓ | `fee80d6` → `ce743ff` | approved |

Architecture doc: `docs/ARCHITECTURE.md` v10 (committed `45e9d7b` during
bootstrap of the phased build, reviewed through 10 rounds with
gpt-5.4 reasoning=high).

---

## What is running right now

### Services (systemd)

```
devloop-api.service             → NestJS API at 127.0.0.1:3110
devloop-web.service             → Next.js at 127.0.0.1:3120
devloop-worker-manager.service  → polls assigned tasks, runs git-worker
devloop-reviewer.service        → polls review tasks, calls gpt-5.4
devloop-deployer.service        → signs desired_state, runs verifier
devloop-host-agent.service      → polls desired_state_history (dry-run)
postgresql.service              → Postgres 16
```

All six DevLoop services run as the `devloop-api` OS user,
peer-mapped to the `devloop_api` Postgres role. They are all
enabled on boot. The worker manager, deployer, and reviewer
read file-backed secrets via systemd `LoadCredential`
(`github_token`, `openai_api_key`,
`deploy_signing_priv_devloop-2026-04`,
`deploy_signing_active_key_id`).

Start/stop/status commands are in
[RUNBOOK.md](RUNBOOK.md#service-management).

### HTTP surface

```
https://devloop.airpipe.ai/

AUTH
  /healthz                             (GET,  anonymous)
  /auth/login                          (POST, email+password)
  /auth/2fa/verify                     (POST, challenge+code)
  /auth/2fa/enroll                     (POST, guarded)
  /auth/2fa/confirm                    (POST, guarded)
  /auth/logout                         (POST, guarded)
  /auth/me                             (POST, guarded)

API (all guarded, admin+super_admin only)
  /api/overview/stats                  (GET)
  /api/projects                        (GET list, POST create)
  /api/projects/:slug                  (GET detail)
  /api/reports                         (GET list, POST create)
  /api/reports/:id                     (GET detail with thread)
  /api/reports/:id/threads             (POST add comment)
  /api/tasks                           (GET list)

WEB (Next.js Server Components unless noted)
  /login                               (client component)
  /                                    Overview dashboard
  /projects                            Projects list
  /projects/new                        Register project form
  /projects/:slug                      Project detail
  /reports                             Reports list
  /reports/new                         File bug report form
  /reports/:id                         Report detail + thread
  /tasks                               Tasks queue
  /deploys, /health, /audit, /settings Stub pages (phase-tagged)
```

### Database — applied migrations

```
001_init_enums_and_extensions
002_core_tables                     users, sessions, projects
003_audit_infrastructure            audit_chain_head, audit_events, append_audit_event()
004_task_tables                     agent_tasks, module_locks, deploy_mutex
005_state_machine_procs             acquire_module_lock, deploy_mutex_acquire,
                                    claim_assigned_task, refresh_task, fence_and_transition
006_jobs_and_quotas                 jobs, quota_usage_global, quota_usage_project,
                                    reserve_quota, reconcile_quota
007_deploy_path_tables              project_configs, signing_keys, desired_state_history,
                                    record_desired_state, record_apply_started,
                                    record_apply_heartbeat, record_deploy_applied,
                                    record_apply_timeout
008_health_and_compliance           health_status_enum, host_health, host_health_alerts,
                                    branch_protection_checks, record_host_health_probe,
                                    acknowledge_host_health_alert, record_branch_protection_check
009_session_token_hash              sessions.token_hash (SHA-256 lookup)
010_auth_runtime_grants             column-level UPDATE grants on users for login path
011_two_factor_grants               column-level UPDATE grants for 2FA fields
012_reports                         reports, report_threads, report_artifacts,
                                    agent_tasks.report_id FK, orchestrate_task_for_report
013_projects_insert_grant           GRANT INSERT on projects to devloop_api
014_orchestrator_race_fix           UNIQUE (project_id, display_id) on agent_tasks +
                                    advisory lock in orchestrate_task_for_report
015_orchestrator_classifier         orchestrate_task_for_report accepts module+risk_tier,
                                    acquires module_lock, transitions queued → assigned
                                    in the same txn when lock available
016_record_worker_result            SECURITY DEFINER helper for stamping worker diff
                                    metadata (branch_name, base/head_sha, files_changed)
017_record_review_result            SECURITY DEFINER helper for stamping review verdict
018_review_lease_fence              record_review_result now lease-fenced to prevent
                                    double-reviewer corruption race
019_worker_result_tighten           hex-only SHAs + branch charset + jsonb array check
                                    in record_worker_result
020_orchestrator_module_charset     DB-side module charset enforcement in
                                    orchestrate_task_for_report
```

Verify with: `sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
bash -c 'cd /opt/devloop/runtime/api && npm run migration:status'`

### Database — roles

| Role | Login | Peer-mapped OS user | What it does |
|---|---|---|---|
| `devloop_owner` | yes | `devloop-admin` | DDL, migrations. Never runtime. |
| `devloop_api`   | yes | `devloop-api`   | Public API runtime. Narrow column-level UPDATE grants. |

The other runtime roles (`devloop_orch`, `devloop_rev`, `devloop_dep`,
`devloop_wm`) are mentioned throughout the architecture but have
**not been created yet** — they are scoped to later phases when the
orchestrator / reviewer / deployer / worker-manager services are built.

### Secrets on disk

```
/etc/devloop/jwt_secret            48 bytes  mode 0440  root:devloop-secrets
/etc/devloop/data_encryption_key   32 bytes  mode 0440  root:devloop-secrets
```

`devloop-secrets` is a Unix group that contains both `devloop-api`
(the runtime service account) and `devloop-admin` (the migration/
bootstrap account). systemd LoadCredential is configured for the
api service so the process also sees them under `$CREDENTIALS_DIRECTORY`.

What is still missing (deferred to later phases): `openai_api_key`,
`anthropic_api_key`, `github_app_key`, `github_app_compliance_key`,
`deploy_signing_priv_<key_id>`, `deploy_signing_active_key_id`. See
ARCHITECTURE §4.3 for the canonical list.

### Nginx vhost

`/etc/nginx/sites-available/devloop.airpipe.ai` → symlinked into
`/etc/nginx/sites-enabled/`. The running nginx on this box is
FileMaker Server's bundled nginx (`/opt/FileMaker/FileMaker Server/
NginxServer/conf/fms_nginx.conf`), which includes
`/etc/nginx/sites-enabled/*`. Reload is `kill -HUP <master pid>`;
the system `nginx.service` unit is disabled because :80/:443 are
already bound by the FMS instance.

---

## Accounts right now

Two users live in the database:

| email | role | 2FA | purpose |
|---|---|---|---|
| `admin@devloop.airpipe.ai` | admin | enrolled | Jonas's real account. Log in here. |
| `fas09-runtime@example.com` | admin | not enrolled | Smoke-test backup (password: `runtime-path-pwd-1234`). Bypasses 2FA. Keep for debugging. |

And one registered project:

| slug | name | repo | branch |
|---|---|---|---|
| `dev-energicrm` | Dev Energicrm | zendoj/energicrm | experiment2 |

No reports or tasks at the moment. The stats on the Overview page
will show Projects=1, Open reports=0, Active tasks=0, Deploys(7d)=0.

### Creating additional admin accounts

Interactive (recommended — you scan the QR in a TOTP app):

```bash
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npx ts-node scripts/bootstrap-admin.ts'
```

Non-interactive (env vars, secret printed to stdout as QR + base32):

```bash
sudo -u devloop-admin env \
  DEVLOOP_DB_USER=devloop_owner \
  BOOTSTRAP_EMAIL=you@example.com \
  BOOTSTRAP_ROLE=admin \
  BOOTSTRAP_PASSWORD='your-strong-password' \
  bash -c 'cd /opt/devloop/runtime/api && npx ts-node scripts/bootstrap-admin-noninteractive.ts'
```

---

## What is REAL and what is STILL a stub

The end-to-end loop is now **live**. Everything ticked ✅ below
runs as a systemd service and is exercised by the daily smoke.

### ✅ What is real

| Piece | Lives in | What it does |
|---|---|---|
| Classifier | `orchestrator/classifier.service.ts` | Reads `project_configs.classifier_rules` (or `DEFAULT_RULES`), maps bug report text to `module` + `risk_tier`. Strict charset + enum validation. |
| Orchestrator | `migrations/020_orchestrator_module_charset.ts` | `orchestrate_task_for_report` row-locks the report, acquires module lock, allocates `T-N`, inserts task, triages report. Atomic. |
| Worker Manager | `worker-manager/worker-manager.ts` | Polls `assigned` tasks, claims them, runs git-worker, stamps diff metadata, transitions `in_progress → review` in a single DB transaction. Also runs `retryQueued()` for tasks stuck in `queued_for_lock`. |
| Git Worker | `worker-manager/git-worker.ts` | Real `git clone` via per-task `GIT_ASKPASS` (no token in argv), creates `devloop/task/T-N` branch, appends marker to `DEVLOOP_TASKS.md`, commits as "DevLoop Worker", pushes to GitHub. Worktree + askpass dir cleaned in `finally`. |
| Reviewer | `reviewer/reviewer.ts` | Polls `review` tasks with a session-scoped `pg_try_advisory_lock` claim (no duplicate OpenAI calls), fetches diff via GitHub Compare API (403 rate-limit vs auth distinction), sends to `gpt-5.4 reasoning=medium` with strict JSON output, validates (integer score, enum decision), enforces score-gate (`approved` requires score ≥ 60), stamps result lease-fenced, transitions to `approved`/`changes_requested`. |
| Deployer | `deployer/deployer.ts` + `deployer/jcs.ts` | Polls `approved` tasks. All 4 DB steps (`approved → deploying → merged → record_desired_state → verifying`) in a single `ds.transaction()`. Signs the canonical RFC 8785 JCS payload with Ed25519 (`crypto.sign(null, ...)`) from the active key on disk. Verifier loop transitions `verifying → verified` when `dsh.applied_sha = at.merged_commit_sha = dsh.deploy_sha`. |
| Host Agent | `host-agent/host-agent.ts` | **DRY-RUN mode.** Polls `desired_state_history`, calls `record_apply_started → heartbeat → record_deploy_applied('success')` lifecycle. Never actually touches a host file system or restarts a service. |
| Audit chain | `migrations/003_audit_infrastructure.ts` | Every transition appends a hash-chained row to `audit_events`. Append-only triggers block direct DML. |

### ❌ What is still a stub

1. **Worker's "fix"**: The git-worker appends a marker note to
   `DEVLOOP_TASKS.md` instead of running Claude in a bwrap
   sandbox to actually fix the bug. This is the **one** piece
   that stands between the current pipeline and a working
   auto-fix product. Everything around it is real.
2. **Host Agent applying for real**: Currently `DRY_RUN=true`
   hardcoded. A real host agent would:
   - verify the Ed25519 signature against the public key from
     `signing_keys`
   - `git fetch` + `git checkout` `deploy_sha`
   - run `post_deploy_command`
   - poll `health_check_url` for 60 s of continuous `up`
   - report success/failure
3. **GitHub PR merge**: The deployer uses `approved_head_sha`
   as the `merged_commit_sha`. No real PR merge on GitHub. The
   `devloop/task/T-N` branch sits on the project repo for a
   human to merge.
4. **Per-service PG roles**: All 4 daemons run as `devloop_api`.
   The architecture's `devloop_orch` / `devloop_rev` /
   `devloop_dep` / `devloop_wm` split is deferred.
5. **Rollback loop**: `rolling_back` / `rolled_back` states
   exist in the state machine but no code drives them.

---

## What is next

Ordered by what unlocks the most:

1. **Wire Claude into the worker.** The single piece that turns
   DevLoop into a real product. Replace `runWorkerStub()` in
   `git-worker.ts` with:
   - load `anthropic_api_key` via `SecretsService`
   - spawn the worker in a bwrap sandbox (per ARCHITECTURE §4.3 / §8)
     with read-only access to the worktree except for the branch
     checkout, no network except the Anthropic API
   - run the Claude loop with the report as context and a tool
     allowlist (file read/write, bash restricted to a safe set)
   - capture the resulting diff, commit, push
   - keep the same `WorkerRunResult` return shape so the
     Worker Manager, reviewer, and deployer paths do not
     change.

2. **Per-service PG roles.** Split `devloop_api` into
   `devloop_orch`, `devloop_rev`, `devloop_dep`, `devloop_wm`
   per ARCHITECTURE §19 D26. New OS users, `pg_ident.conf`
   entries, migration with the right grants per service.

3. **Host agent gets real apply.** Flip `DRY_RUN=false`, add
   signature verification against `signing_keys.public_key`,
   real `git fetch` + `git checkout` + `post_deploy_command`
   + health probe.

4. **Host agent runs on actual hosts.** The current host-agent
   is colocated on the central machine. A real deployment moves
   it to each managed host, where it only has SELECT on
   `desired_state_history` and EXECUTE on `record_apply_*` for
   its own project.

5. **GitHub PR merge.** Deployer currently treats
   `approved_head_sha` as the `merged_commit_sha`. A real
   deployer opens a PR via the GitHub API and merges it (or
   relies on branch protection + a human merge). Requires
   `github_app_key` provisioning.

6. **Rollback loop.** The state machine has `rolling_back` /
   `rolled_back` / `rollback_failed` but no code drives them.
   Needs: failed verification trigger, deployer takes a new
   action: 'rollback' desired state row pointing at the prior
   merged sha.

7. **Real Anthropic key + OpenAI key hygiene.** Rotate the
   exposed OpenAI key (still in
   `/opt/dev_energicrm/backend/.env`, exposed 2026-04-10). Add
   `/etc/devloop/anthropic_api_key` when worker runtime goes
   real.

8. **Let's Encrypt cert for devloop.airpipe.ai.** Self-signed
   today, works because Cloudflare terminates TLS. Swap to LE
   once we move away from CF "Full" mode.
