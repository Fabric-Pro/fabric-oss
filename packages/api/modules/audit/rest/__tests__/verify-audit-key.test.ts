/**
 * Unit tests for the public audit-log REST API key verifier.
 *
 * Covers:
 *   - Missing Authorization header
 *   - Malformed key format
 *   - Unknown prefix
 *   - Expired / inactive key
 *   - Hash mismatch (timing-safe compare path)
 *   - Happy-path personal key
 *   - Happy-path org key
 *   - Scope vocabulary (`audit_log:read`, `audit_log:export`, wildcard)
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getUserApiKeyByPrefixIncludingRevoked: vi.fn(),
	getOrganizationApiKeyByPrefixIncludingRevoked: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getUserApiKeyByPrefixIncludingRevoked:
			mocks.getUserApiKeyByPrefixIncludingRevoked,
		getOrganizationApiKeyByPrefixIncludingRevoked:
			mocks.getOrganizationApiKeyByPrefixIncludingRevoked,
	};
});

import {
	AUDIT_LOG_SCOPES,
	hasAuditLogScope,
	hashApiKey,
	verifyAuditApiKey,
} from "../verify-audit-key";

function hashFor(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

beforeEach(() => {
	mocks.getUserApiKeyByPrefixIncludingRevoked.mockReset();
	mocks.getOrganizationApiKeyByPrefixIncludingRevoked.mockReset();
});

describe("verifyAuditApiKey — error paths", () => {
	it("rejects missing key (undefined)", async () => {
		const r = await verifyAuditApiKey(undefined);
		expect(r.ok).toBe(false);
		expect(r.error).toBe("MISSING_HEADER");
	});

	it("rejects empty key", async () => {
		const r = await verifyAuditApiKey("");
		expect(r.ok).toBe(false);
		expect(r.error).toBe("MISSING_HEADER");
	});

	it("rejects garbage format", async () => {
		const r = await verifyAuditApiKey("bearer-not-a-key");
		expect(r.ok).toBe(false);
		expect(r.error).toBe("INVALID_FORMAT");
	});

	it("rejects unknown prefix (fab not in DB)", async () => {
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue(null);
		const r = await verifyAuditApiKey("fab_abc12345_xxxxxxx");
		expect(r.ok).toBe(false);
		expect(r.error).toBe("NOT_FOUND");
	});

	it("rejects inactive key", async () => {
		const raw = "fab_abc12345_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-1",
			keyHash: hashFor(raw),
			keyPrefix: "fab_abc12345",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: false,
			expiresAt: null,
		});
		const r = await verifyAuditApiKey(raw);
		expect(r.ok).toBe(false);
		expect(r.error).toBe("INACTIVE");
	});

	it("rejects expired key", async () => {
		const raw = "fab_abc12345_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-1",
			keyHash: hashFor(raw),
			keyPrefix: "fab_abc12345",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: new Date("2020-01-01"),
		});
		const r = await verifyAuditApiKey(raw);
		expect(r.ok).toBe(false);
		expect(r.error).toBe("EXPIRED");
	});

	it("rejects hash mismatch (timing-safe compare path)", async () => {
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-1",
			keyHash: hashFor("fab_abc12345_different-secret"),
			keyPrefix: "fab_abc12345",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		const r = await verifyAuditApiKey("fab_abc12345_attacker-guess");
		expect(r.ok).toBe(false);
		expect(r.error).toBe("HASH_MISMATCH");
	});
});

describe("verifyAuditApiKey — happy path", () => {
	it("accepts a valid personal key", async () => {
		const raw = "fab_abc12345_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_abc12345",
			name: "test-key",
			scopes: ["audit_log:read", "audit_log:export"],
			isActive: true,
			expiresAt: null,
		});
		const r = await verifyAuditApiKey(raw);
		expect(r.ok).toBe(true);
		expect(r.key).toBeDefined();
		expect(r.key?.keyId).toBe("key-1");
		expect(r.key?.owner.type).toBe("user");
		if (r.key?.owner.type === "user") {
			expect(r.key.owner.userId).toBe("user-99");
			expect(r.key.owner.organizationId).toBeNull();
		}
		expect(r.key?.scopes).toEqual(["audit_log:read", "audit_log:export"]);
	});

	it("accepts a valid organization key", async () => {
		const raw = "org_def67890_secret";
		mocks.getOrganizationApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-2",
			organizationId: "org-123",
			createdByUserId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "org_def67890",
			name: "SRE laptop",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		const r = await verifyAuditApiKey(raw);
		expect(r.ok).toBe(true);
		expect(r.key?.owner.type).toBe("org");
		expect(r.key?.keyName).toBe("SRE laptop");
		if (r.key?.owner.type === "org") {
			expect(r.key.owner.organizationId).toBe("org-123");
			expect(r.key.owner.userId).toBe("user-99");
		}
	});

	it("accepts a key whose expiresAt is in the future", async () => {
		const raw = "fab_abc12345_secret";
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_abc12345",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: future,
		});
		const r = await verifyAuditApiKey(raw);
		expect(r.ok).toBe(true);
	});
});

describe("hashApiKey", () => {
	it("uses SHA-256 (matches existing org/user key creation flow)", () => {
		// Same algorithm as `packages/api/modules/organizations/procedures/api-keys/create.ts`
		// and `packages/api/modules/v1/routes.ts` — parity check.
		const raw = "fab_test_value";
		expect(hashApiKey(raw)).toBe(
			createHash("sha256").update(raw).digest("hex"),
		);
	});
});

describe("hasAuditLogScope", () => {
	it("grants read when audit_log:read is present", () => {
		expect(
			hasAuditLogScope(["audit_log:read"], AUDIT_LOG_SCOPES.READ),
		).toBe(true);
	});

	it("does not grant export when only read is present", () => {
		expect(
			hasAuditLogScope(["audit_log:read"], AUDIT_LOG_SCOPES.EXPORT),
		).toBe(false);
	});

	it("grants export when audit_log:export is present", () => {
		expect(
			hasAuditLogScope(["audit_log:export"], AUDIT_LOG_SCOPES.EXPORT),
		).toBe(true);
	});

	it("wildcard scope grants both", () => {
		expect(hasAuditLogScope(["*"], AUDIT_LOG_SCOPES.READ)).toBe(true);
		expect(hasAuditLogScope(["*"], AUDIT_LOG_SCOPES.EXPORT)).toBe(true);
	});

	it("denies when scope array is empty", () => {
		expect(hasAuditLogScope([], AUDIT_LOG_SCOPES.READ)).toBe(false);
	});

	it("does not grant audit scopes via unrelated MCP scopes", () => {
		expect(
			hasAuditLogScope(
				["mcp:read", "mcp:write", "agents:read"],
				AUDIT_LOG_SCOPES.READ,
			),
		).toBe(false);
	});
});
