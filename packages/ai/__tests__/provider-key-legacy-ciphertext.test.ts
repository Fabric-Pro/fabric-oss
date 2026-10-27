/**
 * A provider key saved before salted encryption is stored as
 * `iv:authTag:data`. Lenient resolution must decrypt it like the strict path
 * does; it once passed the ciphertext through, and OpenAI was sent the
 * encrypted value as the bearer token.
 *
 * Uses the real `@repo/utils` decryptors: the shared suite mocks them, which
 * is how the gap between the two went unnoticed.
 */

import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { resolveProviderApiKey } from "../lib/databricks-oauth";

const SECRET = "test-secret-for-legacy-ciphertext";
const PLAINTEXT = "sk-test-legacy-key";

function legacyCiphertext(plaintext: string): string {
	const key = scryptSync(
		SECRET,
		Buffer.from("ai-gateway-encryption-salt-v1"),
		32,
	);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-gcm", key, iv, {
		authTagLength: 16,
	});
	const data = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return [iv, cipher.getAuthTag(), data]
		.map((part) => part.toString("hex"))
		.join(":");
}

function storedKey(apiKey: string) {
	return {
		provider: "OPENAI_DIRECT",
		apiKey,
		clientId: null,
		encryptedClientSecret: null,
	};
}

describe("resolveProviderApiKey with a legacy three-part ciphertext", () => {
	beforeEach(() => {
		vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
		vi.stubEnv("ENCRYPTION_KEYS", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("decrypts it under lenientDecrypt, as the strict path does", async () => {
		const stored = storedKey(legacyCiphertext(PLAINTEXT));

		await expect(resolveProviderApiKey(stored)).resolves.toBe(PLAINTEXT);
		await expect(
			resolveProviderApiKey(stored, { lenientDecrypt: true }),
		).resolves.toBe(PLAINTEXT);
	});

	it("still returns a legacy plaintext key unchanged under lenientDecrypt", async () => {
		await expect(
			resolveProviderApiKey(storedKey(PLAINTEXT), {
				lenientDecrypt: true,
			}),
		).resolves.toBe(PLAINTEXT);
	});
});
