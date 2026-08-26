/**
 * Integration tests for the public audit-log REST endpoints.
 *
 * Drives the Hono sub-app directly via `app.request(...)` — no need to
 * spin up an HTTP listener. Covers:
 *
 *   - Bearer required (401 without)
 *   - Scope enforcement (401 wrong scope ≠ 403 wrong scope — we use 403
 *     for known key + missing scope, 401 for unknown / bad key)
 *   - Pagination cursor walk
 *   - Tenant isolation: an org key cannot fetch a different org's rows
 *   - audit.api_request emit on success
 *   - CSV export round-trip
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getUserApiKeyByPrefixIncludingRevoked: vi.fn(),
	getOrganizationApiKeyByPrefixIncludingRevoked: vi.fn(),
	listAuditLog: vi.fn(),
	countAuditLog: vi.fn(),
	fetchAuditLogForExport: vi.fn(),
	recordAudit: vi.fn(),
	checkRateLimit: vi.fn().mockResolvedValue({
		allowed: true,
		remaining: 599,
		resetInSeconds: 60,
		statusCode: 200,
	}),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getUserApiKeyByPrefixIncludingRevoked:
			mocks.getUserApiKeyByPrefixIncludingRevoked,
		getOrganizationApiKeyByPrefixIncludingRevoked:
			mocks.getOrganizationApiKeyByPrefixIncludingRevoked,
		listAuditLog: mocks.listAuditLog,
		countAuditLog: mocks.countAuditLog,
		fetchAuditLogForExport: mocks.fetchAuditLogForExport,
		recordAudit: mocks.recordAudit,
		// Stub out `db` so the fire-and-forget usage bump path doesn't
		// require a real Prisma connection.
		db: {
			userApiKey: { update: vi.fn().mockResolvedValue({}) },
			organizationApiKey: { update: vi.fn().mockResolvedValue({}) },
		},
	};
});

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
	apiKeyRestUnattributableRejections: { inc: vi.fn() },
}));

vi.mock("@repo/payments", () => ({ AiUsageLimitExceededError: class {} }));

vi.mock("../../../../lib/rate-limit", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		checkRateLimit: mocks.checkRateLimit,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: () => "127.0.0.1",
}));

import { createAuditLogRestRoutes } from "../routes";

function hashFor(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

function makeRow(over: Record<string, unknown> = {}) {
	return {
		id: "audit-1",
		organizationId: "org-1",
		userId: "user-1",
		actorType: "user",
		actorEmailSnapshot: "alice@example.com",
		actorNameSnapshot: "Alice",
		impersonatedById: null,
		action: "auth.login.success",
		category: "auth",
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
		createdAt: new Date("2026-05-16T12:00:00Z"),
		...over,
	};
}

beforeEach(() => {
	mocks.getUserApiKeyByPrefixIncludingRevoked.mockReset();
	mocks.getOrganizationApiKeyByPrefixIncludingRevoked.mockReset();
	mocks.listAuditLog.mockReset();
	mocks.countAuditLog.mockReset();
	mocks.fetchAuditLogForExport.mockReset();
	mocks.recordAudit.mockReset();
	mocks.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 599,
		resetInSeconds: 60,
		statusCode: 200,
	});
});

describe("GET /audit-log — auth", () => {
	it("returns 401 without Authorization header", async () => {
		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log");
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe("MISSING_AUTHORIZATION");
	});

	it("returns 401 with malformed bearer token", async () => {
		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log", {
			headers: { Authorization: "Bearer not_a_real_key" },
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 for valid prefix shape but unknown key", async () => {
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue(null);
		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log", {
			headers: { Authorization: "Bearer fab_aaaaaaaa_secret" },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe("INVALID_API_KEY");
	});

	it("distinguishes a revoked key from an unknown one", async () => {
		// Regression guard. The lookup used to filter `isActive: true` in the
		// WHERE clause, so a revoked key came back as null and the caller was
		// told `INVALID_API_KEY` — the same message as "this key never existed".
		// An operator debugging "my key stopped working after I revoked it" had
		// no way to tell the two apart, even though the OpenAPI spec documents
		// API_KEY_REVOKED as a distinct, actionable code.
		const raw = "fab_aaaaaaaa_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key_revoked",
			userId: "user_1",
			name: "Revoked key",
			keyPrefix: "fab_aaaaaaaa",
			keyHash: hashFor(raw),
			scopes: ["audit_log:read"],
			isActive: false,
			expiresAt: null,
		});
		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe("API_KEY_REVOKED");
	});

	it("returns 403 when scope is missing", async () => {
		const raw = "fab_aaaaaaaa_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-1",
			keyHash: hashFor(raw),
			keyPrefix: "fab_aaaaaaaa",
			name: "test-key",
			scopes: ["mcp:read"],
			isActive: true,
			expiresAt: null,
		});
		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.code).toBe("INSUFFICIENT_SCOPE");
	});
});

describe("GET /audit-log — happy path + tenant isolation", () => {
	it("returns paginated rows for a personal key", async () => {
		const raw = "fab_aaaaaaaa_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_aaaaaaaa",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.listAuditLog.mockResolvedValue({
			items: [makeRow({ id: "row-1" }), makeRow({ id: "row-2" })],
			nextCursor: "next-page-cursor",
			totalCount: 2,
		});

		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log?limit=10", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.items).toHaveLength(2);
		expect(body.nextCursor).toBe("next-page-cursor");

		// Scope was personal — listAuditLog should be called with
		// { organizationId: null, userId: "user-99" }.
		expect(mocks.listAuditLog).toHaveBeenCalledTimes(1);
		const call = mocks.listAuditLog.mock.calls[0][0];
		expect(call.scope).toEqual({ organizationId: null, userId: "user-99" });
	});

	it("returns paginated rows for an org key with org-scoped query", async () => {
		const raw = "org_bbbbbbbb_secret";
		mocks.getOrganizationApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-2",
			organizationId: "org-123",
			createdByUserId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "org_bbbbbbbb",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.listAuditLog.mockResolvedValue({
			items: [makeRow({ id: "row-3" })],
			nextCursor: null,
		});

		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(200);
		const call = mocks.listAuditLog.mock.calls[0][0];
		// Tenant-isolation invariant: the SCOPE is derived from the key,
		// not from any client-supplied parameter. An attacker cannot
		// pass `organizationId=other-org` because the REST endpoint
		// doesn't accept that param.
		expect(call.scope).toEqual({
			organizationId: "org-123",
			userId: null,
		});
	});

	it("does NOT use a query-string organizationId for tenant scope (adversarial)", async () => {
		const raw = "org_cccccccc_secret";
		mocks.getOrganizationApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-3",
			organizationId: "org-MINE",
			createdByUserId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "org_cccccccc",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.listAuditLog.mockResolvedValue({ items: [], nextCursor: null });

		const app = createAuditLogRestRoutes();
		// Adversarial query param trying to flip into another org.
		await app.request("/audit-log?organizationId=org-OTHER", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		const call = mocks.listAuditLog.mock.calls[0][0];
		// The scope MUST be org-MINE regardless of the bogus param.
		expect(call.scope.organizationId).toBe("org-MINE");
	});

	it("emits one audit.api_request row per successful call", async () => {
		const raw = "fab_eeeeeeee_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_eeeeeeee",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.listAuditLog.mockResolvedValue({
			items: [makeRow()],
			nextCursor: null,
		});

		const app = createAuditLogRestRoutes();
		await app.request("/audit-log", {
			headers: { Authorization: `Bearer ${raw}` },
		});

		// Exactly one audit.api_request emission per request (D12-shape).
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const emit = mocks.recordAudit.mock.calls[0][0];
		expect(emit.action).toBe("audit.api_request");
		expect(emit.actor.type).toBe("api_key");
		// Prefix is logged; raw key MUST NOT be in metadata. Field is `keyPrefix`
		// (not `apiKeyPrefix`) so the metadata redactor — which substring-
		// matches `apikey` — does not strip the operator-visible identifier.
		expect(emit.metadata.keyPrefix).toBe("fab_eeeeeeee");
		expect(JSON.stringify(emit.metadata)).not.toContain(raw);
	});
});

describe("GET /audit-log — pagination cursor walk", () => {
	it("propagates the cursor query param into the underlying query", async () => {
		const raw = "fab_dddddddd_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_dddddddd",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.listAuditLog.mockResolvedValue({
			items: [makeRow()],
			nextCursor: null,
		});

		const app = createAuditLogRestRoutes();
		await app.request("/audit-log?cursor=abc123&limit=200", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		const call = mocks.listAuditLog.mock.calls[0][0];
		expect(call.cursor).toBe("abc123");
		expect(call.limit).toBe(200);
	});

	it("clamps limit above 200", async () => {
		const raw = "fab_dddddddd_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_dddddddd",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.listAuditLog.mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const app = createAuditLogRestRoutes();
		await app.request("/audit-log?limit=999999", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		const call = mocks.listAuditLog.mock.calls[0][0];
		expect(call.limit).toBe(200);
	});

	it("returns 400 on bad cursor", async () => {
		const raw = "fab_dddddddd_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_dddddddd",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.listAuditLog.mockRejectedValue(new Error("Invalid cursor"));

		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log?cursor=bad", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /audit-log/export", () => {
	it("requires audit_log:export scope (403 when only :read)", async () => {
		const raw = "fab_ffffffff_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_ffffffff",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log/export?format=csv", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(403);
	});

	it("returns CSV body on success", async () => {
		const raw = "fab_ffffffff_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_ffffffff",
			name: "test-key",
			scopes: ["audit_log:export"],
			isActive: true,
			expiresAt: null,
		});
		mocks.countAuditLog.mockResolvedValue(1);
		mocks.fetchAuditLogForExport.mockResolvedValue([makeRow()]);

		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log/export?format=csv", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/csv");
		const body = await res.text();
		// CSV serializer doesn't emit the row id column, but it does emit
		// the actor email and action — both come from the mocked row.
		expect(body).toContain("alice@example.com");
		expect(body).toContain("auth.login.success");
		expect(res.headers.get("Content-Disposition")).toContain("attachment");
	});

	it("returns NDJSON body when format=ndjson", async () => {
		const raw = "fab_ffffffff_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_ffffffff",
			name: "test-key",
			scopes: ["audit_log:export"],
			isActive: true,
			expiresAt: null,
		});
		mocks.countAuditLog.mockResolvedValue(1);
		mocks.fetchAuditLogForExport.mockResolvedValue([makeRow()]);

		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log/export?format=ndjson", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain(
			"application/x-ndjson",
		);
		const body = await res.text();
		expect(body).toContain('"id":"audit-1"');
	});

	it("rejects exports above the 50k cap", async () => {
		const raw = "fab_ffffffff_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_ffffffff",
			name: "test-key",
			scopes: ["audit_log:export"],
			isActive: true,
			expiresAt: null,
		});
		mocks.countAuditLog.mockResolvedValue(50_001);

		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log/export?format=csv", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(400);
	});
});

describe("Rate limit", () => {
	it("returns 429 when the rate-limit check denies", async () => {
		const raw = "fab_gggggggg_secret";
		mocks.getUserApiKeyByPrefixIncludingRevoked.mockResolvedValue({
			id: "key-1",
			userId: "user-99",
			keyHash: hashFor(raw),
			keyPrefix: "fab_gggggggg",
			name: "test-key",
			scopes: ["audit_log:read"],
			isActive: true,
			expiresAt: null,
		});
		mocks.checkRateLimit.mockResolvedValueOnce({
			allowed: false,
			remaining: 0,
			resetInSeconds: 12,
			statusCode: 429,
		});

		const app = createAuditLogRestRoutes();
		const res = await app.request("/audit-log", {
			headers: { Authorization: `Bearer ${raw}` },
		});
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("12");
	});
});
