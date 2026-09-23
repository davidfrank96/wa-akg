import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { validKey } from './security.mjs';
import { payloadDigest, type SendStore, type SendRecord } from './idempotency.mjs';

export interface Gateway {
    status(): string;
    pair(): Promise<void>;
    qr(): string | null;
    send(recipient: string, text: string): Promise<string>;
    delivery(id: string): string | null;
    diagnostics?(): { connectionOpens: number; disconnects: number; reconnectAttempts: number };
}

export function gatewayServer(config: { apiKey: string; sessionId: string; recipients: string[]; pairingEnabled: boolean }, gateway: Gateway, databaseHealthy: () => Promise<boolean>, sendStore?: SendStore) {
    let requests = 0, windowStart = Date.now(), lastSend = 0, sending = false;
    const reply = (res: ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(body));
    };
    const json = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('body');
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 8192) throw new Error('body');
            chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('body');
        return body;
    };
    const server = createServer(async (req, res) => {
        try {
            const path = new URL(req.url ?? '/', 'http://localhost').pathname;
            if (path === '/healthz' && req.method === 'GET') {
                const database = await databaseHealthy();
                const whatsapp = gateway.status();
                const healthy = database && !['error', 'logged_out', 'stopped'].includes(whatsapp);
                return reply(res, healthy ? 200 : 503, { service: 'mykustomers-whatsapp-gateway', status: healthy ? 'ok' : 'degraded', database: database ? 'ok' : 'unavailable', whatsapp });
            }
            if (!validKey(req.headers['x-api-key'], config.apiKey)) return reply(res, 401, { error: 'Unauthorized' });
            if (Date.now() - windowStart > 60000) { requests = 0; windowStart = Date.now(); }
            if (++requests > 60) return reply(res, 429, { error: 'Rate limit exceeded' });
            const base = `/v1/sessions/${config.sessionId}`;
            if (path.startsWith('/v1/sessions/') && !path.startsWith(`${base}/`) && path !== base) return reply(res, 403, { error: 'Session not authorized' });
            if (path === base && req.method === 'GET') return reply(res, 200, { status: gateway.status(), diagnostics: {
                uptimeSeconds: process.uptime(), memoryBytes: process.memoryUsage(), connections: gateway.diagnostics?.() ?? null,
            } });
            if (path === `${base}/pair` && req.method === 'POST') {
                if (!config.pairingEnabled) return reply(res, 403, { error: 'Pairing requires explicit user participation and enablement' });
                await gateway.pair(); return reply(res, 202, { status: gateway.status() });
            }
            if (path === `${base}/qr` && req.method === 'GET') {
                if (!config.pairingEnabled) return reply(res, 403, { error: 'Pairing disabled' });
                return reply(res, 200, { qr: gateway.qr() });
            }
            if (path === '/internal/v1/messages/text' && req.method === 'POST') {
                if (!sendStore) return reply(res, 503, { code: 'idempotency_unavailable', status: 'UNKNOWN' });
                let body: Record<string, unknown>;
                try { body = await json(req); } catch { return reply(res, 400, { code: 'invalid_request' }); }
                if (Object.keys(body).some(k => !['clientMessageId', 'recipient', 'text'].includes(k))
                    || typeof body.clientMessageId !== 'string' || !/^[a-f0-9]{64}$/.test(body.clientMessageId)
                    || typeof body.recipient !== 'string' || !/^\+[1-9]\d{7,14}$/.test(body.recipient)
                    || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) {
                    return reply(res, 400, { code: 'invalid_request' });
                }
                if (!config.recipients.includes(body.recipient)) return reply(res, 403, { code: 'recipient_not_authorized' });
                const digest = payloadDigest(config.apiKey, config.sessionId, body.recipient, body.text);
                const replay = (record: SendRecord) => {
                    if (record.payloadDigest !== digest) return reply(res, 409, { code: 'idempotency_conflict', status: 'UNKNOWN' });
                    return reply(res, record.status === 'SENT' ? 200 : 202, {
                        status: record.status === 'SENT' ? 'ACCEPTED' : 'UNKNOWN', providerId: record.providerId,
                    });
                };
                const previous = await sendStore.find(body.clientMessageId);
                if (previous) return replay(previous);
                if (gateway.status() !== 'connected') return reply(res, 409, { code: 'session_disconnected', status: 'NOT_ACCEPTED' });
                if (sending || Date.now() - lastSend < 10000) return reply(res, 429, { code: 'send_rate_limited', status: 'NOT_ACCEPTED' });
                // Set the single-process gate before awaiting the durable reservation.
                sending = true;
                try {
                    if (!await sendStore.reserve(body.clientMessageId, digest)) {
                        const existing = await sendStore.find(body.clientMessageId);
                        if (existing) return replay(existing);
                        return reply(res, 503, { status: 'UNKNOWN' });
                    }
                    lastSend = Date.now();
                    let providerId: string;
                    try { providerId = await gateway.send(body.recipient, body.text); }
                    catch {
                        await sendStore.finish(body.clientMessageId, 'UNKNOWN', null);
                        return reply(res, 202, { status: 'UNKNOWN', providerId: null });
                    }
                    if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) {
                        await sendStore.finish(body.clientMessageId, 'UNKNOWN', null);
                        return reply(res, 202, { status: 'UNKNOWN', providerId: null });
                    }
                    await sendStore.finish(body.clientMessageId, 'SENT', providerId);
                    return reply(res, 200, { status: 'ACCEPTED', providerId });
                } finally { sending = false; }
            }
            if (path === `${base}/messages` && req.method === 'POST') {
                let body: Record<string, unknown>;
                try { body = await json(req); } catch { return reply(res, 400, { error: 'Invalid JSON body (maximum 8 KiB)' }); }
                if (Object.keys(body).some(k => !['recipient', 'text'].includes(k)) || typeof body.recipient !== 'string'
                    || !/^\+[1-9]\d{7,14}$/.test(body.recipient) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) {
                    return reply(res, 400, { error: 'Expected an E.164 recipient and 1–2000 character text' });
                }
                if (!config.recipients.includes(body.recipient)) return reply(res, 403, { error: 'Recipient not explicitly authorized for testing' });
                if (gateway.status() !== 'connected') return reply(res, 409, { error: 'WhatsApp not connected' });
                if (sending || Date.now() - lastSend < 10000) return reply(res, 429, { error: 'Wait at least 10 seconds between controlled sends' });
                sending = true; lastSend = Date.now();
                try { const id = await gateway.send(body.recipient, body.text); return reply(res, 200, { providerId: id, status: 'sent' }); }
                finally { sending = false; }
            }
            if (path.startsWith(`${base}/messages/`) && req.method === 'GET') {
                const status = gateway.delivery(path.slice(`${base}/messages/`.length));
                return reply(res, status ? 200 : 404, status ? { status } : { error: 'Unknown provider ID' });
            }
            return reply(res, 404, { error: 'Not found' });
        } catch { reply(res, 503, { error: 'Gateway unavailable; send outcome may be unknown, do not automatically retry' }); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 20000; server.maxHeadersCount = 30;
    return server;
}
