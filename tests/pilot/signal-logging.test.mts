import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { inspect, format } from 'node:util';

interface Entry { indexInfo: { closed: number; baseKey: Buffer }; currentRatchet: { rootKey: Buffer }; }
interface Record { sessions: { [key: string]: Entry }; closeSession(entry: Entry): void; openSession(entry: Entry): void; removeOldSessions(): void; }
const { SessionRecord } = createRequire(import.meta.url)('libsignal') as {
    SessionRecord: { new(): Record; createEntry(): Entry };
};

test('Signal session lifecycle and inspection never log session key material', () => {
    const original = { info: console.info, warn: console.warn };
    const captured: unknown[][] = [];
    console.info = (...args: unknown[]) => { captured.push(args); };
    console.warn = (...args: unknown[]) => { captured.push(args); };
    try {
        const entry = SessionRecord.createEntry();
        entry.indexInfo = { closed: -1, baseKey: Buffer.from('synthetic-base-key') };
        entry.currentRatchet = { rootKey: Buffer.from('synthetic-secret-key') };
        const record = new SessionRecord();
        record.closeSession(entry);
        record.closeSession(entry);
        record.openSession(entry);
        record.openSession(entry);
        for (let i = 0; i < 42; i++) {
            const old = SessionRecord.createEntry();
            old.indexInfo = { closed: i, baseKey: Buffer.from(`synthetic-${i}`) };
            old.currentRatchet = entry.currentRatchet;
            record.sessions[String(i)] = old;
        }
        record.removeOldSessions();
        assert.equal(Object.keys(record.sessions).length, 40);
        assert.ok(captured.every(args => args.every(arg => typeof arg === 'string')));
        const output = captured.map(args => format(...args)).join('\n') + inspect(entry);
        for (const sensitive of ['synthetic-secret-key', 'rootKey', 'currentRatchet', entry.currentRatchet.rootKey.toString('hex')]) {
            assert.ok(!output.includes(sensitive));
        }
        assert.equal(inspect(entry), '<SessionEntry redacted>');
    } finally { console.info = original.info; console.warn = original.warn; }
});
