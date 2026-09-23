import type { PrismaClient } from '@prisma/client';
import { freemem, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';

export const CONTROL_ACTIONS = ['reconnect', 'pair', 'replace', 'unlink', 'resume'] as const;
export type ControlAction = typeof CONTROL_ACTIONS[number];
export interface ControlSession {
    status(): string;
    qr(): string | null;
    identity(): { last4: string } | null;
    connectedSince(): string | null;
    diagnostics(): { connectionOpens: number; disconnects: number; reconnectAttempts: number };
    reconnect(): Promise<void>;
    beginPairing(): Promise<void>;
    unlink(): Promise<void>;
}
export interface ControlStore {
    paused(): Promise<boolean>;
    pause(value: boolean): Promise<void>;
    reserve(id: string): Promise<boolean>;
}
// Reuse the canonical session config; no phone/QR/auth material is stored here.
export class MysqlControlStore implements ControlStore {
    constructor(private db: PrismaClient, private sessionId: string) {}
    async paused() {
        const row = await this.db.session.findUniqueOrThrow({ where: { sessionId: this.sessionId }, select: { config: true } });
        const config = row.config as Record<string, unknown> | null;
        return config?.controlPaused === true || config?.controlPaused === 1;
    }
    async pause(value: boolean) {
        await this.db.$executeRaw`UPDATE Session SET config = JSON_SET(COALESCE(config, JSON_OBJECT()), '$.controlPaused', ${value ? 1 : 0}) WHERE sessionId = ${this.sessionId}`;
    }
    async reserve(id: string) {
        // Dedicated namespace in the existing idempotency ledger, never a send ID.
        const changed = await this.db.$executeRaw`INSERT IGNORE INTO PilotSendRequest (clientMessageId, payloadDigest, status) VALUES (${`control:${id}`}, 'control', 'UNKNOWN')`;
        return changed === 1;
    }
}
export function normalizedState(state: string) {
    const states: Record<string, string> = { connected: 'CONNECTED', connecting: 'CONNECTING', reconnecting: 'CONNECTING', disconnected: 'DISCONNECTED', stopped: 'STOPPED', logged_out: 'LOGGED_OUT', not_paired: 'LOGGED_OUT', awaiting_pairing: 'PAIRING', error: 'ERROR' };
    return states[state] ?? 'UNKNOWN';
}
export function availableMemory() {
    try {
        const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
        if (match) return Number(match[1]) * 1024;
    } catch { /* Non-Linux test hosts use OS free memory. */ }
    return freemem();
}
export class SessionControl {
    private expiresAt = 0;
    private pairingTimer?: ReturnType<typeof setTimeout>;
    constructor(readonly session: ControlSession, readonly store: ControlStore) {}
    async status(database: boolean, restricted: boolean) {
        const since = this.session.connectedSince();
        const account = this.session.identity();
        // Defensive reconstruction: never serialize the provider identity object.
        return { status: normalizedState(this.session.status()), gateway: 'healthy', database: database ? 'healthy' : 'unavailable',
            linked: account !== null, account: account && /^\d{4}$/.test(account.last4) ? { last4: account.last4 } : null,
            connectedSince: since, uptimeSeconds: since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000)) : 0,
            processUptimeSeconds: Math.floor(process.uptime()), reconnectAttempts: this.session.diagnostics().reconnectAttempts,
            paused: await this.store.paused(), restricted, memory: { availableBytes: availableMemory(), totalBytes: totalmem(), rssBytes: process.memoryUsage().rss } };
    }
    async act(action: ControlAction, operationId: string, databaseHealthy: () => Promise<boolean>) {
        if (action === 'resume' && (this.session.status() !== 'connected' || !await databaseHealthy())) throw new Error('not_connected');
        if (action === 'pair' && this.session.identity()) throw new Error('already_linked');
        if (!await this.store.reserve(operationId)) throw new Error('already_requested');
        // Persistence precedes every session mutation. Failure/abandonment stays paused.
        await this.store.pause(true);
        if (action === 'resume') { await this.store.pause(false); return; }
        if (action === 'reconnect') { await this.session.reconnect(); return; }
        if (action === 'unlink' || action === 'replace') await this.session.unlink();
        if (action === 'pair' || action === 'replace') {
            await this.session.beginPairing();
            this.expiresAt = Date.now() + 120000;
            if (this.pairingTimer) clearTimeout(this.pairingTimer);
            this.pairingTimer = setTimeout(() => {
                this.expiresAt = 0;
                // Closing unpaired sockets is handled by the session's pairing lease.
            }, 120000); this.pairingTimer.unref();
        } else this.expiresAt = 0;
    }
    async qr() {
        if (this.session.status() === 'connected' || Date.now() >= this.expiresAt) return null;
        const value = this.session.qr();
        if (!value || value.length > 4096) return null;
        return { image: await QRCode.toDataURL(value, { width: 280, margin: 2 }), expiresInSeconds: Math.min(20, Math.ceil((this.expiresAt - Date.now()) / 1000)) };
    }
}
