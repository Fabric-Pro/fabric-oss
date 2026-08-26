/**
 * Encryption utilities for AI Gateway API keys
 *
 * Uses AES-256-GCM encryption to securely store API keys in the database.
 * The encryption key is derived from the BETTER_AUTH_SECRET environment variable.
 * Each encryption operation uses a unique random salt for enhanced security.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	scryptSync,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
export const AUTH_TAG_LENGTH = 16; // 128 bits
export const SALT_LENGTH = 32;

/**
 * Get encryption key from environment variable
 * Uses scrypt to derive a key from BETTER_AUTH_SECRET
 *
 * @param salt - The salt to use for key derivation (unique per encryption)
 */
function getEncryptionKey(salt: Buffer): Buffer {
	const secret = process.env.BETTER_AUTH_SECRET;

	if (!secret) {
		throw new Error(
			"BETTER_AUTH_SECRET environment variable is required for AI Gateway key encryption",
		);
	}

	return scryptSync(secret, salt, KEY_LENGTH);
}

// =============================================================================
// Versioned encryption keys — opt-in key rotation (SOC 2 CC6.1)
// -----------------------------------------------------------------------------
// `ENCRYPTION_KEYS` is a JSON object { "<version>": "<secret>" } and
// `ENCRYPTION_ACTIVE_KEY_VERSION` names the version NEW data is encrypted with.
// When EITHER is unset the module falls back to `BETTER_AUTH_SECRET` and emits
// the un-versioned legacy format — so with no configuration the behaviour is
// byte-for-byte identical to before, and every existing ciphertext still
// decrypts. Rotation: add a new version to `ENCRYPTION_KEYS`, point
// `ENCRYPTION_ACTIVE_KEY_VERSION` at it; older versions stay listed so their
// ciphertext keeps decrypting until the data is re-encrypted and they are
// retired. Versioned ciphertext is tagged `k<version>:` (see VERSION_TAG).
// =============================================================================

/** k<version> prefix on versioned ciphertext; version chars are URL-safe. */
const VERSION_TAG = /^k([0-9A-Za-z_-]+)$/;

let cachedKeysRaw: string | undefined;
let cachedKeys: Record<string, string> = {};
function parseEncryptionKeys(): Record<string, string> {
	const raw = process.env.ENCRYPTION_KEYS;
	if (!raw || raw.trim() === "") {
		return {};
	}
	if (raw === cachedKeysRaw) {
		return cachedKeys;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			"ENCRYPTION_KEYS must be valid JSON of { version: secret }",
		);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed)
	) {
		throw new Error(
			"ENCRYPTION_KEYS must be a JSON object of { version: secret }",
		);
	}
	const out: Record<string, string> = {};
	for (const [version, secret] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (!VERSION_TAG.test(`k${version}`)) {
			throw new Error(
				`ENCRYPTION_KEYS version "${version}" must match [0-9A-Za-z_-]+`,
			);
		}
		if (typeof secret !== "string" || secret.length === 0) {
			throw new Error(
				`ENCRYPTION_KEYS["${version}"] must be a non-empty string`,
			);
		}
		out[version] = secret;
	}
	cachedKeysRaw = raw;
	cachedKeys = out;
	return out;
}

/** Material NEW data is encrypted with: the active versioned key, else BETTER_AUTH_SECRET. */
function getActiveKeyMaterial(): { version: string | null; secret: string } {
	const activeVersion = process.env.ENCRYPTION_ACTIVE_KEY_VERSION?.trim();
	if (activeVersion) {
		const secret = parseEncryptionKeys()[activeVersion];
		if (!secret) {
			throw new Error(
				`ENCRYPTION_ACTIVE_KEY_VERSION="${activeVersion}" is not present in ENCRYPTION_KEYS`,
			);
		}
		return { version: activeVersion, secret };
	}
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error(
			"BETTER_AUTH_SECRET environment variable is required for encryption",
		);
	}
	return { version: null, secret };
}

/** The secret for a specific version (from ENCRYPTION_KEYS). Throws if retired/absent. */
function getKeyMaterialByVersion(version: string): string {
	const secret = parseEncryptionKeys()[version];
	if (!secret) {
		throw new Error(
			`Encryption key version "${version}" not found in ENCRYPTION_KEYS (key may have been retired)`,
		);
	}
	return secret;
}

