/**
 * Tests for adminAuditLogViaApiKeyProcedure.
 *
 * Coverage:
 *   - org_* key → resolves to that org's audit log; tenant.kind === "organization".
 *   - fab_* key → resolves to that user's personal audit log; tenant.kind === "personal".
 *   - Unknown prefix → ORPCError BAD_REQUEST.
 *   - Invalid org key (verifier returns null) → ORPCError UNAUTHORIZED.
 *   - Invalid fab key (verifier returns valid=false) → ORPCError UNAUTHORIZED.
 *   - Happy path emits an `admin.auditLog.viaApiKey` audit row via recordAuditLog.
 *   - The full API key is NEVER persisted — only the first 12 chars survive
 *     into the audit row's metadata.keyPrefix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyOrgMock, verifyUserMock, listAuditLogMock, recordAuditMock } =
	vi.hoisted(() => ({
		verifyOrgMock: vi.fn(),
		verifyUserMock: vi.fn(),
		listAuditLogMock: vi.fn(),
		recordAuditMock: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	verifyOrganizationApiKey: (h: string) => verifyOrgMock(h),
	listAuditLog: (input: unknown) => listAuditLogMock(input),
}));

// The proxy moved off the bare `recordAudit` helper to
// `recordAuditFromRequest` so the staff member's IP / UA / correlation id
// land on the audit row (previously these were always null). Mock the
// wrapper to capture the merged input the same way the legacy mock did.
vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (_ctx: unknown, input: unknown) =>
		recordAuditMock({
			...(input as Record<string, unknown>),
			actor: {
				type: "user",
				userId: (_ctx as { user: { id: string } }).user.id,
				emailSnapshot: (_ctx as { user: { email: string } }).user.email,
				nameSnapshot: (_ctx as { user: { name: string } }).user.name,
			},
		}),
}));

vi.mock("../../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: (k: string) => verifyUserMock(k),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		adminProcedure: chainable,
		// The proxy procedures gained `.use(requirePermission(...))` to
		// satisfy the permission-coverage scanner. We stub it as a no-op
		// middleware factory — the test exercises the handler directly
		// via the captured `_handler` callback and doesn't depend on the
		// middleware running.
		requirePermission: () => () => ({}),
		Permissions: { ORG_AUDIT_LOG_READ: "org:audit_log:read" } as const,
	};
});

vi.mock("@orpc/client", () => ({
	ORPCError: class extends Error {
		readonly code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
}));

const adminCtx = {
	user: {
		id: "admin-1",
		role: "admin",
		email: "admin@example.com",
		name: "Admin User",
	},
};

async function loadHandler() {
	const mod = await import("../audit-log-via-api-key");
	return (mod.adminAuditLogViaApiKeyProcedure as any)._handler as (args: {
		input: Record<string, unknown>;
		context: typeof adminCtx;
	}) => Promise<{
		tenant: {
			kind: "organization" | "personal";
			organizationId: string | null;
			userId: string | null;
			keyType: string;
			keyPrefix: string;
		};
		items: unknown[];
		nextCursor: string | null;
		total: number;
	}>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	listAuditLogMock.mockResolvedValue({
		items: [],
		nextCursor: null,
		total: 0,
	});
	recordAuditMock.mockResolvedValue({ id: "audit-emit-1" });
});

describe("adminAuditLogViaApiKeyProcedure — happy path tenant resolution", () => {
	it("resolves org_* key to that org's audit log", async () => {
		verifyOrgMock.mockResolvedValue({
			id: "key-1",
			organizationId: "org-1",
			createdByUserId: "u-1",
			scopes: ["*"],
		});
		const handler = await loadHandler();
		const result = await handler({
			input: {
				apiKey: "org_bc52818d_N4UpxiHhOH0L70Ei26XNg2dEACFNwNZ5",
				limit: 50,
			},
			context: adminCtx,
		});

		expect(result.tenant.kind).toBe("organization");
		expect(result.tenant.organizationId).toBe("org-1");
		expect(result.tenant.userId).toBeNull();
		expect(result.tenant.keyType).toBe("organization");
		// First 12 chars only — the secret is gone.
		expect(result.tenant.keyPrefix).toBe("org_bc52818d");

		// listAuditLog was called with the resolved org scope.
		const listArgs = listAuditLogMock.mock.calls[0]?.[0] as {
			scope: { organizationId: string | null; userId: string | null };
		};
		expect(listArgs.scope.organizationId).toBe("org-1");
		expect(listArgs.scope.userId).toBeNull();
	});

	it("resolves fab_* key to that user's personal audit log", async () => {
		verifyUserMock.mockResolvedValue({
			valid: true,
			userId: "u-personal-1",
			keyId: "key-2",
			scopes: ["audit-log:read"],
		});
		const handler = await loadHandler();
		const result = await handler({
			input: {
				apiKey: "fab_abcdef01_secretvalueIRREVOCABLY_DROPPED",
				limit: 50,
			},
			context: adminCtx,
		});

		expect(result.tenant.kind).toBe("personal");
		expect(result.tenant.organizationId).toBeNull();
		expect(result.tenant.userId).toBe("u-personal-1");
		expect(result.tenant.keyType).toBe("personal");
		expect(result.tenant.keyPrefix).toBe("fab_abcdef01");

		const listArgs = listAuditLogMock.mock.calls[0]?.[0] as {
			scope: { organizationId: string | null; userId: string | null };
		};
		expect(listArgs.scope.organizationId).toBeNull();
		expect(listArgs.scope.userId).toBe("u-personal-1");
	});
});

describe("adminAuditLogViaApiKeyProcedure — authorization failures", () => {
	it("rejects an unknown-prefix key with BAD_REQUEST", async () => {
		const handler = await loadHandler();
		await expect(
			handler({
				input: { apiKey: "sk_test_not_a_fabric_key", limit: 50 },
				context: adminCtx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects an invalid org_* key with UNAUTHORIZED", async () => {
		verifyOrgMock.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(
			handler({
				input: { apiKey: "org_deadbeef_invalid", limit: 50 },
				context: adminCtx,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects an invalid fab_* key with UNAUTHORIZED", async () => {
		verifyUserMock.mockResolvedValue({ valid: false, error: "bad key" });
		const handler = await loadHandler();
		await expect(
			handler({
				input: { apiKey: "fab_deadbeef_invalid", limit: 50 },
				context: adminCtx,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("adminAuditLogViaApiKeyProcedure — audit emit", () => {
	it("emits an admin.auditLog.viaApiKey audit row capturing the actor + target + key prefix only", async () => {
		verifyOrgMock.mockResolvedValue({
			id: "key-1",
			organizationId: "org-1",
			createdByUserId: "u-1",
			scopes: ["*"],
		});
		listAuditLogMock.mockResolvedValue({
			items: [
				{
					id: "row-1",
					organizationId: "org-1",
					userId: "u-1",
					actorType: "user",
					actorEmailSnapshot: null,
					actorNameSnapshot: null,
					impersonatedById: null,
					action: "feature.created",
					category: "data",
					severity: "info",
					outcome: "success",
					resourceType: null,
					resourceId: null,
					resourceName: null,
					projectId: null,
					ipAddress: null,
					userAgent: null,
					requestId: null,
					sessionId: null,
					metadata: null,
					durationMs: null,
					createdAt: new Date("2026-05-18T00:00:00.000Z"),
				},
			],
			nextCursor: null,
			total: 1,
		});

		const handler = await loadHandler();
		await handler({
			input: {
				apiKey: "org_bc52818d_secretvalueIRREVOCABLY_DROPPED",
				limit: 50,
				action: "feature.created",
			},
			context: adminCtx,
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const emit = recordAuditMock.mock.calls[0]?.[0] as {
			action: string;
			actor: { userId: string; emailSnapshot: string | null };
			metadata: {
				keyPrefix: string;
				targetTenant: { organizationId: string | null };
			};
		};
		expect(emit.action).toBe("admin.auditLog.viaApiKey");
		expect(emit.actor.userId).toBe("admin-1");
		expect(emit.actor.emailSnapshot).toBe("admin@example.com");
		// Key prefix is the first 12 chars only — the secret is never persisted.
		expect(emit.metadata.keyPrefix).toBe("org_bc52818d");
		expect(emit.metadata.keyPrefix).not.toMatch(
			/secretvalueIRREVOCABLY_DROPPED/,
		);
		expect(emit.metadata.targetTenant.organizationId).toBe("org-1");
	});
});
