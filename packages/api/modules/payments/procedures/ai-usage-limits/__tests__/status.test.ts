/**
 * Unit tests for `aiUsageLimits.status` procedure.
 * Mocks the Prisma surface and the `@repo/payments` helpers
 * (`readCounter`, `getTenantTimezone`, `windowStartFor`) so the handler
 * can be invoked directly. Covers:
 * - one status entry per active limit, with `currentValue` populated
 * from the readCounter result for the appropriate dimension
 * - empty `statuses` when there are no active rows
 * - org admin gate: non-admin members get `{ statuses: [] }`,
 * non-members get `FORBIDDEN`
 * - `percent` is BigInt-safe and capped at 999 (mid-window-lower)
 * - missing counter (Redis miss + Postgres miss) → `currentValue = "0"`
 * - `windowStart`/`windowEnd`/`timezone` reflect the tenant TZ correctly
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
		readCounter: vi.fn(),
		getTenantTimezone: vi.fn(),
		windowStartFor: vi.fn(),
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

vi.mock("@repo/payments", () => ({
	readCounter: mocks.readCounter,
	getTenantTimezone: mocks.getTenantTimezone,
	windowStartFor: mocks.windowStartFor,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.status = fn;
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

await import("../status");

const baseCreatedAt = new Date("2026-04-01T00:00:00.000Z");
// Pick a windowStart deterministically so the assertions don't depend on
// real time (the helpers are mocked so this is the value the handler sees).
const fixedWindowStart = new Date("2026-05-01T00:00:00.000Z");

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "limit-1",
		name: "Default monthly token limit",
		organizationId: null,
		userId: "user-1",
		providerConfigId: null,
		modelCanonicalName: null,
		taskType: null,
		dimension: "TOKENS",
		window: "MONTHLY",
		maxValue: BigInt(1000),
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
	mocks.getTenantTimezone.mockResolvedValue("UTC");
	mocks.windowStartFor.mockReturnValue(fixedWindowStart);
});

describe("aiUsageLimits.status — empty / read shape", () => {
	it("returns { statuses: [] } when the tenant has no active limits", async () => {
		mocks.findMany.mockResolvedValue([]);

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(result).toEqual({ statuses: [] });
		// readCounter must NOT be called when there are no rows — the
		// procedure short-circuits early.
		expect(mocks.readCounter).not.toHaveBeenCalled();
	});

	it("returns one status per active limit with the correct windowStart/windowEnd/timezone", async () => {
		mocks.findMany.mockResolvedValue([makeRow()]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(250),
			usedMicroUsd: BigInt(0),
		});

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(result.statuses).toHaveLength(1);
		const status = result.statuses[0];
		expect(status?.windowStart).toBe(fixedWindowStart.toISOString());
		expect(status?.timezone).toBe("UTC");
		// windowEnd must be after windowStart (MONTHLY window).
		expect(new Date(status?.windowEnd as string).getTime()).toBeGreaterThan(
			fixedWindowStart.getTime(),
		);
		// `windowStartFor` was invoked with the tenant TZ pulled from
		// `getTenantTimezone` (/).
		expect(mocks.windowStartFor).toHaveBeenCalledWith(
			"MONTHLY",
			"UTC",
			expect.any(Date),
		);
	});

	it("uses usedTokens for TOKENS dimension and usedMicroUsd for SPEND_USD", async () => {
		mocks.findMany.mockResolvedValue([
			makeRow({ id: "limit-tok", dimension: "TOKENS" }),
			makeRow({
				id: "limit-spend",
				dimension: "SPEND_USD",
				maxValue: BigInt(100_000_000), // $100 in micro-USD
			}),
		]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(123),
			usedMicroUsd: BigInt(456),
		});

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		const tokenStatus = result.statuses.find(
			(s: { limit: { id: string } }) => s.limit.id === "limit-tok",
		);
		const spendStatus = result.statuses.find(
			(s: { limit: { id: string } }) => s.limit.id === "limit-spend",
		);
		expect(tokenStatus?.currentValue).toBe("123");
		expect(spendStatus?.currentValue).toBe("456");
	});
});

describe("aiUsageLimits.status — org admin gate", () => {
	it("admin: returns statuses normally", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "admin",
			organization: { id: "org-A" },
		});
		mocks.findMany.mockResolvedValue([
			makeRow({ id: "limit-org", organizationId: "org-A", userId: null }),
		]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(50),
			usedMicroUsd: BigInt(0),
		});

		const result = await handlers.status({
			input: { organizationId: "org-A" },
			context: orgCtx,
		});

		expect(result.statuses).toHaveLength(1);
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: "org-A",
					userId: null,
					archivedAt: null,
				}),
			}),
		);
	});

	it("non-admin member: returns { statuses: [] } and does not query the DB", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "member",
			organization: { id: "org-A" },
		});

		const result = await handlers.status({
			input: { organizationId: "org-A" },
			context: orgCtx,
		});

		expect(result).toEqual({ statuses: [] });
		expect(mocks.findMany).not.toHaveBeenCalled();
		expect(mocks.readCounter).not.toHaveBeenCalled();
	});

	it("non-member: throws FORBIDDEN", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(
			handlers.status({
				input: { organizationId: "org-A" },
				context: orgCtx,
			}),
		).rejects.toThrow(ORPCError);

		expect(mocks.findMany).not.toHaveBeenCalled();
	});
});

describe("aiUsageLimits.status — percent computation", () => {
	it("computes percent correctly for a typical value (250/1000 → 25)", async () => {
		mocks.findMany.mockResolvedValue([makeRow({ maxValue: BigInt(1000) })]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(250),
			usedMicroUsd: BigInt(0),
		});

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(result.statuses[0]?.percent).toBe(25);
	});

	it("returns currentValue '0' on a Redis+Postgres miss", async () => {
		mocks.findMany.mockResolvedValue([makeRow()]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(0),
			usedMicroUsd: BigInt(0),
		});

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(result.statuses[0]?.currentValue).toBe("0");
		expect(result.statuses[0]?.percent).toBe(0);
	});

	it("over-limit (used > max): percent reflects the overage (105% → 105)", async () => {
		mocks.findMany.mockResolvedValue([makeRow({ maxValue: BigInt(100) })]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(105),
			usedMicroUsd: BigInt(0),
		});

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(result.statuses[0]?.percent).toBe(105);
	});

	it("clamps runaway percent at 999 ", async () => {
		mocks.findMany.mockResolvedValue([makeRow({ maxValue: BigInt(10) })]);
		// 1_000_000 / 10 = 100_000% — must be clamped to 999.
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(1_000_000),
			usedMicroUsd: BigInt(0),
		});

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(result.statuses[0]?.percent).toBe(999);
	});

	it("returns percent 0 when maxValue is 0 (defensive — partial-unique index disallows it but the DTO must not divide by zero)", async () => {
		mocks.findMany.mockResolvedValue([makeRow({ maxValue: BigInt(0) })]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(50),
			usedMicroUsd: BigInt(0),
		});

		const result = await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(result.statuses[0]?.percent).toBe(0);
	});
});

describe("aiUsageLimits.status — readCounter wiring", () => {
	it("calls readCounter once per row with the row's id and the computed windowStart", async () => {
		mocks.findMany.mockResolvedValue([
			makeRow({ id: "limit-1" }),
			makeRow({ id: "limit-2" }),
		]);
		mocks.readCounter.mockResolvedValue({
			usedTokens: BigInt(0),
			usedMicroUsd: BigInt(0),
		});

		await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(mocks.readCounter).toHaveBeenCalledTimes(2);
		expect(mocks.readCounter).toHaveBeenCalledWith({
			limitId: "limit-1",
			windowStart: fixedWindowStart,
		});
		expect(mocks.readCounter).toHaveBeenCalledWith({
			limitId: "limit-2",
			windowStart: fixedWindowStart,
		});
	});

	it("getTenantTimezone receives the correct scope (organizationId for org context)", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "admin",
			organization: { id: "org-A" },
		});
		mocks.findMany.mockResolvedValue([]);

		await handlers.status({
			input: { organizationId: "org-A" },
			context: orgCtx,
		});

		expect(mocks.getTenantTimezone).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-A",
		});
	});

	it("getTenantTimezone receives organizationId: null for personal context", async () => {
		mocks.findMany.mockResolvedValue([]);

		await handlers.status({
			input: { organizationId: null },
			context: personalCtx,
		});

		expect(mocks.getTenantTimezone).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: null,
		});
	});
});
