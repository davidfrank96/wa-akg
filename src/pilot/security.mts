import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export function requireSecret(name: string, value = process.env[name]): string {
    if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Invalid ${name}: expected 32 random bytes encoded as hex`);
    return value;
}

export function validKey(supplied: unknown, expected: string): boolean {
    return typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(expected)
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function seal(plaintext: string, key: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(requireSecret('WA_AUTH_STATE_KEY', key), 'hex'), iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
    return { v: 1, iv: iv.toString('hex'), data, tag: cipher.getAuthTag().toString('hex') };
}

export function unseal(value: unknown, key: string, context: string): string {
    if (!value || typeof value !== 'object') throw new Error('Invalid encrypted auth state');
    const v = value as Record<string, unknown>;
    if (v.v !== 1 || typeof v.iv !== 'string' || !/^[a-f0-9]{24}$/.test(v.iv)
        || typeof v.tag !== 'string' || !/^[a-f0-9]{32}$/.test(v.tag) || typeof v.data !== 'string') {
        throw new Error('Unencrypted or invalid auth state; explicit migration required');
    }
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(requireSecret('WA_AUTH_STATE_KEY', key), 'hex'), Buffer.from(v.iv, 'hex'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(v.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(v.data, 'base64')), decipher.final()]).toString('utf8');
}
