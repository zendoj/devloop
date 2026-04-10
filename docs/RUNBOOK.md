# DevLoop — Runbook

Operational procedures for the DevLoop central runtime. For *what* is
built right now see [STATE.md](STATE.md); for the *why* of the design
see [ARCHITECTURE.md](ARCHITECTURE.md).

This runbook covers only the parts that exist today (Fas 0.9c and
earlier). Sections for orchestrator / reviewer / deployer /
worker-manager will be added when those services exist.

---

## Hosts and paths

| Path | Purpose |
|---|---|
| `/opt/devloop/` | Git repo root |
| `/opt/devloop/docs/` | ARCHITECTURE / STATE / RUNBOOK |
| `/opt/devloop/runtime/api/` | NestJS API |
| `/opt/devloop/runtime/web/` | Next.js web UI |
| `/opt/devloop/runtime/api/src/migrations/` | TypeORM migrations (000–011) |
| `/opt/devloop/runtime/api/scripts/` | Smoke tests + bootstrap CLI |
| `/etc/devloop/` | File-backed runtime secrets |
| `/etc/systemd/system/devloop-api.service` | API systemd unit |
| `/etc/systemd/system/devloop-web.service` | Web systemd unit |
| `/etc/nginx/sites-available/devloop.airpipe.ai` | Nginx vhost |

---

## Accounts

### OS users

| User | Login shell | Purpose |
|---|---|---|
| `devloop-admin` | no (sudo-only) | Owner of DDL / migrations. Peer-maps to `devloop_owner` Postgres role. Only used via `sudo -u devloop-admin`. |
| `devloop-api`   | no | Runtime service account for both API and web systemd units. Peer-maps to `devloop_api` Postgres role. |
| `jonas`         | yes | Interactive ops. Member of `sudo`. Can build Next.js (needs write on `.next/`). |

### Unix groups

| Group | Members | Purpose |
|---|---|---|
| `devloop-secrets` | `devloop-admin`, `devloop-api` | Owns `/etc/devloop/*` secret files (mode 0440). |

### Postgres roles

| Role | Peer OS user | Rights |
|---|---|---|
| `devloop_owner` | `devloop-admin` | OWNER of public schema. Used for migrations only. |
| `devloop_api`   | `devloop-api`   | Narrow column-level grants; see migrations 002, 006, 008, 010, 011. |

---

## Service management

### Start / stop / restart

```bash
sudo systemctl start  devloop-api
sudo systemctl start  devloop-web
sudo systemctl stop   devloop-web
sudo systemctl stop   devloop-api
sudo systemctl restart devloop-api devloop-web
```

Always start `devloop-api` before `devloop-web`; the web unit has a
`Wants=devloop-api` dependency so a clean boot handles this for you.

### Status

```bash
sudo systemctl status devloop-api devloop-web --no-pager
```

### Logs

```bash
sudo journalctl -u devloop-api -n 100 --no-pager
sudo journalctl -u devloop-web -n 100 --no-pager
sudo journalctl -u devloop-api -f               # follow
```

### Enable on boot

Already enabled:

```
/etc/systemd/system/multi-user.target.wants/devloop-api.service
```

The web unit is currently started manually; enable it with
`sudo systemctl enable devloop-web` if you want it up on boot.

---

## Database

### Connecting as owner (DDL, inspection)

```bash
sudo -u devloop-admin psql -U devloop_owner -d devloop
```

Peer auth is via the `devloop-admin` OS user; no password.

### Connecting as runtime role (read-only read sanity checks)

```bash
sudo -u devloop-api psql -U devloop_api -d devloop
```

### Migrations

All migration commands must run as `devloop-admin` with
`DEVLOOP_DB_USER=devloop_owner`. The migration runner script refuses
to run under any other DB user.

```bash
# Status
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npm run migration:status'

# Apply pending
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npm run migration:run'

# Revert the most recent
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npm run migration:revert'
```

Every migration is transactional (`transaction: 'each'`), so a partial
apply always rolls back. New migrations are written under
`runtime/api/src/migrations/NNN_name.ts` with class names ending in a
monotonic `1712700000NNN` suffix.

### Writing a new migration

1. Pick the next number: `012_*.ts`.
2. Implement `up(qr)` + `down(qr)` with the same class-name suffix.
3. Typecheck: `cd /opt/devloop/runtime/api && npm run typecheck`.
4. Dry-run apply + revert + re-apply locally under `devloop_owner`.
5. Verify with psql that the schema matches what you expected.
6. Send to gpt-5.4 reasoning=medium for review (see the review scripts
   under `/tmp/devloop-fas-*-review.py` for the pattern). Iterate until
   `approved`.