/**
 * How much a given encryption-key misconfiguration costs the process holding it.
 *
 * `fatal` — an active key version is set whose material this process does not
 * hold. Every stored-credential read fails and nothing can be encrypted, for as
 * long as the process runs. There is no degraded mode: the process cannot do
 * the work, but it also cannot tell that it can't, so it keeps accepting it.
 *
 * `advisory` — the configuration works, but a rotation looks half-finished.
 */
export type EncryptionKeyMisconfigurationSeverity = "fatal" | "advisory";

export interface EncryptionKeyMisconfiguration {
	severity: EncryptionKeyMisconfigurationSeverity;
	message: string;
}

/**
 * Describe what is wrong with this process's encryption-key configuration, or
 * `null` when it is usable.
 *
 * Both key lookups are lazy — nothing reads `ENCRYPTION_KEYS` until the first
 * encrypt or decrypt — so a process configured with an active key version whose
 * material is missing starts perfectly happily and then fails every credential
 * read for as long as it runs. A staging environment ran that way while a
 * second, correctly-keyed deployment of the same worker polled the same task
 * queue, so the symptom was a raw `Encryption key version "2" not found in
 * ENCRYPTION_KEYS` reaching a product toast for *some* runs and not others —
 * which reads as flakiness rather than as a broken deployment.
 *
 * Severity is returned rather than decided here: a worker that cannot decrypt
 * credentials has no useful degraded mode, while the web app serves plenty of
 * surfaces that never touch one.
 *
 * Never includes key MATERIAL — only version identifiers, which are not secret.
 */
