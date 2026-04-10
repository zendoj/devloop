# DevLoop — Build State

**Last updated:** 2026-04-11
**Current branch:** `main`
**Status:** Phase 0.9c complete. Central runtime auth is live and reachable at `https://devloop.airpipe.ai`.

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
| 0.9c | Bootstrap admin CLI + Next.js login frontend + Nginx vhost + systemd | ✓ | (`04d0162` port fix + latest HEAD) | gpt-5.4 medium, 1 round → fixes applied |

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
  ├── /healthz                  → API   (GET,  anonymous, returns {ok:true})
  ├── /auth/login                → API   (POST, email+password)
  ├── /auth/2fa/verify           → API   (POST, challenge+code)
  ├── /auth/2fa/enroll           → API   (POST, guarded)
  ├── /auth/2fa/confirm          → API   (POST, guarded)
  ├── /auth/logout               → API   (POST, guarded)
  ├── /auth/me                   → API   (POST, guarded)
  ├── /login                     → Next  (client component, login form)
  └── /                          → Next  (server component dashboard; redirects to /login if unauthenticated)
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

## How to run the test accounts

There is one password-only test user (for smoke tests and the
initial end-to-end curl flow):

```
email:    fas09-runtime@example.com
password: runtime-path-pwd-1234
2FA:      not enrolled
role:     admin
```

There is one 2FA-enrolled smoke test user that is deleted/recreated
by the smoke suite on every run (`fas09b-2fa@example.com`), so do
not rely on it between runs.

To create your own real admin account (interactive, with QR code):

```bash
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npx ts-node scripts/bootstrap-admin.ts'
```

The script will prompt for email, role, password (silent), and then
render a QR code to the terminal. Scan it into any TOTP app, confirm
the 6-digit code, and the account is enrolled.

---

## What is next

Roughly, in order of decreasing obviousness:

1. **Phase 1 — Reports intake and task creation.** First real
   business logic: the `reports`, `report_threads`, `report_artifacts`
   tables + POST /reports intake endpoint + orchestrator placeholder
   that promotes a report to an `agent_tasks` row. This is where
   ARCHITECTURE §6 starts to come alive.

2. **Frontend dashboard content.** The current `/` page is a
   placeholder. Fas 1+ will add: projects list, task board, report
   triage, deploy history, audit search.

3. **Remaining runtime DB roles.** `devloop_orch`, `devloop_rev`,
   `devloop_dep`, `devloop_wm` + their OS users + `pg_ident.conf`
   entries. Matches the RBAC matrix in ARCHITECTURE §19 D26.

4. **Worker manager skeleton.** The `claim_assigned_task` stored
   procedure already exists; there is no process yet that calls it.

5. **Reviewer worker skeleton.** Same shape: reviews tasks, calls
   `fence_and_transition` with review decisions. Needs OpenAI key
   provisioning at `/etc/devloop/openai_api_key`.

6. **Deployer worker + host deploy agent protocol.** The
   `record_desired_state` / `record_apply_*` procs already exist
   and are verified; the deployer process that actually signs +
   writes desired state rows is not built yet. Needs signing key
   provisioning under `/etc/devloop/deploy_signing_priv_<key_id>`
   + `deploy_signing_active_key_id`.

7. **Host health monitor + compliance scanner.** Tables + procs
   exist (migration 008). Scheduler processes that actually call
   `record_host_health_probe` and `record_branch_protection_check`
   are not built yet.

8. **Push to origin.** The local branch is several commits ahead of
   `origin/main`. The environment this work was done in has no
   GitHub credentials; someone with push access needs to run
   `cd /opt/devloop && git push origin main`.

9. **Proper Let's Encrypt cert for devloop.airpipe.ai.** Current
   cert is self-signed and only works because Cloudflare terminates
   TLS in front. If CF is ever bypassed or put in "strict" mode,
   this breaks. See RUNBOOK.md §"Certificates".

10. **OpenAI key rotation.** The key in
    `/opt/dev_energicrm/backend/.env` was exposed in chat on
    2026-04-10 ~21:15 UTC and must be rotated within 24 hours.
    See the tracking entry in
    `~/.claude/projects/-opt-dev-energicrm/memory/rotate_openai_key_pending.md`.
