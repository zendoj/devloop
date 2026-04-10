# @devloop/api

DevLoop central Public API — NestJS 11 + Fastify 5.

**Status:** Fas 0.2 DB foundation. Migration infrastructure + first migration (enums + extensions). No tables yet — tables are added in Fas 0.3.

**Stack:** Node 22, NestJS 11.1.x, Fastify 5.8.x, TypeORM 0.3.x, PostgreSQL 16, TypeScript 5.5.x (strict mode, `noUncheckedIndexedAccess`).

See `../../docs/ARCHITECTURE.md` §3.1.2 for the full scope of this package.

## Build & run

```bash
npm ci
npm run typecheck
npm run build
npm start
```

Defaults to binding `127.0.0.1:3100`. Configurable via env:

```
DEVLOOP_API_HOST=127.0.0.1   # must be exactly "127.0.0.1" — no other values accepted in Fas 0.1
DEVLOOP_API_PORT=3100
```

**Security:** the API refuses to start with any `DEVLOOP_API_HOST` value other than `127.0.0.1`. `::1`, `localhost`, and public interfaces are all rejected at bootstrap with a FATAL log and non-zero exit. The Fas 0.1 deployment contract is "Nginx on the same host proxies to `127.0.0.1:3100`"; widening this requires a deliberate architecture change, not a config flag.

**Synchronize guard:** the process refuses to start if `TYPEORM_SYNCHRONIZE=true` or `DB_SYNCHRONIZE=true` is set and `NODE_ENV` is not exactly `development` (missing or typo'd `NODE_ENV` is treated as non-development, fail-closed).

## Database migrations (Fas 0.2+)

DevLoop uses Unix socket peer authentication (see `ARCHITECTURE.md` §4.1, §11, §19 D20). No passwords are used.

**Prerequisites (done once per server during Fas 0.2 setup):**

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin devloop-admin
sudo useradd --system --no-create-home --shell /usr/sbin/nologin devloop-api

sudo -u postgres psql <<SQL
CREATE ROLE devloop_owner LOGIN;  -- used ONLY via sudo -u devloop-admin, for migrations
CREATE ROLE devloop_api   LOGIN;  -- used ONLY via sudo -u devloop-api, for runtime
CREATE DATABASE devloop OWNER devloop_owner ENCODING 'UTF8';
SQL

# Add to /etc/postgresql/16/main/pg_ident.conf:
#   devloop_map   devloop-admin   devloop_owner
#   devloop_map   devloop-api     devloop_api
#
# Add to /etc/postgresql/16/main/pg_hba.conf (BEFORE any catch-all rule):
#   local   devloop   all   peer map=devloop_map

sudo systemctl reload postgresql
```

**Run migrations (as devloop-admin OS user → devloop_owner PG role):**

```bash
# Migration runner refuses to start unless DEVLOOP_DB_USER=devloop_owner.
sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner npm run migration:run
sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner npm run migration:status
sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner npm run migration:revert
```

## Next phases

- **0.3** — Core tables (users, sessions, projects) + audit chain genesis + SECURITY DEFINER stored procedures
- **0.4** — Auth (Argon2id, sessions, mandatory 2FA)
- **1.x** — Report intake + host adapter
- **2.x** — Orchestrator
- … etc per `ARCHITECTURE.md` §13.6
