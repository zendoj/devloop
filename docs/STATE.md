# DevLoop — Build State

**Last updated:** 2026-04-11 (late-night session wrap)
**Current branch:** `main`
**Status:** Phase 1f complete. The central runtime is live at `https://devloop.airpipe.ai` with: auth (Argon2id + TOTP 2FA), project registration, bug-report intake with a stub orchestrator that auto-creates queued tasks, Overview stats, and sidebar navigation across 8 sections. The actual Claude-based fix execution loop (orchestrator → worker → reviewer → deployer → verification) is **not built yet** — see "What is still a stub" below.

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

Architecture doc: `docs/ARCHITECTURE.md` v10 (committed `45e9d7b` during
bootstrap of the phased build, reviewed through 10 rounds with
gpt-5.4 reasoning=high).

---

## What is running right now

### Services (systemd)

```
devloop-api.service   → NestJS API at 127.0.0.1:3110
devloop-web.service   → Next.js at 127.0.0.1:3120
postgresql.service    → Postgres 16
```

`devloop-web` has `Wants=devloop-api`. Both are enabled on boot.
Start/stop/status commands are in [RUNBOOK.md](RUNBOOK.md#service-management).

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

## What is still a stub (important to read before demoing)

The end-to-end **"file a bug and have DevLoop fix it"** loop is
NOT complete. What exists:

✅ **The intake + triage half:** A report is filed via
`POST /api/reports`, the stub orchestrator `orchestrate_task_for_report`
inserts a paired `agent_tasks` row in `queued_for_lock`, the report
transitions `new → triaged`, audit events fire for both state
changes. The task is visible in `/tasks`.

❌ **The fix + deploy half:** Nothing advances a task out of
`queued_for_lock`. Specifically missing:

1. **Module classification.** The stub orchestrator hardcodes
   `module='unknown'` and `risk_tier='standard'`. A real classifier
   should read the project_config's classifier_rules, map the
   report text to a module path, and assign a risk tier. See
   ARCHITECTURE §6.
2. **Worker manager.** Nothing polls `agent_tasks WHERE status IN
   ('assigned', 'queued_for_lock')` and calls `claim_assigned_task`.
3. **Worker runtime.** No process spawns Claude in a bwrap
   sandbox, clones the repo, runs the fix, and commits a branch.
   Needs Anthropic API key provisioning and the sandbox infra
   that ARCHITECTURE §4.3 / §8 describes.
4. **Reviewer.** No process calls OpenAI to review the diff and
   invoke `fence_and_transition` with a review decision.
5. **Deployer.** No process signs a desired state row via
   `record_desired_state` and pushes the branch + PR to GitHub.
6. **Host deploy agent.** No agent on any real host is polling
   `desired_state_history` and calling `record_apply_*`.
7. **Verification scanner.** Nothing calls
   `record_host_health_probe` / `record_apply_timeout`.

All of this is **weeks of work**. The DB schema, stored
procedures, and RBAC matrix for every piece above already exist
and are verified — what's missing is the actual process code that
calls into them. See ARCHITECTURE §3.1.2 for the full service
inventory.

---

## What is next

Ordered by what it unlocks:

1. **Run the full loop manually.** A DBA can manually walk a task
   through the state machine via psql + the existing procedures to
   demo the end state before any worker exists. Useful as a
   integration-test anchor.

2. **Classifier.** Replace the stubbed `module='unknown'` with a
   real classifier call (can be a simple regex map in Fas 2, then
   GPT-based later).

3. **Worker manager skeleton + worker runtime.** The biggest piece.
   Needs the sandbox infra + Anthropic API key wiring.

4. **Reviewer worker.** Simpler — it calls OpenAI on the diff.
   Needs `/etc/devloop/openai_api_key` provisioned.

5. **Deployer.** Writes desired state + opens PR. Needs GitHub App
   credentials at `/etc/devloop/github_app_key` and the deploy
   signing private key.

6. **Host deploy agent.** Runs on each managed host, polls central,
   applies, reports status.

7. **Remaining DB roles.** `devloop_orch`, `devloop_rev`,
   `devloop_dep`, `devloop_wm` get their own PG roles + OS users +
   pg_ident mappings, matching ARCHITECTURE §19 D26. Done when
   each of those workers ships.

8. **Push to origin.** The local branch is many commits ahead of
   `origin/main`. The environment this work runs in has no GitHub
   credentials — someone with push access needs to run
   `cd /opt/devloop && git push origin main`.

9. **Let's Encrypt cert for devloop.airpipe.ai.** Self-signed
   today, works because Cloudflare terminates TLS. Swap to LE once
   we move away from CF "Full" mode. See RUNBOOK.md §Certificates.

10. **OpenAI key rotation.** The key in
    `/opt/dev_energicrm/backend/.env` was exposed in chat on
    2026-04-10 ~21:15 UTC and must be rotated within 24 hours.
    Entry: `~/.claude/projects/-opt-dev-energicrm/memory/rotate_openai_key_pending.md`.
