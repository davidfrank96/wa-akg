import { PrismaClient } from '@prisma/client';
import { SessionControl, MysqlControlStore } from './control.mjs';
import { requireSecret } from './security.mjs';
import { gatewayServer } from './http.mjs';
import { PilotWhatsApp } from './whatsapp.mjs';
import { MysqlSendStore } from './idempotency.mjs';

const apiKey = requireSecret('WA_GATEWAY_API_KEY');
if (process.env.WA_AKG_CONTROL_API_KEY === apiKey) throw new Error('Control and delivery credentials must differ');
const encryptionKey = requireSecret('WA_AUTH_STATE_KEY');
requireSecret('AUTH_SECRET');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
if (databaseUrl.protocol !== 'mysql:' || databaseUrl.hostname !== '127.0.0.1' || databaseUrl.pathname !== '/wa_akg'
    || databaseUrl.username !== 'wa_gateway') throw new Error('Pilot requires its dedicated local MySQL database and limited user');
const sessionId = 'mykustomers-test';
const db = new PrismaClient({ log: [] });
const wa = new PilotWhatsApp(db, sessionId, encryptionKey, process.env.WA_PAIRING_ENABLED === 'true');
await db.$connect();
const sends = new MysqlSendStore(db);
await sends.recoverInterrupted();
if (await db.session.count() !== 1 || !await db.session.findUnique({ where: { sessionId } })) throw new Error('Expected exactly one provisioned pilot session');
await wa.restore();
const server = gatewayServer({ apiKey, sessionId, recipients: (process.env.WA_ALLOWED_RECIPIENTS ?? '').split(',').filter(Boolean),
    pairingEnabled: process.env.WA_PAIRING_ENABLED === 'true', controlKey: process.env.WA_AKG_CONTROL_API_KEY ? requireSecret('WA_AKG_CONTROL_API_KEY') : undefined }, wa, async () => {
    try { await db.$queryRaw`SELECT 1`; return true; } catch { return false; }
}, sends, new SessionControl(wa, new MysqlControlStore(db, sessionId)));
server.listen(3000, '127.0.0.1', () => console.log('My Kustomers test gateway listening on loopback'));
let closing = false;
async function shutdown() {
    if (closing) return; closing = true;
    const timeout = setTimeout(() => process.exit(1), 15000); timeout.unref();
    server.close();
    try { await wa.close(); await db.$disconnect(); clearTimeout(timeout); }
    catch { process.exitCode = 1; }
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('unhandledRejection', () => { console.error('Gateway failed safely; details suppressed'); process.exit(1); });
