
## Phase 2 durable send boundary

`POST /internal/v1/messages/text` accepts exactly `clientMessageId` (64 lowercase
hex characters), `recipient` (E.164), and `text` (1–2000 characters). It uses the
existing session-scoped `X-API-Key`, exact recipient allowlist, and serial ten-second
send limit. It does not grant dashboard, pairing, broadcast or other-session access.

Apply `deploy/pilot/idempotency.sql` using the local database administrator before
starting the updated gateway. Runtime retains only its existing DML grants. The
small `PilotSendRequest` table stores an HMAC payload digest, state, provider ID,
and timestamps; it never stores message text, recipient, or a capability URL.
Keep completed/uncertain request tombstones. API-key rotation makes old payload
digests conflict safely; it cannot silently resend an old request.

A reservation is committed before calling WhatsApp. Same-ID/same-payload replay
returns the durable result; different payloads return 409. Provider acceptance is
`ACCEPTED`, never a delivery receipt. A live PROCESSING replay or failed send
returns `UNKNOWN`; database failure after a possible send also remains uncertain.
Single-process startup changes interrupted PROCESSING records to UNKNOWN before
listening. There is no automatic replay, expiry, deletion, or recovery resend.
The app must bound HTTP timeouts and never blindly retry an uncertain response.
Status webhooks are not enabled: the old in-memory receipt endpoint is best-effort.

Local mock HTTP tests cover auth denial, payload conflicts, concurrent requests,
interrupted reservations and persistence failure after provider acceptance. They
send no external message. Phase 2 live deployment and app integration remain pending.
