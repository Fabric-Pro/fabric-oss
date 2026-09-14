/**
 * `verifyUserApiKey` — the scope check, and the wildcard that satisfies it
 * (Fizzy #2380, QA round 2).
 *
 * Two things are worth pinning here rather than at the call sites.
 *
 * The check is GUARDED BY ITS OWN ARGUMENT: `if (requiredScope && ...)`. Call
 * the function with one argument and no scope is ever checked, which is how
 * the tool-router mint and every Fabric Code route came to accept any valid
 * key whatever it was issued for. That is easy to reintroduce by deleting an
 * argument at a call site, and reads like a tightening rather than a hole.
 *
 * And `"*"` satisfies anything, matching `hasScope` for organization keys.
 * Without it the two verifiers would disagree about the same stored string:
 * personal keys minted before the Fabric Code key was narrowed carry `["*"]`
 * and nothing else, so every newly-scoped route would refuse them.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserApiKeyByPrefix, updateUserApiKeyUsage } = vi.hoisted(() => ({
	getUserApiKeyByPrefix: vi.fn(),
	updateUserApiKeyUsage: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getUserApiKeyByPrefix,
	updateUserApiKeyUsage,
}));

import { verifyUserApiKey } from "../verify";

// Dull on purpose: a realistic-looking secret trips the publication gate,
// which runs gitleaks under default rules and ignores this repo's allowlist.
const RAW_KEY = "fab_testpfx_notarealsecret";

function storedKeyWith(scopes: string[]) {
	return {
		id: "key-1",
		userId: "user-1",
		scopes,
		isActive: true,
		expiresAt: null,
		keyHash: createHash("sha256").update(RAW_KEY).digest("hex"),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	updateUserApiKeyUsage.mockResolvedValue(undefined);
});

describe("when a scope is required", () => {
	it("accepts a key that holds it", async () => {
		getUserApiKeyByPrefix.mockResolvedValue(storedKeyWith(["mcp:read"]));

		const result = await verifyUserApiKey(RAW_KEY, "mcp:read");

		expect(result).toMatchObject({ valid: true, userId: "user-1" });
	});

	it("refuses a key that does not", async () => {
		getUserApiKeyByPrefix.mockResolvedValue(
			storedKeyWith(["projects:read"]),
		);

		const result = await verifyUserApiKey(RAW_KEY, "mcp:read");

		expect(result.valid).toBe(false);
		expect(result.error).toContain("mcp:read");
	});

	it("accepts a wildcard key, as the organization verifier does", async () => {
		getUserApiKeyByPrefix.mockResolvedValue(storedKeyWith(["*"]));

		const result = await verifyUserApiKey(RAW_KEY, "mcp:write");

		expect(result).toMatchObject({ valid: true, userId: "user-1" });
	});
});

describe("when no scope is required", () => {
	it("checks none — which is why callers must pass one", async () => {
		// Not an endorsement, a warning. Every caller that omits the argument
		// is accepting any valid key; the ones that should not were the bug.
		getUserApiKeyByPrefix.mockResolvedValue(storedKeyWith([]));

		const result = await verifyUserApiKey(RAW_KEY);

		expect(result.valid).toBe(true);
	});
});

describe("the checks that precede scope", () => {
	it("refuses an inactive key", async () => {
		getUserApiKeyByPrefix.mockResolvedValue({
			...storedKeyWith(["*"]),
			isActive: false,
		});

		expect(await verifyUserApiKey(RAW_KEY, "mcp:read")).toMatchObject({
			valid: false,
		});
	});

	it("refuses an expired one", async () => {
		getUserApiKeyByPrefix.mockResolvedValue({
			...storedKeyWith(["*"]),
			expiresAt: new Date(Date.now() - 1000),
		});

		expect(await verifyUserApiKey(RAW_KEY, "mcp:read")).toMatchObject({
			valid: false,
		});
	});

	it("refuses one whose hash does not match", async () => {
		getUserApiKeyByPrefix.mockResolvedValue({
			...storedKeyWith(["*"]),
			keyHash: "not-the-hash",
		});

		expect(await verifyUserApiKey(RAW_KEY, "mcp:read")).toMatchObject({
			valid: false,
		});
	});
});