7. Commit with a message like the existing `feat(runtime/api): Fas 0.x …`
   commits — scope, review rounds, verification list.

---

## Secrets

### File layout

| File | Bytes | Owner:Group | Mode | Consumer |
|---|---|---|---|---|
| `/etc/devloop/jwt_secret` | ≥32 (48 today) | `root:devloop-secrets` | `0440` | HKDF base for 2FA challenge MAC (and future JWT signing). |
| `/etc/devloop/data_encryption_key` | exactly 32 | `root:devloop-secrets` | `0440` | AES-256-GCM master key for `users.two_factor_secret`. |

Both are loaded by the API at startup via
`SecretsService.getSecret()`, which checks sources in this order:

1. `$CREDENTIALS_DIRECTORY/<name>` — systemd `LoadCredential` at runtime
2. `/etc/devloop/<name>` — canonical disk location
3. `DEVLOOP_<NAME>` env var — developer fallback (supports `base64:` prefix)

The API logs a line like `loaded secret 'jwt_secret' (48 bytes)` on
startup so you can confirm both were picked up.

### Provisioning new secret files

```bash
sudo install -d -m 0755 /etc/devloop
# Generate random bytes
sudo head -c 32 /dev/urandom > /etc/devloop/<name>
sudo chown root:devloop-secrets /etc/devloop/<name>
sudo chmod 0440              /etc/devloop/<name>
# Then restart the API so it re-reads:
sudo systemctl restart devloop-api
```

### Rotation

No in-place rotation path yet for `data_encryption_key` — rotating it
means re-encrypting every `users.two_factor_secret` row with the new
key. Document the procedure before shipping Phase 1 user signups.

`jwt_secret` can be rotated by generating a new file, restarting the
API, and accepting that all pending 2FA challenge tokens are
invalidated (users just re-submit password on /auth/login).

### Key rotation for deploy signing

Not implemented yet — `signing_keys` table exists, but the two-phase
rotation protocol in ARCHITECTURE §5.4 will be wired up in the
deployer phase. Do not rotate `signing_keys` rows by hand until then.

---

## Smoke tests

All under `runtime/api/scripts/`. Run as `devloop-admin` with
`DEVLOOP_DB_USER=devloop_owner` unless otherwise noted.

### Fas 0.9a — password-only login flow

```bash
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npx ts-node scripts/fas-0.9-smoke.ts'
```

Exercises: bad password → 401, good password → session, tampered
token rejected, logout revokes, 5-attempt lockout, locked account
reject, DB stores SHA-256 hash not raw token.

### Fas 0.9a — runtime-role sanity

```bash
sudo -u devloop-api env DEVLOOP_DB_USER=devloop_api \
  /opt/devloop/runtime/api/node_modules/.bin/ts-node \
  /opt/devloop/runtime/api/scripts/fas-0.9-runtime-smoke.ts
```

Runs the same login/logout path under the real runtime role to catch
missing column-level UPDATE grants.

### Fas 0.9b — 2FA flow

```bash
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npx ts-node scripts/fas-0.9b-smoke.ts'
```

Exercises: AES-GCM round-trip + tamper, challenge sign/verify +
tamper, no-2FA login, enroll, confirm, post-enroll pending_2fa,
bad code 401, good code issues session, expired challenge 401.

### Bootstrapping a real admin account

```bash
sudo -u devloop-admin env DEVLOOP_DB_USER=devloop_owner \
  bash -c 'cd /opt/devloop/runtime/api && npx ts-node scripts/bootstrap-admin.ts'
```

Interactive: asks for email, role, password (silent TTY), confirm,
then renders an otpauth QR code to the terminal. Scan with any TOTP
app, enter the 6-digit code to confirm. On success the user is
enrolled and a `user_2fa_enabled` audit event is emitted. On any
failure the stored secret is cleared so there are no half-enrolled
rows.

---

## Nginx

The running nginx is **not** the system nginx. It is FileMaker
Server's bundled nginx:

```
/opt/FileMaker/FileMaker Server/NginxServer/conf/fms_nginx.conf
```

That config includes `/etc/nginx/sites-enabled/*`, so our vhost
drops in normally via:

```
/etc/nginx/sites-available/devloop.airpipe.ai
/etc/nginx/sites-enabled/devloop.airpipe.ai  (symlink)
```

### Reload

Because the FMS nginx is not managed by systemd as `nginx.service`
(in fact `systemctl start nginx` fails with "address in use"), you
reload it by sending SIGHUP to its master process:

```bash
# find the FMS nginx master pid
ps -o pid,cmd -C nginx | grep 'master'

# reload
sudo kill -HUP <master-pid>
```

