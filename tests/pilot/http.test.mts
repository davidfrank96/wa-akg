import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { gatewayServer, type Gateway } from '../../src/pilot/http.mjs';

test('real HTTP authentication, session boundary, disabled routes, controlled send and database recovery', async () => {
    const apiKey = randomBytes(32).toString('hex');
    let healthy = true, state = 'not_paired', sends = 0, pairCalls = 0;
    const gateway: Gateway = { status: () => state, qr: () => 'must-not-leak', pair: async () => { pairCalls++; },
        send: async () => { sends++; return 'mock-provider-id'; }, delivery: () => null };
    const server = gatewayServer({ apiKey, sessionId: 'test', recipients: ['+15555550123'], pairingEnabled: false }, gateway, async () => healthy);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const request = (path: string, method = 'GET', key: string | undefined = apiKey, body?: unknown) => fetch(url + path, {
        method, headers: { ...(key ? { 'X-API-Key': key } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
        for (const key of ['', 'incorrect']) assert.equal((await request('/v1/sessions/test/messages', 'POST', key, {})).status, 401);
        assert.equal((await request('/v1/sessions/test')).status, 200);
        assert.equal((await request('/v1/sessions/test', 'GET', '')).status, 401);
        const detailed = await (await request('/v1/sessions/test')).json();
        assert.ok(detailed.diagnostics.memoryBytes.heapUsed > 0);
        assert.equal((await request('/v1/sessions/another/messages', 'POST', apiKey, {})).status, 403);
        for (const path of ['/docs', '/swagger', '/api/auth/register', '/api/socket/io', '/api/groups/test', '/api/messages/test/broadcast', '/api/upload']) {
            assert.equal((await request(path, 'POST')).status, 404);
        }
        assert.equal((await request('/v1/sessions/test/pair', 'POST')).status, 403);
        assert.equal((await request('/v1/sessions/test/qr')).status, 403);
        assert.equal(pairCalls, 0);
        const firstHealth = await request('/healthz', 'GET', '');
        assert.equal(firstHealth.status, 200);
        const data = await firstHealth.text(); assert.ok(!data.includes(apiKey) && !data.includes('must-not-leak'));
        assert.equal(JSON.parse(data).whatsapp, 'not_paired');
        assert.equal(JSON.parse(data).diagnostics, undefined);
        healthy = false; assert.equal((await request('/healthz')).status, 503);
        healthy = true; assert.equal((await request('/healthz')).status, 200);
        state = 'connected';
        assert.equal((await request('/v1/sessions/test/messages', 'POST', apiKey, { recipient: '+15555550124', text: 'test' })).status, 403);
        assert.equal((await request('/v1/sessions/test/messages', 'POST', apiKey, { recipient: '+15555550123', text: 'test', media: 'url' })).status, 400);
        assert.equal((await request('/v1/sessions/test/messages', 'POST', apiKey, { recipient: '+15555550123', text: 'x'.repeat(10000) })).status, 400);
        const sent = await request('/v1/sessions/test/messages', 'POST', apiKey, { recipient: '+15555550123', text: 'mock-only' });
        assert.equal(sent.status, 200); assert.equal((await sent.json()).providerId, 'mock-provider-id');
        assert.equal((await request('/v1/sessions/test/messages', 'POST', apiKey, { recipient: '+15555550123', text: 'mock-only' })).status, 429);
        assert.equal(sends, 1);
        state = 'stopped'; assert.equal((await request('/healthz')).status, 503);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
