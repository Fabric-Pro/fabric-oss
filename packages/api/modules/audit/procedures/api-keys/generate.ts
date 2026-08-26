/**
 * Shared raw-key generator for the audit-log API key procedures.
 *
 * Mirrors the format used by the existing org / user key creation
 * paths (`packages/api/modules/organizations/procedures/api-keys/create.ts`
 * and `packages/api/modules/v1/routes.ts`) so a key looks the same
 * regardless of where it was minted:
 *
 *   - personal: `fab_<8 hex>_<32-char base64url secret>`
 *   - org:      `org_<8 hex>_<32-char base64url secret>`
 *
 * SHA-256 hashing matches the existing flow byte-for-byte — both the MCP
 * and v1 surfaces compute `sha256(rawKey).hex()` for verification, and
 * the new audit-log REST verifier (`rest/verify-audit-key.ts`) uses the
 * same algorithm. Existing keys keep working.
 *
 * NEVER log the raw key. Callers MUST display it to the user once and
 * then drop the variable.
 */

import { createHash, randomBytes } from "node:crypto";

export interface GeneratedKey {
	rawKey: string;
	keyHash: string;
	keyPrefix: string;
}

/**
 * Generate a new API key for the given sigil (`fab` or `org`).
 *
 * - 4 bytes of random hex form the prefix segment (8 chars).
 * - 24 bytes of random base64url form the secret segment.
 *   24 bytes = 192 bits of entropy, base64url-encoded to 32 chars.
 * - SHA-256 hashes the full key for at-rest storage.
 */
export function generateApiKey(sigil: "fab" | "org"): GeneratedKey {
	const prefixBytes = randomBytes(4);
	const prefix = prefixBytes.toString("hex");
	const secretBytes = randomBytes(24);
	const secret = secretBytes.toString("base64url");
	const rawKey = `${sigil}_${prefix}_${secret}`;
	const keyPrefix = `${sigil}_${prefix}`;
	const keyHash = createHash("sha256").update(rawKey).digest("hex");
	return { rawKey, keyHash, keyPrefix };
}
