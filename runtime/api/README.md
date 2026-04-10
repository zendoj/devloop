# @devloop/api

DevLoop central Public API — NestJS 11 + Fastify 5.

**Status:** Fas 0.1 scaffolding. No database, no auth, no features. Just a process that starts and responds 200 on `/healthz`.

**Stack:** Node 22, NestJS 11.1.x, Fastify 5.8.x, TypeScript 5.5.x (strict mode, `noUncheckedIndexedAccess`).

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

## Next phases

- 0.2 — DB foundation (TypeORM config, migrations 001/002, Postgres role setup)
- 0.3 — Audit chain + SECURITY DEFINER stored procedures
- 0.4 — Auth (Argon2id, sessions, 2FA)
- 1.x — Report intake + host adapter
- 2.x — Orchestrator
- … etc per `ARCHITECTURE.md` §13.6
