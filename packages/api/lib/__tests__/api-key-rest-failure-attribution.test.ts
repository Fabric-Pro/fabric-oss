/**
 * Rejected public-API attempts must land somewhere a human can read them.
 *
 * The failure rows added with the shared REST middleware were written with
 * `organizationId: null` and no user FK. `buildAuditWhere` resolves personal
 * scope to `organizationId IS NULL AND userId = <caller>`, so a row with neither
 * matched no tenant-scoped query — the rows existed and no UI or API could reach
 * them. Confirmed against a deployed environment: four rejected attempts
 * produced zero `audit.api_request` failures in a personal-scope read.
 *
 * These tests assert the TENANT FIELDS ON THE RECORDED ROW, which is the layer
 * the defect lived in. A test that only asserted the HTTP status would have
 * passed throughout.
 *
 * The security half matters as much as the visibility half: attribution must
 * follow the hash compare, never the prefix. Prefix-guessing writing rows into a
 * stranger's audit trail would be a worse defect than invisible rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAuditFromRequest = vi.fn();
const verifyAuditApiKey = vi.fn();
const checkRateLimit = vi.fn();
const unattributableInc = vi.fn();

vi.mock("../audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		recordAuditFromRequest(...args),
}));
vi.mock("../rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
	RATE_LIMIT_PRESETS: { auditExternal: { limit: 100, windowMs: 60_000 } },
}));
vi.mock("../../modules/audit/rest/verify-audit-key", () => ({
	verifyAuditApiKey: (...args: unknown[]) => verifyAuditApiKey(...args),
}));
vi.mock("@repo/observability", () => ({
	apiKeyRestUnattributableRejections: {
		inc: (...args: unknown[]) => unattributableInc(...args),
	},
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { apiKeyRestAuth, insufficientScope } from "../api-key-rest-auth";

const ORG_OWNER = {
	type: "org" as const,
	userId: "user-creator",
	organizationId: "org-1",
};
const USER_OWNER = {
	type: "user" as const,
	userId: "user-owner",
	organizationId: null,
};

/** Minimal Hono-shaped context: only what the middleware actually touches. */
function makeContext(authHeader?: string) {
	const store = new Map<string, unknown>();
	return {
		req: {
			url: "https://example.com/api/v1/system-health",
			method: "GET",
			header: (name: string) =>
				name === "Authorization" ? authHeader : undefined,
			raw: { headers: new Headers() },
		},
		header: vi.fn(),
		json: (body: unknown, status?: number) => ({ body, status }),
		set: (k: string, v: unknown) => store.set(k, v),
		get: (k: string) => store.get(k),
		// biome-ignore lint/suspicious/noExplicitAny: test double for Hono's Context
	} as any;
}

function recordedRow() {
	expect(recordAuditFromRequest).toHaveBeenCalledTimes(1);
	return recordAuditFromRequest.mock.calls[0]?.[1] as {
		organizationId: string | null;
		actor: { type: string; userId?: string };
		metadata: { errorCode: string };
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 99,
		resetInSeconds: 60,
		statusCode: 200,
	});
});

describe("attempts whose secret verified are attributed to the owner", () => {
	it("writes a revoked-key rejection into the owning organization's trail", async () => {
		verifyAuditApiKey.mockResolvedValue({
			ok: false,
			error: "INACTIVE",
			provenOwner: ORG_OWNER,
		});

		const res = await apiKeyRestAuth()(
			makeContext("Bearer org_abc12345_secret"),
			vi.fn(),
		);

		expect(res).toMatchObject({ status: 401 });
		const row = recordedRow();
		expect(row.metadata.errorCode).toBe("API_KEY_REVOKED");
		// The two fields that decide whether the row is ever readable.
		expect(row.organizationId).toBe("org-1");
		expect(row.actor.userId).toBe("user-creator");
		expect(row.actor.type).toBe("api_key");
		expect(unattributableInc).not.toHaveBeenCalled();
	});

	it("writes an expired personal-key rejection with the owner's user FK", async () => {
		verifyAuditApiKey.mockResolvedValue({
			ok: false,
			error: "EXPIRED",
			provenOwner: USER_OWNER,
		});

		await apiKeyRestAuth()(
			makeContext("Bearer fab_abc12345_secret"),
			vi.fn(),
		);

		const row = recordedRow();
		// Personal scope reads `organizationId IS NULL AND userId = caller`, so
		// null org here is correct and the userId is what makes it visible.
		expect(row.organizationId).toBeNull();
		expect(row.actor.userId).toBe("user-owner");
	});

	it("attributes a rate-limit rejection to the verified key's owner", async () => {
		verifyAuditApiKey.mockResolvedValue({
			ok: true,
			key: {
				keyId: "k1",
				keyPrefix: "org_abc12345",
				keyName: "n",
				owner: ORG_OWNER,
				scopes: ["system_health:read"],
			},
			provenOwner: ORG_OWNER,
		});
		checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 30,
			statusCode: 429,
		});

		const res = await apiKeyRestAuth()(
			makeContext("Bearer org_abc12345_secret"),
			vi.fn(),
		);

		expect(res).toMatchObject({ status: 429 });
		const row = recordedRow();
		expect(row.metadata.errorCode).toBe("TOO_MANY_REQUESTS");
		expect(row.organizationId).toBe("org-1");
		expect(row.actor.userId).toBe("user-creator");
	});

	it("attributes a scope refusal to the verified key's owner", () => {
		const c = makeContext();
		c.set("verifiedKey", {
			keyId: "k1",
			keyPrefix: "org_abc12345",
			keyName: "n",
			owner: ORG_OWNER,
			scopes: ["audit_log:read"],
		});

		const res = insufficientScope(c, "system_health:read");

		expect(res.status).toBe(403);
		const row = recordedRow();
		expect(row.metadata.errorCode).toBe("INSUFFICIENT_SCOPE");
		expect(row.organizationId).toBe("org-1");
		expect(row.actor.userId).toBe("user-creator");
	});
});

describe("attempts with no proven owner stay tenant-less", () => {
	// The security boundary. If any of these gained a tenant, guessing an 8-hex
	// prefix would inject rows into that tenant's audit trail.
	it.each([
		[
			"HASH_MISMATCH",
			"Bearer org_abc12345_wrong-secret",
			"INVALID_API_KEY",
		],
		["NOT_FOUND", "Bearer fab_00000000_nope", "INVALID_API_KEY"],
		["MISSING_HEADER", undefined, "MISSING_AUTHORIZATION"],
		["INVALID_FORMAT", "Bearer garbage", "INVALID_API_KEY_FORMAT"],
	])(
		"%s carries no organizationId and no user FK",
		async (error, header, expectedCode) => {
			// No `provenOwner` — the verifier only sets it after the hash compare.
			verifyAuditApiKey.mockResolvedValue({ ok: false, error });

			await apiKeyRestAuth()(makeContext(header), vi.fn());

			const row = recordedRow();
			expect(row.metadata.errorCode).toBe(expectedCode);
			expect(row.organizationId).toBeNull();
			expect(row.actor.userId).toBeUndefined();
			// Unreachable by any tenant-scoped read, so it has to be alertable.
			expect(unattributableInc).toHaveBeenCalledWith({
				error_code: expectedCode,
			});
		},
	);
});
