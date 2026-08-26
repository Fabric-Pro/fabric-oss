import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	decryptApiKey,
	decryptApiKeyMaybe,
	describeEncryptionKeyMisconfiguration,
	encryptApiKey,
	isEncryptedApiKey,
} from "../ai-gateway-encryption";

beforeAll(() => {
	// getEncryptionKey() derives the key from BETTER_AUTH_SECRET.
	process.env.BETTER_AUTH_SECRET =
		process.env.BETTER_AUTH_SECRET ??
		"test-secret-for-encryption-unit-tests";
});

// Representative plaintext secrets that MUST be treated as plaintext (never
// mis-detected as ciphertext when migrating a column to encryption in place).
const PLAINTEXT_SAMPLES = [
	"ghp_1234567890abcdefghijklmnopqrstuvwxyz",
	"secret_notionABCDEF1234567890",
	"xoxb-slack-000000000000-abcdefABCDEF",
	'{"accessToken":"abc","refreshToken":"def","apiKey":"ghi"}',
	"https://example.com:8443/path", // has colons, not hex-shaped
	"a:b:c:d", // 4 parts but not the right hex lengths
	"plain",
];

describe("encryptApiKey / decryptApiKey", () => {
	it("round-trips a value", () => {
		const secret = "my-super-secret-oauth-token-value";
		const enc = encryptApiKey(secret);
		expect(enc).not.toBe(secret);
		expect(decryptApiKey(enc)).toBe(secret);
	});

	it("produces a distinct ciphertext each time (random salt/iv)", () => {
		const a = encryptApiKey("same-value");
		const b = encryptApiKey("same-value");
		expect(a).not.toBe(b);
		expect(decryptApiKey(a)).toBe("same-value");
		expect(decryptApiKey(b)).toBe("same-value");
	});
});

describe("isEncryptedApiKey", () => {
	it("recognises encryptApiKey ciphertext", () => {
		expect(isEncryptedApiKey(encryptApiKey("token"))).toBe(true);
	});

	it("rejects plaintext secrets (incl. token/JSON/colon shapes)", () => {
		for (const s of PLAINTEXT_SAMPLES) {
			expect(isEncryptedApiKey(s)).toBe(false);
		}
	});

	it("rejects empty / non-string", () => {
		expect(isEncryptedApiKey("")).toBe(false);
		expect(isEncryptedApiKey(null)).toBe(false);
		expect(isEncryptedApiKey(undefined)).toBe(false);
		expect(isEncryptedApiKey(123 as unknown)).toBe(false);
	});
});

describe("decryptApiKeyMaybe (passthrough migration primitive)", () => {
	it("decrypts a ciphertext value", () => {
		const enc = encryptApiKey("real-token");
		expect(decryptApiKeyMaybe(enc)).toBe("real-token");
	});

	it("returns plaintext unchanged (existing un-migrated rows keep working)", () => {
		for (const s of PLAINTEXT_SAMPLES) {
			expect(decryptApiKeyMaybe(s)).toBe(s);
		}
	});

	it("passes through null / undefined", () => {
		expect(decryptApiKeyMaybe(null)).toBe(null);
		expect(decryptApiKeyMaybe(undefined)).toBe(undefined);
	});

	it("round-trips: decryptApiKeyMaybe(encryptApiKey(x)) === x", () => {
		const values = ["", "x", "a-long-token-".repeat(20)].filter(Boolean);
		for (const v of values) {
			expect(decryptApiKeyMaybe(encryptApiKey(v))).toBe(v);
		}
	});
});

