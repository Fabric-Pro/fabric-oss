/**
 * Unit tests for `aiUsageLimits.list` procedure.
 * Mocks the Prisma surface and the orpc procedure factory so the handler
 * can be invoked directly. Covers the spec-required matrix:
 * - personal context returns the caller's rows (XOR isolation)
 * - org admin gets the org's rows
 * - org non-admin gets `{ limits: [], canManage: false }` (b)
 * - org non-member gets `FORBIDDEN`
 * - cross-tenant rows never leak in either direction
 * - only `archivedAt: null` rows are returned (regression for)
 * - BigInt `maxValue` is serialized as a decimal string in the DTO
 * Per [`testing/test-writing.md`] (AAA, mocks at the boundary) and
 * [`backend/api.md`] (ORPCError codes).
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		findMany: vi.fn(),
		getOrganizationMembership: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		aiUsageLimit: {
			findMany: mocks.findMany,
		},
	},
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.list = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (
			organizationId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => organizationId ?? session.activeOrganizationId ?? undefined,
	};
});

await import("../list");

const baseCreatedAt = new Date("2026-04-01T00:00:00.000Z");

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "limit-1",
		name: "Default daily token limit",
		organizationId: null,
		userId: "user-1",
		providerConfigId: null,
		modelCanonicalName: null,
		taskType: null,
		dimension: "TOKENS",
		window: "DAILY",
		maxValue: BigInt(10_000),
		enforcement: "HARD",
		createdById: "user-1",
		createdAt: baseCreatedAt,
		...overrides,
	};
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const orgCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
});

describe("aiUsageLimits.list — personal context", () => {
	it("returns rows scoped to the caller (userId === ctx.user.id, organizationId === null)", async () => {
		mocks.findMany.mockResolvedValue([makeRow()]);

		const result = await handlers.list({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(mocks.findMany).toHaveBeenCalledTimes(1);
		// XOR check: the where clause must filter by userId AND
		// organizationId: null AND archivedAt: null.
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId: "user-1",
					organizationId: null,
					archivedAt: null,
				},
			}),
		);
		// `getOrganizationMembership` is never called in personal context.
		expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();

		expect(result.canManage).toBe(true);
		expect(result.limits).toHaveLength(1);
		expect(result.limits[0]).toMatchObject({
			id: "limit-1",
			userId: "user-1",
			organizationId: null,
		});
	});

	it("never queries rows belonging to an org the caller is a member of (XOR isolation)", async () => {
		// Personal context. Even if the caller is also a member of org-A,
		// the procedure never widens the where clause beyond `userId =
		// user.id`.
		mocks.findMany.mockResolvedValue([]);

		await handlers.list({
			input: { organizationId: null },
			context: personalCtx,
		});

		const callArgs = mocks.findMany.mock.calls[0]?.[0] as
			| { where: Record<string, unknown> }
			| undefined;
		expect(callArgs?.where.organizationId).toBe(null);
		expect(callArgs?.where.userId).toBe("user-1");
		// No `OR`, no missing `organizationId` — the filter is exclusive.
		expect("OR" in (callArgs?.where ?? {})).toBe(false);
	});

	it("only returns rows with archivedAt: null", async () => {
		mocks.findMany.mockResolvedValue([]);

		await handlers.list({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ archivedAt: null }),
			}),
		);
	});
});

describe("aiUsageLimits.list — org context", () => {
	it("admin: returns the org's rows with organizationId === input.organizationId", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "admin",
			organization: { id: "org-A" },
		});
		mocks.findMany.mockResolvedValue([
			makeRow({
				id: "limit-org-1",
				userId: null,
				organizationId: "org-A",
			}),
		]);

		const result = await handlers.list({
			input: { organizationId: "org-A" },
			context: orgCtx,
		});

		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			"org-A",
			"user-1",
		);
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-A",
					userId: null,
					archivedAt: null,
				},
			}),
		);
		expect(result.canManage).toBe(true);
		expect(result.limits).toHaveLength(1);
		expect(result.limits[0]?.organizationId).toBe("org-A");
		expect(result.limits[0]?.userId).toBeNull();
	});

	it("owner: same as admin — returns rows + canManage true", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "owner",
			organization: { id: "org-A" },
		});
		mocks.findMany.mockResolvedValue([
			makeRow({
				id: "limit-org-1",
				userId: null,
				organizationId: "org-A",
			}),
		]);

		const result = await handlers.list({
			input: { organizationId: "org-A" },
			context: orgCtx,
		});

		expect(result.canManage).toBe(true);
		expect(result.limits).toHaveLength(1);
	});

	it("non-admin member (e.g. role: 'member'): returns { limits: [], canManage: false } and skips the DB read", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "member",
			organization: { id: "org-A" },
		});

		const result = await handlers.list({
			input: { organizationId: "org-A" },
			context: orgCtx,
		});

		expect(result).toEqual({ limits: [], canManage: false });
		// b: the procedure must not even touch the DB for
		// non-admin members — mirrors the page-level guard so the row
		// list cannot leak.
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("non-member of the org: throws FORBIDDEN", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(
			handlers.list({
				input: { organizationId: "org-A" },
				context: orgCtx,
			}),
		).rejects.toThrow(ORPCError);

		expect(mocks.findMany).not.toHaveBeenCalled();
	});
});

describe("aiUsageLimits.list — DTO serialization", () => {
	it("serializes BigInt maxValue as a decimal string and Date createdAt as ISO-8601", async () => {
		mocks.findMany.mockResolvedValue([
			makeRow({ maxValue: BigInt("9007199254740993") }), // > Number.MAX_SAFE_INTEGER
		]);

		const result = await handlers.list({
			input: { organizationId: null },
			context: personalCtx,
		});

		const dto = result.limits[0];
		expect(typeof dto?.maxValue).toBe("string");
		expect(dto?.maxValue).toBe("9007199254740993");
		expect(typeof dto?.createdAt).toBe("string");
		expect(dto?.createdAt).toBe(baseCreatedAt.toISOString());
	});
});
