# My Kustomers WhatsApp gateway — Phase 1

This fork is an isolated, replaceable, single-account **test** gateway. It does not integrate bookings, Supabase, Vercel, customers, campaigns or marketing.

## Source and runtime

- Upstream: https://github.com/mrifqidaffaaditya/WA-AKG
- Pinned upstream: `c7dd01a04339e4363b549beb3a41fe02cf131acb`, version 1.6.4, MIT.
- User-approved existing fork: https://github.com/davidfrank96/wa-akg. Its original main was identical to upstream. Work branch: `mykustomers/phase1-hardening`.
- Original lockfile: Next 16.1.1, Baileys 7.0.0-rc.9, Prisma 5.22.0, MySQL provider. README says Node 20+; Next requires at least 20.9. Local verification uses Node 22.23.2 / npm 10.9.8. This fork pins Baileys to **7.0.0-rc14**, protobufjs resolves to **7.6.6**, and ws is updated within its compatible range.
- Upstream documents native PM2 and optional Docker. This pilot uses neither Docker nor PM2: a systemd service runs the compiled native Node pilot entry point in `src/pilot`.

Architecture: reverse proxy → loopback HTTP gateway → one Baileys socket; Prisma → loopback MySQL. The upstream Next dashboard and Socket.IO server are **not started or exposed**. They are retained for maintainable upstream comparisons, and are not an approved production entry point.

## Audit and hardening

The upstream API-key generator used Math.random; it now uses 32 cryptographic random bytes. Full-history sync is disabled both in the upstream instance and pilot. The pilot also rejects history processing and does not bind contact, group, media, inbound-message, bot, autoreply, scheduler, webhook or broadcast handlers. There is no arbitrary session creation, registration, Swagger, dashboard or Socket.IO endpoint in the deployed runtime.

Upstream issues motivating isolation: unauthenticated Socket.IO room joins; public registration enabled by default; Swagger credentials configured as NEXT_PUBLIC variables; plain JSON WhatsApp auth state; automatic telemetry heartbeat to the author's server; broad runtime schedulers and bot initialization. These legacy paths still exist in source and **must not be exposed by running the upstream start script**. No telemetry heartbeat is initialized by the pilot.

The pilot accepts one server-only X-API-Key, compared in constant time, scoped to `mykustomers-test`. Unknown sessions are denied. Pairing defaults to disabled. Sending requires an explicitly supplied E.164 recipient in the server-only allowlist, rejects media/extra fields, limits text to 2,000 characters and bodies to 8 KiB, serializes sends and permits at most one every 10 seconds. No automatic send retry is performed: ambiguous results require operator inspection.

Dependency audit detected the upstream Baileys critical advisory [GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg); history disablement alone does not address app-state corruption. The fork upgrades to the patched rc14 release and newer protobuf/WebSocket dependencies. The old rc.9 newsletter/media patch, including payload debug logging, is preserved unchanged under `patches/upstream-reference` and is no longer applied. The broader dependency tree still has known advisories in legacy Next/Auth, Socket.IO, media, systeminformation and other libraries. Baileys' optional sharp media package is still present but the pilot neither downloads/parses media nor generates link previews. This is not a claim of a clean full dependency audit; legacy UI/media exposure remains prohibited pending separate remediation.

AuthState JSON is an AES-256-GCM envelope with a fresh 96-bit nonce per write. Session/key identity is authenticated as AAD. Binary Baileys data uses BufferJSON. Wrong keys, plaintext state and database failures fail closed; keys are not automatically re-created after a database read failure. Writes are serialized and Signal key batches use database transactions. Protect `WA_AUTH_STATE_KEY`: losing it makes stored sessions unrecoverable. No encryption migration from existing plaintext sessions is automatic.

## Secrets

Local operational values: `~/.config/mykustomers/wa-gateway.env`, mode 600, outside Git. Remote: `/opt/mykustomers-wa-gateway/.env`, mode 600, owned by `mykustomers`. SSH private key: `~/.ssh/mykustomers_wa_gateway`, never embedded in env files. No new DigitalOcean API token is needed.