Current master pid at writing: `2017` — but it changes on reboot,
always look it up.

### Test a config change before reloading

```bash
sudo nginx -t
```

Warnings about `protocol options redefined for 0.0.0.0:443` are
cosmetic — FMS and your vhost both set http2 options; first wins.

---

## Certificates

Current cert is self-signed:

```
/etc/ssl/certs/devloop-airpipe-ai-selfsigned.crt
/etc/ssl/private/devloop-airpipe-ai-selfsigned.key
```

This works only because Cloudflare is in front and terminates TLS
to browsers. The origin→CF hop uses "Full" (not "Full Strict"), so
CF accepts the self-signed cert. If Cloudflare is ever bypassed or
switched to "Full Strict", you will need a real cert.

### Getting a real Let's Encrypt cert (when ready)

Certbot is already used on this host for other subdomains; add
`devloop.airpipe.ai` to the existing flow. The ACME HTTP-01
challenge runs through the FMS nginx via the
`custom_fm_airpipe.conf` include. Concrete steps are deferred until
we disable CF proxy or switch to Full Strict.

---

## Public smoke test from a workstation

All five of these should succeed with the test account that ships
with Fas 0.9a:

```bash
# 1. Healthz (anonymous, no cookie)
curl -sS https://devloop.airpipe.ai/healthz

# 2. Login with a non-2FA test user → 200 + Set-Cookie
curl -sS -i -X POST https://devloop.airpipe.ai/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"fas09-runtime@example.com","password":"runtime-path-pwd-1234"}'

# 3. Login with wrong password → 401
curl -sS -X POST https://devloop.airpipe.ai/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"fas09-runtime@example.com","password":"wrongpassword"}' \
  -o /dev/null -w 'HTTP %{http_code}\n'

# 4. Unauthenticated /auth/me → 401
curl -sS -X POST https://devloop.airpipe.ai/auth/me \
  -o /dev/null -w 'HTTP %{http_code}\n'

# 5. Unauthenticated / → 307 redirect to /login
curl -sS https://devloop.airpipe.ai/ \
  -o /dev/null -w 'HTTP %{http_code}\n' -I
```

---

## Incident playbook — "the login page is down"

1. `curl -sS https://devloop.airpipe.ai/healthz` — 200? API is fine.
   Skip to step 3.
2. `sudo systemctl status devloop-api` → not active? `sudo journalctl -u devloop-api -n 80`. Common failures:
   - Missing secret file → `ls /etc/devloop/` + check group is `devloop-secrets`.
   - Postgres down → `sudo systemctl status postgresql`.
   - Migration not applied → run `migration:status` (see [Database](#database)).
3. `sudo systemctl status devloop-web` → not active? `sudo journalctl -u devloop-web -n 80`. Common failures:
   - `.next` permissions → rebuild as `jonas`, then `chown -R devloop-api:devloop-api .next`.
   - Port collision on 3120 → `sudo ss -tlnp | grep 3120`.
4. If both services are up but the public URL is down: check Nginx
   master pid is still alive and the vhost symlink still points at
   the right file.

---

## Git workflow

- Branch: `main` (we do not use feature branches in this solo build phase)
- Do NOT push without authorization — the environment that Claude
  runs in does not have GitHub credentials; push is Jonas-only.
- Commit messages follow the pattern established in commits
  `a7f6d8f` onward: `feat(runtime/api): Fas 0.x <short>` followed by
  a scope list, review summary, and verification list.

### Pushing from an authorized shell

```bash
cd /opt/devloop
git status
git log --oneline -10
git push origin main
```

---

## Known gotchas

- **Port 3100** is owned by an unrelated CMS process on this host.
  DevLoop API default port is `3110`; do not revert this.
- **MemoryDenyWriteExecute=yes** in systemd crashes Node.js v23 on
  the first JIT baseline compile. Keep it OFF in `devloop-api.service`
  and `devloop-web.service`.
- **TypeORM synchronize** must stay hardcoded `false`. The startup
  guard in `main.ts` refuses to boot outside `NODE_ENV=development`
  if anything tries to flip it.
- **`/etc/ssl/private/`** is mode `0710 root:ssl-cert`; your user
  cannot list it directly, only read files via root. Use `sudo ls`.
- **FileMaker nginx** is what is actually listening on :80/:443,
  not the system `nginx.service`. See [Nginx](#nginx).
- **pg_hba.conf** has a pre-existing `local all all trust` line from
  an earlier setup. This is a known backlog item and is NOT how
  devloop_owner / devloop_api are supposed to authenticate — the
  `map=devloop_map` peer rules take precedence because they come
  before the trust line.