export function describeEncryptionKeyMisconfiguration(): EncryptionKeyMisconfiguration | null {
	const raw = process.env.ENCRYPTION_KEYS;
	const activeVersion = process.env.ENCRYPTION_ACTIVE_KEY_VERSION?.trim();

	let versions: string[];
	try {
		versions = Object.keys(parseEncryptionKeys());
	} catch (error) {
		// Unparsable material breaks every versioned ciphertext regardless of
		// whether a version is active, since decrypt reads the map to resolve a
		// `k<version>:` tag. Nothing about it is ever intentional.
		return {
			severity: "fatal",
			message: `ENCRYPTION_KEYS is set but unusable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (!activeVersion) {
		// No rotation configured. The module falls back to BETTER_AUTH_SECRET and
		// emits the legacy un-versioned format, which is a supported setup — but
		// listing keys nobody encrypts with usually means a half-finished rollout.
		if (versions.length > 0) {
			return {
				severity: "advisory",
				message: `ENCRYPTION_KEYS lists version(s) ${versions.join(", ")} but ENCRYPTION_ACTIVE_KEY_VERSION is unset, so new data is still encrypted with BETTER_AUTH_SECRET. Set the active version to finish the rotation, or unset ENCRYPTION_KEYS.`,
			};
		}
		return null;
	}

	if (!raw || raw.trim() === "" || versions.length === 0) {
		return {
			severity: "fatal",
			message: `ENCRYPTION_ACTIVE_KEY_VERSION="${activeVersion}" is set but ENCRYPTION_KEYS is empty. Every stored credential written under a versioned key will fail to decrypt, and no new one can be encrypted. Seed ENCRYPTION_KEYS with the key material for version "${activeVersion}".`,
		};
	}

	if (!versions.includes(activeVersion)) {
		return {
			severity: "fatal",
			message: `ENCRYPTION_ACTIVE_KEY_VERSION="${activeVersion}" is not present in ENCRYPTION_KEYS (which holds ${versions.join(", ")}). Nothing can be encrypted, and anything already written under version "${activeVersion}" cannot be read back.`,
		};
	}

	return null;
}

/**
 * Encrypt an AI Gateway API key
 *
 * @param apiKey - The plain text API key to encrypt
 * @returns Encrypted string. Un-versioned format `salt:iv:authTag:data` when no
 *   active key version is configured (default); versioned `k<version>:salt:iv:authTag:data`
 *   when `ENCRYPTION_ACTIVE_KEY_VERSION` is set.
 */
export function encryptApiKey(apiKey: string): string {
	if (!apiKey) {
		throw new Error("API key cannot be empty");
	}

	// Generate unique random salt and IV for each encryption
	const salt = randomBytes(SALT_LENGTH);
	const iv = randomBytes(IV_LENGTH);

	const { version, secret } = getActiveKeyMaterial();
	const key = scryptSync(secret, salt, KEY_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	});

	let encrypted = cipher.update(apiKey, "utf8", "hex");
	encrypted += cipher.final("hex");

	const authTag = cipher.getAuthTag();

	// Format: [k<version>:]salt:iv:authTag:encryptedData (all hex encoded).
	// The version prefix is only present when a rotation key is active; without
	// it the output is identical to the pre-rotation format.
	const body = `${salt.toString("hex")}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
	return version ? `k${version}:${body}` : body;
}

/**
 * Decrypt an AI Gateway API key
 *
 * Supports both new format (salt:iv:authTag:encryptedData) and legacy format
 * (iv:authTag:encryptedData) for backward compatibility.
 *
 * @param encryptedApiKey - The encrypted string from database
 * @returns Decrypted plain text API key
 */
export function decryptApiKey(encryptedApiKey: string): string {
	if (!encryptedApiKey) {
		throw new Error("Encrypted API key cannot be empty");
	}

	const parts = encryptedApiKey.split(":");

	// Versioned format: k<version>:salt:iv:authTag:encryptedData (5 parts).
	// The key is looked up by version from ENCRYPTION_KEYS.
	const versionMatch = parts.length === 5 ? VERSION_TAG.exec(parts[0]) : null;
	if (versionMatch) {
		const [, saltHex, ivHex, authTagHex, encryptedHex] = parts;

		const secret = getKeyMaterialByVersion(versionMatch[1]);
		const salt = Buffer.from(saltHex, "hex");
		const key = scryptSync(secret, salt, KEY_LENGTH);
		const iv = Buffer.from(ivHex, "hex");
		const authTag = Buffer.from(authTagHex, "hex");
		const encrypted = Buffer.from(encryptedHex, "hex");

		const decipher = createDecipheriv(ALGORITHM, key, iv, {
			authTagLength: AUTH_TAG_LENGTH,
		});
		decipher.setAuthTag(authTag);

		let decrypted = decipher.update(encrypted);
		decrypted = Buffer.concat([decrypted, decipher.final()]);

		return decrypted.toString("utf8");
	}

	// New format: salt:iv:authTag:encryptedData (4 parts)
	if (parts.length === 4) {
		const [saltHex, ivHex, authTagHex, encryptedHex] = parts;

		const salt = Buffer.from(saltHex, "hex");
		const key = getEncryptionKey(salt);
		const iv = Buffer.from(ivHex, "hex");
		const authTag = Buffer.from(authTagHex, "hex");
		const encrypted = Buffer.from(encryptedHex, "hex");

		const decipher = createDecipheriv(ALGORITHM, key, iv, {
			authTagLength: AUTH_TAG_LENGTH,
		});
		decipher.setAuthTag(authTag);

		let decrypted = decipher.update(encrypted);
		decrypted = Buffer.concat([decrypted, decipher.final()]);

		return decrypted.toString("utf8");
	}

	// Legacy format: iv:authTag:encryptedData (3 parts)
	// Uses hardcoded salt for backward compatibility
	if (parts.length === 3) {
		const [ivHex, authTagHex, encryptedHex] = parts;

		const legacySalt = Buffer.from("ai-gateway-encryption-salt-v1");
		const key = getEncryptionKey(legacySalt);
		const iv = Buffer.from(ivHex, "hex");
		const authTag = Buffer.from(authTagHex, "hex");
		const encrypted = Buffer.from(encryptedHex, "hex");

		const decipher = createDecipheriv(ALGORITHM, key, iv, {
			authTagLength: AUTH_TAG_LENGTH,
		});
		decipher.setAuthTag(authTag);

		let decrypted = decipher.update(encrypted);
		decrypted = Buffer.concat([decrypted, decipher.final()]);

		return decrypted.toString("utf8");
	}

	throw new Error("Invalid encrypted API key format");
}

/**
 * True when `value` has the exact shape produced by {@link encryptApiKey}
 * (`salt:iv:authTag:data`, all hex, with the fixed salt/iv/tag lengths). Used to
 * safely distinguish an already-encrypted value from a plaintext one when
 * migrating a column to encryption-at-rest in place, so existing plaintext rows
 * are never mis-decrypted.
 *
 * NOTE: only the 4-part (current) format is recognised. Columns being migrated
 * to encryption have never held the legacy 3-part AI-gateway format, and NOT
 * matching 3-part avoids mis-flagging a plaintext value that merely contains two
 * colons.
 */
export function isEncryptedApiKey(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) {
		return false;
	}
	const parts = value.split(":");
	const isHex = (s: string) => s.length > 0 && /^[0-9a-f]+$/i.test(s);

	// Versioned: k<version>:salt:iv:authTag:data (5 parts)
	if (parts.length === 5 && VERSION_TAG.test(parts[0])) {
		return (
			parts[1].length === SALT_LENGTH * 2 &&
			parts[2].length === IV_LENGTH * 2 &&
			parts[3].length === AUTH_TAG_LENGTH * 2 &&
			isHex(parts[1]) &&
			isHex(parts[2]) &&
			isHex(parts[3]) &&
			isHex(parts[4])
		);
	}

	// Un-versioned: salt:iv:authTag:data (4 parts)
	if (parts.length === 4) {
		return (
			parts[0].length === SALT_LENGTH * 2 &&
			parts[1].length === IV_LENGTH * 2 &&
			parts[2].length === AUTH_TAG_LENGTH * 2 &&
			isHex(parts[0]) &&
			isHex(parts[1]) &&
			isHex(parts[2]) &&
			isHex(parts[3])
		);
	}

	return false;
}

/**
 * Decrypt `value` if (and only if) it is an {@link encryptApiKey} ciphertext;
 * otherwise return it unchanged. This is the read-side primitive for migrating a
 * column to encryption-at-rest **in place with zero downtime**: existing
 * plaintext rows pass through untouched while newly-written encrypted rows are
 * transparently decrypted. Also fails open (returns the input) if a value looks
 * encrypted but cannot be decrypted, so a malformed value never throws on a hot
 * read path.
 */
export function decryptApiKeyMaybe<T extends string | null | undefined>(
	value: T,
): T {
	if (!isEncryptedApiKey(value)) {
		return value;
	}
	try {
		return decryptApiKey(value) as T;
	} catch {
		return value;
	}
}

/**
 * HMAC-SHA-256 of a token, keyed by BETTER_AUTH_SECRET. Useful as a lookup
 * column when the plaintext is encrypted-at-rest: an attacker with read access
 * to the DB cannot brute-force candidate tokens without also having the secret.
 */
export function hashApiKey(apiKey: string): string {
	if (!apiKey) {
		throw new Error("API key cannot be empty");
	}
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error(
			"BETTER_AUTH_SECRET environment variable is required for API key hashing",
		);
	}
	return createHmac("sha256", secret).update(apiKey).digest("hex");
}

/**
 * Mask an API key for display purposes
 * Shows first 7 and last 4 characters, masks the rest
 *
 * @param apiKey - The API key to mask
 * @returns Masked string like "sk-proj-***...***xyz"
 */
export function maskApiKey(apiKey: string): string {
	if (!apiKey || apiKey.length < 12) {
		return "***";
	}

	const start = apiKey.slice(0, 7);
	const end = apiKey.slice(-4);

	return `${start}***...***${end}`;
}

/**
 * Validate API key format (basic check)
 * Vercel AI Gateway keys typically start with specific prefixes
 *
 * @param apiKey - The API key to validate
 * @returns true if format looks valid
 */
export function isValidApiKeyFormat(apiKey: string): boolean {
	if (!apiKey || typeof apiKey !== "string") {
		return false;
	}

	// Basic validation: should be at least 20 characters
	if (apiKey.length < 20) {
		return false;
	}

	// Should not contain whitespace
	if (/\s/.test(apiKey)) {
		return false;
	}

	return true;
}