describe("versioned key rotation (opt-in)", () => {
	const SAVED_KEYS = process.env.ENCRYPTION_KEYS;
	const SAVED_ACTIVE = process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
	const restore = (key: string, val: string | undefined) => {
		if (val === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = val;
		}
	};
	afterEach(() => {
		restore("ENCRYPTION_KEYS", SAVED_KEYS);
		restore("ENCRYPTION_ACTIVE_KEY_VERSION", SAVED_ACTIVE);
	});

	it("default (no versioned keys) is unchanged: un-versioned 4-part format", () => {
		delete process.env.ENCRYPTION_KEYS;
		delete process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
		const enc = encryptApiKey("tok");
		expect(enc.split(":")).toHaveLength(4);
		expect(enc.startsWith("k")).toBe(false);
		expect(decryptApiKey(enc)).toBe("tok");
	});

	it("BACKWARD-COMPAT: un-versioned ciphertext still decrypts once rotation is enabled", () => {
		delete process.env.ENCRYPTION_KEYS;
		delete process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
		const legacy = encryptApiKey("legacy-secret");
		// Turn rotation on; the old ciphertext (encrypted under BETTER_AUTH_SECRET)
		// must still decrypt — nothing needs re-encrypting.
		process.env.ENCRYPTION_KEYS = JSON.stringify({
			"2": "k2-secret-value-xyz",
		});
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		expect(decryptApiKey(legacy)).toBe("legacy-secret");
		expect(decryptApiKeyMaybe(legacy)).toBe("legacy-secret");
	});

	it("active version encrypts with a k<version>: tag and round-trips", () => {
		process.env.ENCRYPTION_KEYS = JSON.stringify({
			"2": "k2-secret-value-xyz",
		});
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		const enc = encryptApiKey("rotated");
		expect(enc.startsWith("k2:")).toBe(true);
		expect(enc.split(":")).toHaveLength(5);
		expect(isEncryptedApiKey(enc)).toBe(true);
		expect(decryptApiKey(enc)).toBe("rotated");
		expect(decryptApiKeyMaybe(enc)).toBe("rotated");
	});

	it("keys by version — a retired version becomes undecryptable (proves version-scoped keys)", () => {
		process.env.ENCRYPTION_KEYS = JSON.stringify({
			"2": "totally-different-key-2",
		});
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		const enc = encryptApiKey("val");
		process.env.ENCRYPTION_KEYS = JSON.stringify({ "9": "some-other-key" }); // retire v2
		expect(() => decryptApiKey(enc)).toThrow(
			/not found in ENCRYPTION_KEYS/,
		);
	});

	it("ROTATION: old-version ciphertext still decrypts after the active version is bumped", () => {
		process.env.ENCRYPTION_KEYS = JSON.stringify({ "2": "key-two" });
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		const v2 = encryptApiKey("data-under-v2");
		process.env.ENCRYPTION_KEYS = JSON.stringify({
			"2": "key-two",
			"3": "key-three",
		});
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "3";
		const v3 = encryptApiKey("data-under-v3");
		expect(v3.startsWith("k3:")).toBe(true);
		expect(decryptApiKey(v2)).toBe("data-under-v2");
		expect(decryptApiKey(v3)).toBe("data-under-v3");
	});

	it("throws if the active version is not present in ENCRYPTION_KEYS", () => {
		process.env.ENCRYPTION_KEYS = JSON.stringify({ "2": "key-two" });
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "5";
		expect(() => encryptApiKey("x")).toThrow(
			/not present in ENCRYPTION_KEYS/,
		);
	});

	it("isEncryptedApiKey still rejects plaintext + passes it through when rotation is on", () => {
		process.env.ENCRYPTION_KEYS = JSON.stringify({ "2": "key-two" });
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		for (const s of PLAINTEXT_SAMPLES) {
			expect(isEncryptedApiKey(s)).toBe(false);
			expect(decryptApiKeyMaybe(s)).toBe(s);
		}
	});
});

/**
 * The boot check.
 *
 * Both key lookups are lazy, so a process holding an active key version it has
 * no material for starts perfectly happily and then fails every credential read
 * for as long as it runs. A staging worker did exactly that while a second,
 * correctly-keyed deployment of the same worker polled the same task queue, so
 * a raw `Encryption key version "2" not found in ENCRYPTION_KEYS` reached a
 * product toast on some runs and not others.
 *
 * `severity` is what the worker keys its refuse-to-start on, so the split
 * between "this process cannot do the work" and "somebody's rotation is
 * half-finished" is load-bearing, not cosmetic.
 */
