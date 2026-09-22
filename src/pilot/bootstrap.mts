import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { requireSecret } from './security.mjs';

const email = process.env.WA_GATEWAY_ADMIN_EMAIL;
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('WA-AKG admin email required');
const password = requireSecret('WA_GATEWAY_ADMIN_PASSWORD');
const url = new URL(process.env.DATABASE_URL ?? '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/wa_akg' || url.username !== 'wa_gateway') throw new Error('Not the dedicated pilot database');
const db = new PrismaClient({ log: [] });
try {
    // Fail rather than promote, overwrite or reset an existing account.
    if (await db.user.count() || await db.session.count()) throw new Error('Bootstrap requires an empty pilot database');
    await db.$transaction(async tx => {
        const user = await tx.user.create({ data: { email, name: 'My Kustomers Test Admin', role: 'SUPERADMIN', password: await bcrypt.hash(password, 12) } });
        await tx.session.create({ data: { sessionId: 'mykustomers-test', userId: user.id, name: 'TEST ACCOUNT ONLY', status: 'STOPPED' } });
        await tx.systemConfig.create({ data: { id: 'default', appName: 'My Kustomers Test Gateway', enableRegistration: false, timezone: 'Europe/Dublin' } });
    });
    console.log('Pilot administrator and unpaired session created; no WhatsApp connection initiated');
} finally { await db.$disconnect(); }
