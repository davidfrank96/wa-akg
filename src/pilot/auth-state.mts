import { PrismaClient } from '@prisma/client';
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { seal, unseal } from './security.mjs';

/** No plaintext fallback and no swallowed DB errors. A wrong key must never trigger new pairing. */
export async function encryptedAuth(prisma: PrismaClient, sessionId: string, encryptionKey: string) {
    let pending: Promise<void> = Promise.resolve();
    const read = async (key: string) => {
        await pending;
        const row = await prisma.authState.findUnique({ where: { sessionId_key: { sessionId, key } } });
        return row ? JSON.parse(unseal(row.value, encryptionKey, `${sessionId}:${key}`), BufferJSON.reviver) : null;
    };
    const write = (entries: Array<[string, unknown]>) => {
        pending = pending.then(async () => {
            await prisma.$transaction(entries.map(([key, data]) => {
                if (data == null) return prisma.authState.deleteMany({ where: { sessionId, key } });
                const value = seal(JSON.stringify(data, BufferJSON.replacer), encryptionKey, `${sessionId}:${key}`);
                return prisma.authState.upsert({ where: { sessionId_key: { sessionId, key } }, create: { sessionId, key, value }, update: { value } });
            }));
        });
        return pending;
    };
    const creds: AuthenticationCreds = await read('creds-me') ?? initAuthCreds();
    const state: AuthenticationState = { creds, keys: {
        get: async (type, ids) => {
            const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
            for (const id of ids) {
                let value = await read(`${type}-${id}`);
                if (value && type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
                if (value) result[id] = value;
            }
            return result;
        },
        set: async (data) => {
            const entries: Array<[string, unknown]> = [];
            for (const [type, values] of Object.entries(data)) {
                for (const [id, value] of Object.entries(values ?? {})) entries.push([`${type}-${id}`, value]);
            }
            await write(entries);
        },
    } };
    return { state, save: () => write([['creds-me', creds]]), flush: () => pending };
}