describe("describeEncryptionKeyMisconfiguration", () => {
	const SAVED_KEYS = process.env.ENCRYPTION_KEYS;
	const SAVED_ACTIVE = process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
	const restore = (key: string, val: string | undefined) => {
		if (val === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = val;
		}
	};
	afterEach(() => {
		restore("ENCRYPTION_KEYS", SAVED_KEYS);
		restore("ENCRYPTION_ACTIVE_KEY_VERSION", SAVED_ACTIVE);
	});

	it("passes the default, un-rotated setup", () => {
		// No configuration at all is a supported deployment: the module falls
		// back to BETTER_AUTH_SECRET. This must not be reported as a problem, or
		// every default deployment logs a scary line at boot.
		delete process.env.ENCRYPTION_KEYS;
		delete process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
		expect(describeEncryptionKeyMisconfiguration()).toBeNull();
	});

	it("passes a complete rotation setup", () => {
		process.env.ENCRYPTION_KEYS = JSON.stringify({ "2": "key-two" });
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		expect(describeEncryptionKeyMisconfiguration()).toBeNull();
	});

	it("is fatal when the active version's keys are the empty placeholder", () => {
		// `ensure_secret "encryption-keys" "{}"` seeds the vault with a literal
		// `{}` and nothing ever syncs real material into it. This is the state a
		// freshly-provisioned environment lands in.
		process.env.ENCRYPTION_KEYS = "{}";
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		const problem = describeEncryptionKeyMisconfiguration();
		expect(problem?.severity).toBe("fatal");
		expect(problem?.message).toMatch(/ENCRYPTION_KEYS is empty/);
		expect(problem?.message).toContain('"2"');
	});

	it("is fatal when ENCRYPTION_KEYS is unset but a version is active", () => {
		delete process.env.ENCRYPTION_KEYS;
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		const problem = describeEncryptionKeyMisconfiguration();
		expect(problem?.severity).toBe("fatal");
		expect(problem?.message).toMatch(/ENCRYPTION_KEYS is empty/);
	});

	it("is fatal for a retired active version — keys present, but not that one", () => {
		process.env.ENCRYPTION_KEYS = JSON.stringify({ "1": "key-one" });
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		const problem = describeEncryptionKeyMisconfiguration();
		expect(problem?.severity).toBe("fatal");
		expect(problem?.message).toMatch(/not present in ENCRYPTION_KEYS/);
		expect(problem?.message).toContain("1");
	});

	it("is fatal for unparsable ENCRYPTION_KEYS", () => {
		// Fatal even though no version is active: decrypt parses the map to
		// resolve any `k<version>:` tag, so every versioned ciphertext throws.
		process.env.ENCRYPTION_KEYS = "not-json";
		delete process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
		const problem = describeEncryptionKeyMisconfiguration();
		expect(problem?.severity).toBe("fatal");
		expect(problem?.message).toMatch(/unusable/);
	});

	it("is only advisory for a half-finished rotation — keys listed, no active version", () => {
		// Everything works: new data is written under the legacy key and every
		// listed version still decrypts. A worker must NOT refuse to start here,
		// which is exactly the state the deploy now leaves an unseeded
		// environment in.
		process.env.ENCRYPTION_KEYS = JSON.stringify({ "2": "key-two" });
		delete process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
		const problem = describeEncryptionKeyMisconfiguration();
		expect(problem?.severity).toBe("advisory");
		expect(problem?.message).toMatch(
			/ENCRYPTION_ACTIVE_KEY_VERSION is unset/,
		);
	});

	it("never returns key material, only version identifiers", () => {
		// The whole point is that this string goes to a boot log. A check that
		// leaks the secret it is guarding would be worse than no check.
		process.env.ENCRYPTION_KEYS = JSON.stringify({
			"1": "super-secret-key-material",
		});
		process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
		expect(describeEncryptionKeyMisconfiguration()?.message).not.toContain(
			"super-secret-key-material",
		);
	});
});
