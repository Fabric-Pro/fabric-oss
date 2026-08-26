/**
 * Unit tests for the audit-log API key oRPC procedures.
 *
 * Covers `audit.apiKeys.create` (personal + org) and the rotate/revoke
 * variants. Verifies:
 *
 *   - Raw key is returned ONCE on create; the hash is stored, not the
 *     raw value.
 *   - `account.api_key.created` / `org.api_key.created` emits fire
 *     with the right metadata (no raw key in metadata).
 *   - Rotate generates a new prefix and hash; old keyPrefix is
 *     captured in the audit metadata.
 *   - Revoke flips `isActive=false` and emits the right action.
 *   - Non-owner/admin org access is rejected with FORBIDDEN.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createUserApiKey: vi.fn(),
	createOrganizationApiKey: vi.fn(),
	getOrganizationMembership: vi.fn(),
	recordAudit: vi.fn(),
	userApiKeyFindFirst: vi.fn(),
	userApiKeyUpdate: vi.fn(),
	orgApiKeyFindFirst: vi.fn(),
	orgApiKeyUpdate: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createUserApiKey: mocks.createUserApiKey,
		createOrganizationApiKey: mocks.createOrganizationApiKey,
		getOrganizationMembership: mocks.getOrganizationMembership,
		recordAudit: mocks.recordAudit,
		db: {
			userApiKey: {
				findFirst: mocks.userApiKeyFindFirst,
				update: mocks.userApiKeyUpdate,
			},
			organizationApiKey: {
				findFirst: mocks.orgApiKeyFindFirst,
				update: mocks.orgApiKeyUpdate,
			},
		},
	};
});

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

vi.mock("@repo/payments", () => ({ AiUsageLimitExceededError: class {} }));

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: () => "127.0.0.1",
}));

import { createAuditApiKeyProcedure } from "../create";
import { revokeAuditApiKeyProcedure } from "../revoke";
import { rotateAuditApiKeyProcedure } from "../rotate";

function makeContext() {
	return {
		user: { id: "user-1", email: "alice@example.com", name: "Alice" },
		session: {
			id: "session-1",
			activeOrganizationId: null,
		},
		headers: new Headers(),
	};
}

const createHandler = (
	createAuditApiKeyProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: ReturnType<typeof makeContext>;
				input: Record<string, unknown>;
			}) => Promise<Record<string, unknown>>;
		};
	}
)["~orpc"].handler;

const rotateHandler = (
	rotateAuditApiKeyProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: ReturnType<typeof makeContext>;
				input: Record<string, unknown>;
			}) => Promise<Record<string, unknown>>;
		};
	}
)["~orpc"].handler;

const revokeHandler = (
	revokeAuditApiKeyProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: ReturnType<typeof makeContext>;
				input: Record<string, unknown>;
			}) => Promise<Record<string, unknown>>;
		};
	}
)["~orpc"].handler;

beforeEach(() => {
	mocks.createUserApiKey.mockReset();
	mocks.createOrganizationApiKey.mockReset();
	mocks.getOrganizationMembership.mockReset();
	mocks.recordAudit.mockReset();
	mocks.userApiKeyFindFirst.mockReset();
	mocks.userApiKeyUpdate.mockReset();
	mocks.orgApiKeyFindFirst.mockReset();
	mocks.orgApiKeyUpdate.mockReset();
});

describe("audit.apiKeys.create — personal", () => {
	it("returns the raw key once and emits account.api_key.created", async () => {
		mocks.createUserApiKey.mockImplementation(async (args) => ({
			id: "key-new",
			userId: "user-1",
			name: args.name,
			keyHash: args.keyHash,
			keyPrefix: args.keyPrefix,
			scopes: args.scopes,
			expiresAt: args.expiresAt ?? null,
			lastUsedAt: null,
			usageCount: 0,
			isActive: true,
			createdAt: new Date("2026-05-17T00:00:00Z"),
		}));

		const result = (await createHandler({
			context: makeContext(),
			input: {
				organizationId: null,
				name: "SRE laptop",
				scopes: ["audit_log:read"],
				expiresInDays: 90,
			},
		})) as { rawKey: string; keyPrefix: string; id: string };

		expect(result.rawKey).toMatch(/^fab_[0-9a-f]{8}_[A-Za-z0-9_-]+$/);
		expect(result.keyPrefix).toMatch(/^fab_[0-9a-f]{8}$/);

		// The stored hash must be the SHA-256 of the raw key.
		const storedHash = mocks.createUserApiKey.mock.calls[0][0].keyHash;
		expect(storedHash).toBe(
			createHash("sha256").update(result.rawKey).digest("hex"),
		);

		// Audit emission
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const emit = mocks.recordAudit.mock.calls[0][0];
		expect(emit.action).toBe("account.api_key.created");
		// Critical: raw key MUST NOT appear in the audit metadata.
		expect(JSON.stringify(emit)).not.toContain(result.rawKey);
		// Prefix is allowed (it's not a secret on its own).
		expect(emit.metadata.keyPrefix).toBe(result.keyPrefix);
	});

	it("supports never-expires (expiresInDays null)", async () => {
		mocks.createUserApiKey.mockImplementation(async (args) => ({
			id: "key-1",
			userId: "user-1",
			name: args.name,
			keyHash: args.keyHash,
			keyPrefix: args.keyPrefix,
			scopes: args.scopes,
			expiresAt: args.expiresAt ?? null,
			isActive: true,
			createdAt: new Date(),
			lastUsedAt: null,
			usageCount: 0,
		}));

		const result = (await createHandler({
			context: makeContext(),
			input: {
				organizationId: null,
				name: "Permanent",
				scopes: ["audit_log:read", "audit_log:export"],
				expiresInDays: null,
			},
		})) as { expiresAt: Date | null };
		expect(result.expiresAt).toBeNull();
	});
});

describe("audit.apiKeys.create — org", () => {
	it("requires owner/admin membership (rejects member with FORBIDDEN)", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "member",
		});

		await expect(
			createHandler({
				context: {
					...makeContext(),
					session: {
						id: "session-1",
						activeOrganizationId: "org-1",
					},
				},
				input: {
					organizationId: "org-1",
					name: "X",
					scopes: ["audit_log:read"],
					expiresInDays: 30,
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("emits org.api_key.created scoped to the right org", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.createOrganizationApiKey.mockImplementation(async (args) => ({
			id: "ok-1",
			organizationId: args.organizationId,
			createdByUserId: args.createdByUserId,
			name: args.name,
			keyHash: args.keyHash,
			keyPrefix: args.keyPrefix,
			scopes: args.scopes,
			expiresAt: args.expiresAt ?? null,
			isActive: true,
			createdAt: new Date(),
			lastUsedAt: null,
			usageCount: 0,
		}));

		await createHandler({
			context: {
				...makeContext(),
				session: {
					id: "session-1",
					activeOrganizationId: "org-1",
				},
			},
			input: {
				organizationId: "org-1",
				name: "Monitoring pipeline",
				scopes: ["audit_log:read"],
				expiresInDays: 365,
			},
		});

		const emit = mocks.recordAudit.mock.calls[0][0];
		expect(emit.action).toBe("org.api_key.created");
		expect(emit.organizationId).toBe("org-1");
	});
});

describe("audit.apiKeys.rotate", () => {
	it("rotates a personal key, generating a new prefix + hash", async () => {
		mocks.userApiKeyFindFirst.mockResolvedValue({
			id: "key-1",
			name: "Existing",
			scopes: ["audit_log:read"],
			keyPrefix: "fab_oldprefix",
		});
		mocks.userApiKeyUpdate.mockImplementation(async (args) => ({
			id: args.where.id,
			name: "Existing",
			scopes: ["audit_log:read"],
			keyPrefix: args.data.keyPrefix,
		}));

		const result = (await rotateHandler({
			context: makeContext(),
			input: {
				organizationId: null,
				id: "key-1",
			},
		})) as { keyPrefix: string; rawKey: string };

		expect(result.keyPrefix).toMatch(/^fab_[0-9a-f]{8}$/);
		expect(result.keyPrefix).not.toBe("fab_oldprefix");

		// Stored hash matches the raw key.
		const update = mocks.userApiKeyUpdate.mock.calls[0][0];
		expect(update.data.keyHash).toBe(
			createHash("sha256").update(result.rawKey).digest("hex"),
		);

		const emit = mocks.recordAudit.mock.calls[0][0];
		expect(emit.action).toBe("account.api_key.rotated");
		expect(emit.metadata.previousKeyPrefix).toBe("fab_oldprefix");
	});

	it("returns NOT_FOUND when the key id doesn't belong to the caller", async () => {
		mocks.userApiKeyFindFirst.mockResolvedValue(null);

		await expect(
			rotateHandler({
				context: makeContext(),
				input: { organizationId: null, id: "key-other-user" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("audit.apiKeys.revoke", () => {
	it("flips isActive=false on a personal key", async () => {
		mocks.userApiKeyFindFirst.mockResolvedValue({
			id: "key-1",
			name: "X",
			scopes: ["audit_log:read"],
			keyPrefix: "fab_aaaaaaaa",
		});
		mocks.userApiKeyUpdate.mockResolvedValue({});

		const result = (await revokeHandler({
			context: makeContext(),
			input: { organizationId: null, id: "key-1" },
		})) as { revoked: boolean };

		expect(result.revoked).toBe(true);
		const update = mocks.userApiKeyUpdate.mock.calls[0][0];
		expect(update.data.isActive).toBe(false);

		const emit = mocks.recordAudit.mock.calls[0][0];
		expect(emit.action).toBe("account.api_key.revoked");
	});

	it("returns NOT_FOUND when the key id doesn't exist", async () => {
		mocks.userApiKeyFindFirst.mockResolvedValue(null);
		await expect(
			revokeHandler({
				context: makeContext(),
				input: { organizationId: null, id: "phantom" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
