import { randomBytes } from "node:crypto";

/** Server-only, 256-bit API credentials. */
export function generateApiKey(): string {
    return `wag_${randomBytes(32).toString("hex")}`;
}
