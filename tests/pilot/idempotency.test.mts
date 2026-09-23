import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { gatewayServer, type Gateway } from '../../src/pilot/http.mjs';
import { payloadDigest, type SendStore, type SendRecord } from '../../src/pilot/idempotency.mjs';

class MemoryStore implements SendStore {
    rows = new Map<string, SendRecord>();
    async find(id: string) { return this.rows.get(id) ?? null; }
    async reserve(id: string, digest: string) {
        if (this.rows.has(id)) return false;
        this.rows.set(id, { clientMessageId: id, payloadDigest: digest, status: 'PROCESSING', providerId: null });
        return true;
    }
    async finish(id: string, status: 'SENT' | 'UNKNOWN', providerId: string | null) {
        Object.assign(this.rows.get(id)!, { status, providerId });
    }
}
const recipient = '+15555550123'; // Reserved synthetic test data, never live.
const text = 'Synthetic gateway test';
async function fixture(store: SendStore, send: Gateway['send']) {
    const key = randomBytes(32).toString('hex');
    const gateway: Gateway = { status: () => 'connected', pair: async () => {}, qr: () => null, delivery: () => null, send };
    const server = gatewayServer({ apiKey: key, sessionId: 'test', recipients: [recipient], pairingEnabled: false }, gateway, async () => true, store);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
    return {
        key,
        post: (body: unknown, auth = key) => fetch(`http://127.0.0.1:${addr.port}/internal/v1/messages/text`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': auth }, body: JSON.stringify(body),
        }),
        close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
    };
}

test('durable accepted replay sends once, conflicts fail closed and authorization is checked first', async () => {
    const store = new MemoryStore(); let sends = 0;
    const f = await fixture(store, async () => { sends++; return 'provider-1'; });
    const body = { clientMessageId: 'a'.repeat(64), recipient, text };
    try {
        for (const auth of ['', 'wrong']) assert.equal((await f.post(body, auth)).status, 401);
        const first = await f.post(body); assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), { status: 'ACCEPTED', providerId: 'provider-1' });
        assert.equal((await f.post(body)).status, 200);
        assert.equal((await f.post({ ...body, text: 'different' })).status, 409);
        assert.equal((await f.post({ ...body, recipient: '+15555550124' })).status, 403);
        assert.equal((await f.post({ ...body, clientMessageId: 'bad' })).status, 400);
        assert.equal(sends, 1);
        const persisted = JSON.stringify([...store.rows.values()]);
        assert.ok(!persisted.includes(recipient) && !persisted.includes(text) && !persisted.includes(f.key));
    } finally { await f.close(); }
});

test('overlapping requests and a provider failure never duplicate an uncertain send', async () => {
    const store = new MemoryStore(); let sends = 0;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(store, async () => { sends++; started(); await blocked; throw new Error('private provider payload'); });
    const body = { clientMessageId: 'b'.repeat(64), recipient, text };
    try {
        const first = f.post(body); await ready;
        const concurrent = await f.post(body);
        assert.deepEqual(await concurrent.json(), { status: 'UNKNOWN', providerId: null });
        release(); assert.equal((await first).status, 202);
        assert.deepEqual(await (await f.post(body)).json(), { status: 'UNKNOWN', providerId: null });
        assert.equal(sends, 1);
    } finally { release(); await f.close(); }
});

test('an interrupted durable reservation after process replacement is not resubmitted', async () => {
    const store = new MemoryStore(); let sends = 0;
    const f = await fixture(store, async () => { sends++; return 'unexpected'; });
    const body = { clientMessageId: 'c'.repeat(64), recipient, text };
    await store.reserve(body.clientMessageId, payloadDigest(f.key, 'test', recipient, text));
    try {
        const response = await f.post(body);
        assert.deepEqual(await response.json(), { status: 'UNKNOWN', providerId: null });
        assert.equal(sends, 0);
    } finally { await f.close(); }
});

test('a database write failure after provider acceptance remains uncertain and cannot cause replay', async () => {
    const store = new MemoryStore(); let sends = 0;
    store.finish = async () => { throw new Error('database unavailable'); };
    const f = await fixture(store, async () => { sends++; return 'provider-1'; });
    const body = { clientMessageId: 'd'.repeat(64), recipient, text };
    try {
        assert.equal((await f.post(body)).status, 503);
        assert.deepEqual(await (await f.post(body)).json(), { status: 'UNKNOWN', providerId: null });
        assert.equal(sends, 1);
    } finally { await f.close(); }
});
