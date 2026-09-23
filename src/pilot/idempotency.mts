import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export type SendRecord = { clientMessageId: string; payloadDigest: string; status: 'PROCESSING' | 'SENT' | 'UNKNOWN'; providerId: string | null };
export interface SendStore {
    find(id: string): Promise<SendRecord | null>;
    reserve(id: string, digest: string): Promise<boolean>;
    finish(id: string, status: 'SENT' | 'UNKNOWN', providerId: string | null): Promise<void>;
}

// No recipient, body, capability or provider exception is retained here. HMAC
// prevents a database reader from guessing a phone/body from the digest.
export function payloadDigest(key: string, sessionId: string, recipient: string, text: string) {
    return createHmac('sha256', Buffer.from(key, 'hex'))
        .update(JSON.stringify([1, sessionId, recipient, text])).digest('hex');
}

export class MysqlSendStore implements SendStore {
    constructor(private db: PrismaClient) {}
    async find(id: string) {
        const rows = await this.db.$queryRaw<SendRecord[]>`SELECT clientMessageId, payloadDigest, status, providerId FROM PilotSendRequest WHERE clientMessageId = ${id}`;
        return rows[0] ?? null;
    }
    async reserve(id: string, digest: string) {
        // INSERT IGNORE is safe here: all values are validated, bounded strings.
        // The unique primary key serializes competing requests across connections.
        const inserted = await this.db.$executeRaw`INSERT IGNORE INTO PilotSendRequest (clientMessageId, payloadDigest, status) VALUES (${id}, ${digest}, 'PROCESSING')`;
        return inserted === 1;
    }
    async finish(id: string, status: 'SENT' | 'UNKNOWN', providerId: string | null) {
        const changed = await this.db.$executeRaw`UPDATE PilotSendRequest SET status = ${status}, providerId = ${providerId}, updatedAt = CURRENT_TIMESTAMP(3) WHERE clientMessageId = ${id} AND status = 'PROCESSING'`;
        if (changed !== 1) throw new Error('Send persistence unavailable');
    }
    async recoverInterrupted() {
        // Called only at startup of the single systemd gateway process, before
        // listening. Never reclaim a live send and never replay interrupted work.
        await this.db.$executeRaw`UPDATE PilotSendRequest SET status = 'UNKNOWN', updatedAt = CURRENT_TIMESTAMP(3) WHERE status = 'PROCESSING'`;
    }
}