Required pilot variables: `DATABASE_URL`, `AUTH_SECRET`, `WA_GATEWAY_API_KEY`, `WA_AUTH_STATE_KEY`. Bootstrap additionally requires `WA_GATEWAY_ADMIN_EMAIL` and `WA_GATEWAY_ADMIN_PASSWORD`. Provisioning uses `MYSQL_DATABASE_PASSWORD` and `MYSQL_ROOT_PASSWORD`. Secrets are 32 random bytes encoded as hex. Optional controls: `WA_PAIRING_ENABLED=false`, `WA_ALLOWED_RECIPIENTS=`. Never use NEXT_PUBLIC for any credential. No operational secrets are required to build. Do not shell-source the env file; read it with Node `--env-file` or a dotenv parser.

The admin account is reserved for future authenticated administration; the pilot REST API uses its distinct server-only key and exposes no browser login. Never place that key into browser JavaScript.

## Native deployment and resource target

Only one new `mykustomers-wa-gateway-01` Droplet is authorized: Ubuntu 24.04 x64, London `lon1`, normal bundled Basic plan priced **exactly $6/month**, as verified live before creation. Catalogue preflight on 2026-09-22 returned `s-1vcpu-1gb`: 1 shared vCPU, 1,024 MiB RAM, 25 GiB disk, 1 TB transfer. No backups, volumes, managed database, load balancer, snapshots or other paid additions. No automatic resize.

1. Inventory existing DigitalOcean resources read-only, confirm the live plan/image and upload only the dedicated public SSH key.
2. Bootstrap the new host with `deploy/pilot/provision.sh`. It verifies the exact hostname and OS; creates 2 GiB swap with swappiness 10, a `mykustomers` sudo user, UFW (22/80/443 only), fail2ban, unattended updates and bounded journald storage. Confirm a **second SSH session with working sudo** before changing PermitRootLogin to no. Keep the initial root session until the test succeeds.
3. Install a pinned Node 22 distribution from nodejs.org and verify its SHA-256 against the official manifest. Clone **our fork** into `/opt/mykustomers-wa-gateway`; check out the exact reviewed commit detached. Never deploy a moving branch or upstream directly.
4. Transfer the env file privately. Apply `deploy/pilot/mysql.cnf`; restart MySQL. Run `sudo python3 deploy/pilot/database.py` once, only against the empty pilot database. It creates a localhost-only application user and stores root credentials at `/root/.my.cnf` mode 600.
5. Run `npm ci --no-audit --no-fund`, `npx prisma db push` (never `--accept-data-loss`), `npx prisma generate`, `npm run pilot:build`, then `npm run pilot:bootstrap`. Prisma CLI requires the mode-600 `.env`. Revoke CREATE/ALTER/INDEX/REFERENCES after initialization; retain SELECT/INSERT/UPDATE/DELETE on `wa_akg.*` only.
6. Install `deploy/pilot/gateway.service`; enable/start `wa-gateway.service`. Node heap starts at 512 MiB, cgroup MemoryHigh=384 MiB and MemoryMax=640 MiB, restart delay 15 seconds and maximum 5 starts in 5 minutes. Adjust only using actual idle/connected measurements. MySQL buffer pool 128 MiB, max connections 20, temp tables 8 MiB, performance_schema off; Prisma connection pool 3.
7. Before authorized DNS and TLS, install `nginx-http.conf` as the default server: only `/healthz` is public, all other HTTP paths return 426. Do not expose credentials or pairing via plaintext HTTP. Once the authorized DNS-only A record resolves, issue a certificate with the distribution's Certbot Nginx plugin (`certbot certonly --nginx -d wa-gateway.mykustomers.com`, using the supplied administrative email). Install `nginx-tls.conf` as the default server, run `nginx -t`, reload Nginx and verify certificate trust. It redirects HTTP to HTTPS, limits requests/connections, disables access logging and serves only the loopback pilot. Enable the Certbot renewal timer and verify a dry run. Renewal must reload Nginx to pick up the renewed certificate.
8. Verify public ports, account cost/resources, a service restart, database restart, server reboot and safe health recovery. Record actual RAM/swap/CPU/disk and process metrics. Unpaired idle success does **not** prove connected suitability.

## Health and API

