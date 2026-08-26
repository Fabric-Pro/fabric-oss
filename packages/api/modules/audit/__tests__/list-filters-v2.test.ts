/**
 * Tests for the additional filter and sort surface added in UI/UX
 * pass 2:
 *  - `actorTypes` (multi-select bucket)
 *  - `ipAddressContains` (case-insensitive substring)
 *  - `sort` enum: newest / oldest / severity_desc
 *
 * Each filter is exercised twice:
 *   - Zod-level: input round-trips through `auditListInputSchema` so we
 *     prove the validator accepts and bounds the new fields.
 *   - Handler-level: `listAuditLogProcedure["~orpc"].handler` is called
 *     directly and we inspect the args the mocked `listAuditLog` query
 *     received. The DB-side translation (`buildAuditWhere`) is exercised
 *     by the integration smoke test on a live Postgres.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { auditListInputSchema } from "../lib/schemas";

const mocks = vi.hoisted(() => ({
	listAuditLog: vi.fn(),
	recordAudit: vi.fn(),
	getTrustedClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		listAuditLog: mocks.listAuditLog,
		recordAudit: mocks.recordAudit,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: mocks.getTrustedClientIp,
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { listAuditLogProcedure } from "../procedures/list";

function makeContext() {
	return {
		user: {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
		},
		session: { id: "session-1" },
		headers: new Headers(),
	};
}

const handler = (
	listAuditLogProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: ReturnType<typeof makeContext>;
				input: Record<string, unknown>;
			}) => Promise<unknown>;
		};
	}
)["~orpc"].handler;

beforeEach(() => {
	mocks.listAuditLog.mockReset();
	mocks.recordAudit.mockReset();
});

describe("auditListInputSchema — new filters", () => {
	it("accepts a short ipAddressContains", () => {
		const result = auditListInputSchema.safeParse({
			organizationId: "org-1",
			limit: 50,
			filter: { ipAddressContains: "10.0." },
		});
		expect(result.success).toBe(true);
	});

	it("rejects ipAddressContains > 256 chars", () => {
		const result = auditListInputSchema.safeParse({
			organizationId: "org-1",
			limit: 50,
			filter: { ipAddressContains: "x".repeat(257) },
		});
		expect(result.success).toBe(false);
	});

	it("accepts actorTypes with valid buckets", () => {
		const result = auditListInputSchema.safeParse({
			organizationId: "org-1",
			limit: 50,
			filter: { actorTypes: ["user", "api_key"] },
		});
		expect(result.success).toBe(true);
	});

	it("rejects actorTypes with unknown bucket", () => {
		const result = auditListInputSchema.safeParse({
			organizationId: "org-1",
			limit: 50,
			filter: { actorTypes: ["user", "robot"] },
		});
		expect(result.success).toBe(false);
	});
});

describe("auditListInputSchema — sort", () => {
	it("defaults sort to 'newest' when omitted", () => {
		const result = auditListInputSchema.safeParse({
			organizationId: "org-1",
			limit: 50,
			filter: {},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.sort).toBe("newest");
		}
	});

	it("accepts each sort variant", () => {
		for (const sort of ["newest", "oldest", "severity_desc"] as const) {
			const result = auditListInputSchema.safeParse({
				organizationId: "org-1",
				limit: 50,
				filter: {},
				sort,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.sort).toBe(sort);
			}
		}
	});

	it("rejects an unknown sort enum", () => {
		const result = auditListInputSchema.safeParse({
			organizationId: "org-1",
			limit: 50,
			filter: {},
			sort: "random",
		});
		expect(result.success).toBe(false);
	});
});

describe("audit.list handler — round-trips new filters to the query", () => {
	it("forwards actorTypes to listAuditLog", async () => {
		mocks.listAuditLog.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				limit: 50,
				filter: { actorTypes: ["api_key"] },
			},
		});
		const call = mocks.listAuditLog.mock.calls[0]?.[0] as {
			filter: { actorTypes?: string[] };
		};
		expect(call.filter.actorTypes).toEqual(["api_key"]);
	});

	it("forwards ipAddressContains to listAuditLog", async () => {
		mocks.listAuditLog.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				limit: 50,
				filter: { ipAddressContains: "10.0." },
			},
		});
		const call = mocks.listAuditLog.mock.calls[0]?.[0] as {
			filter: { ipAddressContains?: string };
		};
		expect(call.filter.ipAddressContains).toBe("10.0.");
	});

	it("forwards the sort variant to listAuditLog (severity_desc)", async () => {
		mocks.listAuditLog.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				limit: 50,
				filter: {},
				sort: "severity_desc",
			},
		});
		const call = mocks.listAuditLog.mock.calls[0]?.[0] as {
			sort?: string;
		};
		expect(call.sort).toBe("severity_desc");
	});

	it("forwards the sort variant to listAuditLog (oldest)", async () => {
		mocks.listAuditLog.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				limit: 50,
				filter: {},
				sort: "oldest",
			},
		});
		const call = mocks.listAuditLog.mock.calls[0]?.[0] as {
			sort?: string;
		};
		expect(call.sort).toBe("oldest");
	});
});
