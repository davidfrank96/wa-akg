import makeWASocket, { DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { encryptedAuth } from './auth-state.mjs';

export const PILOT_SOCKET_POLICY = {
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    fireInitQueries: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid: string) => jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
};

export class PilotWhatsApp {
    private socket: WASocket | null = null;
    private state = 'not_paired';
    private qrValue: string | null = null;
    private stopped = false;
    private connecting = false;
    private attempts = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private flush: () => Promise<void> = async () => {};
    private statuses = new Map<string, string>();
    constructor(private db: PrismaClient, private sessionId: string, private key: string, private pairingEnabled: boolean) {}
    status() { return this.state; }
    qr() { return this.qrValue; }
    delivery(id: string) { return this.statuses.get(id) ?? null; }
    private record(id: string, status: string) {
        this.statuses.set(id, status);
        if (this.statuses.size > 1000) this.statuses.delete(this.statuses.keys().next().value!);
    }
    async restore() {
        const auth = await encryptedAuth(this.db, this.sessionId, this.key);
        if (auth.state.creds.registered) await this.connect();
    }
    async pair() {
        if (!this.pairingEnabled) throw new Error('Pairing disabled');
        if (!this.socket && !this.timer) { this.stopped = false; this.attempts = 0; await this.connect(); }
    }
    private fatal() {
        this.state = 'error'; this.stopped = true; this.qrValue = null;
        // Never serialize provider errors: they may contain credentials or message data.
        console.error('Gateway auth persistence or connection failure; operator investigation required');
        process.exitCode = 1;
        setTimeout(() => process.exit(1), 1000).unref();
    }
    private async connect() {
        if (this.stopped || this.socket || this.connecting) return;
        this.connecting = true;
        try {
        const auth = await encryptedAuth(this.db, this.sessionId, this.key);
        if (!auth.state.creds.registered && !this.pairingEnabled) { this.state = 'not_paired'; return; }
        this.flush = auth.flush;
        this.state = 'connecting';
        const socket = makeWASocket({ ...PILOT_SOCKET_POLICY, auth: auth.state, logger: pino({ level: 'silent' }),
            connectTimeoutMs: 30000, defaultQueryTimeoutMs: 20000 });
        this.socket = socket;
        socket.ev.on('creds.update', () => { void auth.save().catch(() => this.fatal()); });
        socket.ev.on('connection.update', update => {
            if (this.socket !== socket || this.stopped) return;
            if (update.qr) { this.qrValue = update.qr; this.state = 'awaiting_pairing'; }
            if (update.connection === 'open') { this.qrValue = null; this.state = 'connected'; this.attempts = 0; }
            if (update.connection === 'close') {
                this.socket = null; this.qrValue = null;
                const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) { this.state = 'logged_out'; this.stopped = true; return; }
                if (++this.attempts > 5) { this.state = 'stopped'; this.stopped = true; return; }
                this.state = 'reconnecting';
                this.timer = setTimeout(() => { this.timer = undefined; void this.connect().catch(() => this.fatal()); }, Math.min(30000, 2000 * 2 ** (this.attempts - 1)));
            }
        });
        socket.ev.on('messages.update', updates => {
            for (const { key, update } of updates) {
                if (key.id && this.statuses.has(key.id) && update.status != null) {
                    const label = ['failed', 'pending', 'sent', 'delivered', 'read', 'read'][update.status];
                    if (label) this.record(key.id, label);
                }
            }
        });
        // Intentionally no history, contact, group, incoming-message, bot or media handlers.
        } finally { this.connecting = false; }
    }
    async send(recipient: string, text: string) {
        if (!this.socket || this.state !== 'connected') throw new Error('Not connected');
        const result = await this.socket.sendMessage(`${recipient.slice(1)}@s.whatsapp.net`, { text, linkPreview: null });
        if (!result?.key.id) throw new Error('Provider did not return an ID');
        this.record(result.key.id, 'sent'); return result.key.id;
    }
    async close() {
        this.stopped = true; if (this.timer) clearTimeout(this.timer);
        this.socket?.end(undefined); this.socket = null; this.qrValue = null;
        await this.flush();
    }
}
