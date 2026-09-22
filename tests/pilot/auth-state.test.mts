import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { encryptedAuth } from '../../src/pilot/auth-state.mjs';

test('Prisma auth roundtrip preserves binary Signal keys and refuses wrong encryption keys', async () => {
    const rows = new Map<string, unknown>();
    const key = randomBytes(32).toString('hex');
    const db = { authState: {
        findUnique: async ({ where }: { where: { sessionId_key: { key: string } } }) => rows.has(where.sessionId_key.key) ? { value: rows.get(where.sessionId_key.key) } : null,
        upsert: async ({ create }: { create: { key: string; value: unknown } }) => { rows.set(create.key, create.value); },
        deleteMany: async () => { throw new Error('not needed for this test'); },
    }, $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations) } as unknown as PrismaClient;
    const auth = await encryptedAuth(db, 'test', key);
    await auth.save();
    const binary = { private: randomBytes(32), public: randomBytes(32) };
    await auth.state.keys.set({ 'pre-key': { example: binary } });
    const restored = await encryptedAuth(db, 'test', key);
    assert.deepEqual((await restored.state.keys.get('pre-key', ['example'])).example, binary);
    assert.deepEqual(restored.state.creds.noiseKey, auth.state.creds.noiseKey);
    assert.ok(!JSON.stringify([...rows.values()]).includes('noiseKey'));
    await assert.rejects(encryptedAuth(db, 'test', randomBytes(32).toString('hex')));
});
test('database failure is propagated, never mistaken for missing credentials', async () => {
    const db = { authState: { findUnique: async () => { throw new Error('database unavailable'); } } } as unknown as PrismaClient;
    await assert.rejects(encryptedAuth(db, 'test', randomBytes(32).toString('hex')), /database unavailable/);
});
