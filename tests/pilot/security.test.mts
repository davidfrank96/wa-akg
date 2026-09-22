import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, unseal, validKey, requireSecret } from '../../src/pilot/security.mjs';
import { createRequire } from 'node:module';
const { generateApiKey } = createRequire(import.meta.url)('../../src/lib/api-key.ts') as { generateApiKey(): string };
import { PILOT_SOCKET_POLICY, hasPairedIdentity } from '../../src/pilot/whatsapp.mjs';

test('QR-paired identity restores even when Baileys registered flag remains false', () => {
    const qrPaired = { me: { id: 'test@s.whatsapp.net', name: 'Test' }, registered: false };
    assert.equal(hasPairedIdentity(qrPaired), true);
    assert.equal(hasPairedIdentity({}), false);
    assert.equal(hasPairedIdentity({ me: { id: '', name: 'Test' } }), false);
});

test('API credentials use cryptographic randomness, not Math.random', () => {
    const original = Math.random;
    Math.random = () => { throw new Error('insecure randomness'); };
    try {
        const keys = Array.from({ length: 100 }, generateApiKey);
        assert.equal(new Set(keys).size, 100);
        keys.forEach(key => assert.match(key, /^wag_[a-f0-9]{64}$/));
    } finally { Math.random = original; }
});
test('authentication rejects absent, repeated, wrong-length and incorrect credentials', () => {
    const key = randomBytes(32).toString('hex');
    for (const invalid of [undefined, [key, key], '', 'short', 'x'.repeat(64)]) assert.equal(validKey(invalid, key), false);
    assert.equal(validKey(key, key), true);
    assert.throws(() => requireSecret('test', 'admin123'));
});
test('AES-GCM roundtrip, randomized ciphertext and fail-closed integrity/context checks', () => {
    const key = randomBytes(32).toString('hex'), context = 'session:creds-me';
    const value = seal('private credentials', key, context);
    assert.equal(unseal(value, key, context), 'private credentials');
    assert.notEqual(seal('private credentials', key, context).data, value.data);
    assert.ok(!JSON.stringify(value).includes('private credentials'));
    assert.throws(() => unseal(value, randomBytes(32).toString('hex'), context));
    assert.throws(() => unseal(value, key, 'other-session:creds-me'));
    assert.throws(() => unseal({ ...value, tag: '00'.repeat(16) }, key, context));
    assert.throws(() => unseal({ creds: 'plaintext' }, key, context));
});
test('pilot rejects history, group and broadcast ingestion', () => {
    assert.equal(PILOT_SOCKET_POLICY.syncFullHistory, false);
    assert.equal(PILOT_SOCKET_POLICY.shouldSyncHistoryMessage(), false);
    assert.equal(PILOT_SOCKET_POLICY.shouldIgnoreJid('test@g.us'), true);
    assert.equal(PILOT_SOCKET_POLICY.shouldIgnoreJid('status@broadcast'), true);
    assert.equal(PILOT_SOCKET_POLICY.shouldIgnoreJid('test@s.whatsapp.net'), false);
});