`GET /healthz` returns only service name, overall status, database availability and a generic WhatsApp state. It returns 503 on DB failure or stopped/logged-out/error WhatsApp state. `not_paired` is healthy for infrastructure preparation.

Authenticated routes (X-API-Key):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/sessions/mykustomers-test` | Generic state |
| POST | `/v1/sessions/mykustomers-test/pair` | Explicit pairing, disabled initially |
| GET | `/v1/sessions/mykustomers-test/qr` | Sensitive QR, only while pairing enabled |
| POST | `/v1/sessions/mykustomers-test/messages` | `{recipient, text}`; allowlisted text only |
| GET | `/v1/sessions/mykustomers-test/messages/<providerId>` | Best-effort delivery status |

Message API returns the provider ID. Delivery statuses are bounded to the most recent 1,000 IDs in memory and are lost on restart; they are best-effort provider events, not durable delivery guarantees. No message bodies, incoming chats, contacts or historical data are persisted. WhatsApp auth/app-state required by the protocol remains sensitive even with history disabled.

## Operations, updates and recovery

Use `ssh -i ~/.ssh/mykustomers_wa_gateway mykustomers@<pilot-ip>`.

| Operation | Remote command |
| --- | --- |
| Start | `sudo systemctl start wa-gateway` |
| Stop | `sudo systemctl stop wa-gateway` |
| Restart | `sudo systemctl restart wa-gateway` |
| Status | `systemctl status wa-gateway --no-pager` |
| Logs | `sudo journalctl -u wa-gateway -n 100 --no-pager` |
| Health | `curl --fail http://127.0.0.1:3000/healthz` |
| Reset restart limit after repair | `sudo systemctl reset-failed wa-gateway` |

Update: record current SHA, review a new immutable fork commit, run all pilot checks locally, fetch origin, stop service, checkout that SHA, install locked dependencies and compile pilot, then start and check health. Database changes require a separate reviewed migration/recovery plan. Do not run upstream `start.sh` or automatic upstream deployments.

Rollback: stop service, checkout the previously recorded deployed SHA, run npm ci and pilot:build, restart and verify health. Preserve `.env`, encryption key and database; do not reset, wipe auth state or regenerate secrets. Auth errors need diagnosis; do not treat them as permission to erase credentials. No paid backup has been enabled. Before real traffic, define and test an encrypted backup/recovery policy separately.

Upstream sync: fetch upstream read-only, inspect the exact SHA diff, apply reviewed updates to a separate branch and rerun checks. Never merge blindly or change the deployed commit automatically. Preserve the MIT license.

## Pairing stop point

**TEST ACCOUNT MODE ONLY**: one account, recipients controlled by the user, no real customers, broadcast or marketing; very low volume. Do not start pairing until the user participates. Enable `WA_PAIRING_ENABLED` only after explicit confirmation, obtain the QR through a secure administrative channel and never capture it in logs/docs. Do not choose a phone number or recipient. After the user confirms pairing, authorize their supplied recipient and test one text, process restart/reconnect, reboot/reconnect, and at most one additional authorized text. Retain no QR after connection. No personal history should be imported.

## Verification and known risks

Local npm ci, upstream npm run build and repository TypeScript check passed without local MySQL. The initial full upstream lint returned 296 errors and 177 warnings; pilot code has a clean focused ESLint check. No upstream npm test script exists; the manual message scripts can send WhatsApp traffic and are intentionally not run. Focused tests cover crypto generation, key validation, authenticated HTTP/session restrictions, recipient limits, disabled routes/pairing, safe health, mock DB failure/recovery, and encrypted binary auth roundtrip. Actual DB/server restart and connected tests must be recorded after deployment and pairing.

Baileys is an unofficial WhatsApp Web client and this dependency is a release candidate. Protocol changes, disconnections or account restrictions remain possible. Upstream Next/Auth and other dependencies still require review before exposing any legacy UI. No customer-readiness claim is made. The $6 host must be measured; do not automatically upgrade if insufficient.

Replaceability: keep the small gateway API independent of booking logic. A future adapter can replace Baileys with Meta's official WhatsApp API while preserving provider IDs, delivery-state semantics and consent controls. Phase 2 must separately introduce consent, a durable outbox/idempotency, verified callbacks, retention and customer integration; none is implemented here.
