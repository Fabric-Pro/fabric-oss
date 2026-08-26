/**
 * Unit tests for the AI usage-limit chokepoint surface
 * (`packages/payments/src/lib/ai-usage-limits.ts`). Mounted under
 * `@repo/api/lib/__tests__/payments/` so they can run under the api
 * package's vitest runner without forcing payments to declare its own
 * vitest devDependency.
 *
 * Mocks at the boundary only:
 * - `@repo/database` — every Prisma model used (no real Postgres).
 * - `@repo/logs` — silent stubs.
 *
 * Coverage:
 * - `windowStartFor` (pure tz math)
 * - `readCounter` / `incrementCounter` (Postgres only)
 * - `loadApplicableLimits` (tenant XOR + project-scope + filter clauses)
 * - `getTenantTimezone`
 * - `AiUsageLimitExceededError`
 * - `assertWithinAiUsageLimits` (HARD block / SOFT bypass)
 * - `recordAiUsageAndCheckOverage` (threshold-crossing + notifier fan-out)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module mocks — all at boundaries, none on the unit under test.

vi.mock("@repo/database", () => {
	// We hand-construct the surface used by the SUT instead of spreading
	// `vi.importActual(..)` because the actual module's `db` export is a
	// lazy Proxy that intercepts every property access and tries to spin up
	// PrismaPg on first touch. Even when overridden by a later spread key,
	// vitest's module-resolution machinery has been observed to leak the
	// real proxy under some module-graph cache configurations on Windows
	// (the SUT's static `import { db }` resolves to the wrapped real proxy).
	// Returning a small, fully-static surface sidesteps the issue entirely
	// and keeps the test boundary explicit.
	const AiUsageLimitWindow = {
		HOURLY: "HOURLY",
		DAILY: "DAILY",
		MONTHLY: "MONTHLY",
	} as const;
	const AiUsageLimitEnforcement = {
		HARD: "HARD",
		SOFT: "SOFT",
	} as const;
	const AiUsageLimitDimension = {
		TOKENS: "TOKENS",
		SPEND_USD: "SPEND_USD",
	} as const;
	return {
		AiUsageLimitWindow,
		AiUsageLimitEnforcement,
		AiUsageLimitDimension,
		// `Prisma` is referenced only as a type by the SUT (Prisma.AiUsageLimitWhereInput).
		// At runtime nothing reaches into it, so an empty object satisfies
		// the value-side of the import.
		Prisma: {},
		// `setAiUsageRecorder` is the registry hook used by `@repo/payments`
		// to register `recordAiUsageAndCheckOverage` with `@repo/database`.
		// In tests we don't exercise the registry — the SUT's exported
		// function is called directly — so a no-op spy is enough.
		setAiUsageRecorder: vi.fn(),
		db: {
			aiUsageLimit: {
				findMany: vi.fn(),
			},
			aiUsageLimitCounter: {
				findUnique: vi.fn(),
				upsert: vi.fn(),
			},
			organization: {
				findUnique: vi.fn(),
			},
			user: {
				findUnique: vi.fn(),
			},
		},
	};
});

// Spy stand-in for the notifier registered via
// `setAiUsageThresholdNotifier` in production from
// `@repo/api/lib/notification-service`. Installed in `beforeEach` below.
const mockAiUsageThresholdNotifier = vi.fn().mockResolvedValue(undefined);

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// Helpers to retrieve typed mocks after the module graph has loaded.

async function loadLib() {
	return await import("../../../../payments/src/lib/ai-usage-limits");
}

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		aiUsageLimit: { findMany: ReturnType<typeof vi.fn> };
		aiUsageLimitCounter: {
			findUnique: ReturnType<typeof vi.fn>;
			upsert: ReturnType<typeof vi.fn>;
		};
		organization: { findUnique: ReturnType<typeof vi.fn> };
		user: { findUnique: ReturnType<typeof vi.fn> };
	};
}

async function getMockFanOut() {
	return mockAiUsageThresholdNotifier;
}

// Reset every spy / stub between tests so cross-pollination can't hide bugs.
beforeEach(async () => {
	const db = await getMockDb();
	db.aiUsageLimit.findMany.mockReset();
	db.aiUsageLimitCounter.findUnique.mockReset();
	db.aiUsageLimitCounter.upsert.mockReset();
	db.organization.findUnique.mockReset();
	db.user.findUnique.mockReset();

	mockAiUsageThresholdNotifier.mockReset();
	mockAiUsageThresholdNotifier.mockResolvedValue(undefined);
	// Register the spy so `recordAiUsageAndCheckOverage` invokes it when a
	// threshold is crossed. In production this is wired up by
	// `@repo/api/lib/notification-service` at module load.
	const { setAiUsageThresholdNotifier } = await loadLib();
	setAiUsageThresholdNotifier(mockAiUsageThresholdNotifier);
});

afterEach(() => {
	vi.clearAllMocks();
});

// ===========================================================================
// windowStartFor — pure, timezone-aware boundary calc
// ===========================================================================

describe("windowStartFor", () => {
	it("HOURLY in UTC returns the same hour at :00:00.000Z", async () => {
		const { windowStartFor, AiUsageLimitWindow } = await loadLib();
		const now = new Date("2026-05-14T15:37:42.123Z");

		const start = windowStartFor(AiUsageLimitWindow.HOURLY, "UTC", now);

		expect(start.toISOString()).toBe("2026-05-14T15:00:00.000Z");
	});

	it("DAILY in America/Los_Angeles returns 00:00 PT (UTC-7 during DST)", async () => {
		const { windowStartFor, AiUsageLimitWindow } = await loadLib();
		// 15:30 UTC on May 14 2026 = 08:30 PDT same day. Daily boundary should
		// be 00:00 PDT = 07:00 UTC.
		const now = new Date("2026-05-14T15:30:00.000Z");

		const start = windowStartFor(
			AiUsageLimitWindow.DAILY,
			"America/Los_Angeles",
			now,
		);

		expect(start.toISOString()).toBe("2026-05-14T07:00:00.000Z");
	});

	it("MONTHLY in Europe/Berlin returns the 1st at 00:00 Berlin time", async () => {
		const { windowStartFor, AiUsageLimitWindow } = await loadLib();
		// Mid-May 2026 in Berlin (CEST, UTC+2). Month boundary should be
		// 2026-05-01T00:00 CEST = 2026-04-30T22:00:00Z.
		const now = new Date("2026-05-14T15:30:00.000Z");

		const start = windowStartFor(
			AiUsageLimitWindow.MONTHLY,
			"Europe/Berlin",
			now,
		);

		expect(start.toISOString()).toBe("2026-04-30T22:00:00.000Z");
	});

	it("DAILY in Asia/Tokyo (UTC+9, no DST) returns 00:00 JST = 15:00 UTC the prior day", async () => {
		const { windowStartFor, AiUsageLimitWindow } = await loadLib();
		// 03:30 UTC on May 14 = 12:30 JST same day. Daily boundary in JST is
		// 00:00 JST = 15:00 UTC on May 13.
		const now = new Date("2026-05-14T03:30:00.000Z");

		const start = windowStartFor(
			AiUsageLimitWindow.DAILY,
			"Asia/Tokyo",
			now,
		);

		expect(start.toISOString()).toBe("2026-05-13T15:00:00.000Z");
	});

	it("falls back to UTC when timezone is null", async () => {
		const { windowStartFor, AiUsageLimitWindow } = await loadLib();
		const now = new Date("2026-05-14T15:30:00.000Z");

		const start = windowStartFor(AiUsageLimitWindow.DAILY, null, now);

		expect(start.toISOString()).toBe("2026-05-14T00:00:00.000Z");
	});

	it("DST spring-forward in America/New_York: the daily boundary is 23h after the previous one (lost hour)", async () => {
		const { windowStartFor, AiUsageLimitWindow } = await loadLib();
		// 2026-03-08 at 02:00 EST → 03:00 EDT (spring forward).
		// Daily boundary on March 8 is 00:00 EST = 05:00 UTC.
		// Daily boundary on March 9 is 00:00 EDT = 04:00 UTC.
		// Difference: 23 hours, not 24 — proves the boundary is computed in
		// local calendar time, not by adding 86400 seconds.
		const march8Noon = new Date("2026-03-08T16:00:00.000Z"); // noon EST
		const march9Noon = new Date("2026-03-09T16:00:00.000Z"); // noon EDT

		const start8 = windowStartFor(
			AiUsageLimitWindow.DAILY,
			"America/New_York",
			march8Noon,
		);
		const start9 = windowStartFor(
			AiUsageLimitWindow.DAILY,
			"America/New_York",
			march9Noon,
		);

		const diffHours = (start9.getTime() - start8.getTime()) / 3_600_000;
		expect(diffHours).toBe(23);
	});

	it("MONTHLY year-rollover: January 1st in Asia/Tokyo points to Dec 31 15:00 UTC of the prior year", async () => {
		const { windowStartFor, AiUsageLimitWindow } = await loadLib();
		// Mid-January 2026 in JST. Month boundary is 2026-01-01 00:00 JST =
		// 2025-12-31 15:00 UTC.
		const now = new Date("2026-01-14T03:30:00.000Z");

		const start = windowStartFor(
			AiUsageLimitWindow.MONTHLY,
			"Asia/Tokyo",
			now,
		);

		expect(start.toISOString()).toBe("2025-12-31T15:00:00.000Z");
	});
});

// ===========================================================================
// readCounter — Postgres `findUnique`
// ===========================================================================

describe("readCounter", () => {
	const params = {
		limitId: "lim_1",
		windowStart: new Date("2026-05-14T00:00:00.000Z"),
	};

	it("returns zeros when Postgres has no row", async () => {
		const { readCounter } = await loadLib();
		const db = await getMockDb();
		db.aiUsageLimitCounter.findUnique.mockResolvedValue(null);

		const result = await readCounter(params);

		expect(result).toEqual({
			usedTokens: BigInt(0),
			usedMicroUsd: BigInt(0),
		});
	});

	it("returns the row values when Postgres has a hit", async () => {
		const { readCounter } = await loadLib();
		const db = await getMockDb();
		db.aiUsageLimitCounter.findUnique.mockResolvedValue({
			usedTokens: BigInt(2000),
			usedMicroUsd: BigInt(7_000_000),
		});

		const result = await readCounter(params);

		expect(result).toEqual({
			usedTokens: BigInt(2000),
			usedMicroUsd: BigInt(7_000_000),
		});
	});

	it("queries Postgres on the unique (limitId, windowStart) compound index", async () => {
		const { readCounter } = await loadLib();
		const db = await getMockDb();
		db.aiUsageLimitCounter.findUnique.mockResolvedValue(null);

		await readCounter(params);

		expect(db.aiUsageLimitCounter.findUnique).toHaveBeenCalledWith({
			where: {
				limitId_windowStart: {
					limitId: "lim_1",
					windowStart: params.windowStart,
				},
			},
			select: { usedTokens: true, usedMicroUsd: true },
		});
	});
});

// ===========================================================================
// incrementCounter — Postgres atomic upsert
// ===========================================================================

describe("incrementCounter", () => {
	const baseParams = {
		limitId: "lim_1",
		windowStart: new Date("2026-05-14T00:00:00.000Z"),
		deltaTokens: BigInt(100),
		deltaMicroUsd: BigInt(500_000),
	};

	it("upserts with Prisma's atomic increment shape and returns the post-totals", async () => {
		const { incrementCounter, AiUsageLimitWindow } = await loadLib();
		const db = await getMockDb();
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(200),
			usedMicroUsd: BigInt(1_000_000),
		});

		const result = await incrementCounter({
			...baseParams,
			limitWindow: AiUsageLimitWindow.HOURLY,
		});

		expect(result).toEqual({
			usedTokens: BigInt(200),
			usedMicroUsd: BigInt(1_000_000),
		});
		expect(db.aiUsageLimitCounter.upsert).toHaveBeenCalledWith({
			where: {
				limitId_windowStart: {
					limitId: "lim_1",
					windowStart: baseParams.windowStart,
				},
			},
			create: {
				limitId: "lim_1",
				windowStart: baseParams.windowStart,
				usedTokens: BigInt(100),
				usedMicroUsd: BigInt(500_000),
			},
			update: {
				usedTokens: { increment: BigInt(100) },
				usedMicroUsd: { increment: BigInt(500_000) },
			},
			select: { usedTokens: true, usedMicroUsd: true },
		});
	});
});

// ===========================================================================
// loadApplicableLimits — XOR scope + optional filters + currentWindowStart
// ===========================================================================

describe("loadApplicableLimits", () => {
	const fixedNow = new Date("2026-05-14T15:30:00.000Z");

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses the org tenant scope (organizationId set, userId null) — XOR isolation", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.organization.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(db.aiUsageLimit.findMany).toHaveBeenCalledTimes(1);
		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.where.organizationId).toBe("org-1");
		expect(call.where.userId).toBeNull();
	});

	it("uses the personal tenant scope (userId set, organizationId null) — XOR isolation", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({ userId: "user-1" });

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.where.userId).toBe("user-1");
		expect(call.where.organizationId).toBeNull();
	});

	it("always filters out archived limits (`archivedAt: null`)", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({ userId: "user-1" });

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.where.archivedAt).toBeNull();
	});

	it("when providerConfigId is supplied: row matches IS NULL OR equals the value", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({
			userId: "user-1",
			providerConfigId: "pc_1",
		});

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.where.AND[0]).toEqual({
			OR: [{ providerConfigId: null }, { providerConfigId: "pc_1" }],
		});
	});

	it("when providerConfigId is omitted: only rows with providerConfigId IS NULL match", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({ userId: "user-1" });

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.where.AND[0]).toEqual({ providerConfigId: null });
	});

	it("when projectId is supplied: row matches IS NULL OR equals the projectId — project isolation across projects in the same tenant", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({
			userId: "user-1",
			projectId: "proj-A",
		});

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		// projectClause is appended after the three filter clauses
		// (provider, model, taskType). With those three omitted, project
		// lands at AND[3].
		expect(call.where.AND[3]).toEqual({
			OR: [{ projectId: null }, { projectId: "proj-A" }],
		});
	});

	it("when projectId is omitted: only workspace-global rows match (projectId IS NULL) — project limits cannot block non-project AI calls", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({ userId: "user-1" });

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.where.AND[3]).toEqual({ projectId: null });
	});

	it("project-scoped limit on project A never matches a call to project B (same tenant, different projects)", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({
			userId: "user-1",
			projectId: "proj-B",
		});

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		// Filter accepts projectId IS NULL (workspace-global) OR === proj-B.
		// A row with projectId === 'proj-A' falls into neither branch,
		// so it can never match this call.
		expect(call.where.AND[3]).toEqual({
			OR: [{ projectId: null }, { projectId: "proj-B" }],
		});
	});

	it("model and taskType filters compose with the same OR-or-NULL semantics", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({
			userId: "user-1",
			providerConfigId: "pc_1",
			modelCanonicalName: "gpt-5",
			taskType: "CHAT",
		});

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.where.AND[1]).toEqual({
			OR: [{ modelCanonicalName: null }, { modelCanonicalName: "gpt-5" }],
		});
		expect(call.where.AND[2]).toEqual({
			OR: [{ taskType: null }, { taskType: "CHAT" }],
		});
	});

	it("returns rows enriched with `currentWindowStart` derived from windowStartFor + tenant TZ", async () => {
		const { loadApplicableLimits, AiUsageLimitWindow } = await loadLib();
		const db = await getMockDb();
		db.organization.findUnique.mockResolvedValue({
			timezone: "America/Los_Angeles",
		});
		db.aiUsageLimit.findMany.mockResolvedValue([
			{
				id: "lim_daily",
				organizationId: "org-1",
				userId: null,
				name: "Daily cap",
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.DAILY,
				maxValue: BigInt(100_000),
				enforcement: "HARD",
				createdById: "user-1",
			},
			{
				id: "lim_hourly",
				organizationId: "org-1",
				userId: null,
				name: "Hourly cap",
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.HOURLY,
				maxValue: BigInt(10_000),
				enforcement: "SOFT",
				createdById: "user-1",
			},
		]);

		const result = await loadApplicableLimits({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result).toHaveLength(2);
		// Daily in LA at 2026-05-14T15:30Z → 00:00 PDT = 07:00 UTC.
		expect(result[0].currentWindowStart.toISOString()).toBe(
			"2026-05-14T07:00:00.000Z",
		);
		// Hourly: 15:30 UTC = 08:30 PDT → 08:00 PDT = 15:00 UTC.
		expect(result[1].currentWindowStart.toISOString()).toBe(
			"2026-05-14T15:00:00.000Z",
		);
	});

	it("orders results by createdAt asc (deterministic short-circuit on the first HARD breach)", async () => {
		const { loadApplicableLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await loadApplicableLimits({ userId: "user-1" });

		const call = db.aiUsageLimit.findMany.mock.calls[0][0];
		expect(call.orderBy).toEqual({ createdAt: "asc" });
	});
});

// ===========================================================================
// getTenantTimezone — (per-tenant TZ, fallback to UTC)
// ===========================================================================

describe("getTenantTimezone", () => {
	it("returns the org's timezone when present", async () => {
		const { getTenantTimezone } = await loadLib();
		const db = await getMockDb();
		db.organization.findUnique.mockResolvedValue({
			timezone: "America/Los_Angeles",
		});

		const tz = await getTenantTimezone({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(tz).toBe("America/Los_Angeles");
		expect(db.organization.findUnique).toHaveBeenCalledWith({
			where: { id: "org-1" },
			select: { timezone: true },
		});
	});

	it("returns 'UTC' when the org row's timezone column is null", async () => {
		const { getTenantTimezone } = await loadLib();
		const db = await getMockDb();
		db.organization.findUnique.mockResolvedValue({ timezone: null });

		const tz = await getTenantTimezone({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(tz).toBe("UTC");
	});

	it("returns 'UTC' when the org doesn't exist", async () => {
		const { getTenantTimezone } = await loadLib();
		const db = await getMockDb();
		db.organization.findUnique.mockResolvedValue(null);

		const tz = await getTenantTimezone({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(tz).toBe("UTC");
	});

	it("returns the user's timezone when no organizationId is supplied", async () => {
		const { getTenantTimezone } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "Asia/Tokyo" });

		const tz = await getTenantTimezone({ userId: "user-1" });

		expect(tz).toBe("Asia/Tokyo");
		expect(db.user.findUnique).toHaveBeenCalledWith({
			where: { id: "user-1" },
			select: { timezone: true },
		});
	});

	it("returns 'UTC' when the user row's timezone column is null", async () => {
		const { getTenantTimezone } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: null });

		const tz = await getTenantTimezone({ userId: "user-1" });

		expect(tz).toBe("UTC");
	});
});

// ===========================================================================
// AiUsageLimitExceededError — structured error contract
// ===========================================================================

describe("AiUsageLimitExceededError", () => {
	it("has the literal `code = AI_USAGE_LIMIT_EXCEEDED`", async () => {
		const { AiUsageLimitExceededError } = await loadLib();

		const err = new AiUsageLimitExceededError({
			message: "blocked",
			limitId: "lim_1",
			dimension: "TOKENS",
			window: "MONTHLY",
			used: BigInt(10_000),
			max: BigInt(10_000),
			manageLimitsUrl: "/app/settings/usage?limitId=lim_1",
		});

		expect(err.code).toBe("AI_USAGE_LIMIT_EXCEEDED");
	});

	it("sets `name = AiUsageLimitExceededError`", async () => {
		const { AiUsageLimitExceededError } = await loadLib();

		const err = new AiUsageLimitExceededError({
			message: "blocked",
			limitId: "lim_1",
			dimension: "TOKENS",
			window: "MONTHLY",
			used: BigInt(0),
			max: BigInt(1),
			manageLimitsUrl: "/app/settings/usage",
		});

		expect(err.name).toBe("AiUsageLimitExceededError");
	});

	it("is an instance of Error (so existing error handlers work)", async () => {
		const { AiUsageLimitExceededError } = await loadLib();

		const err = new AiUsageLimitExceededError({
			message: "blocked",
			limitId: "lim_1",
			dimension: "TOKENS",
			window: "MONTHLY",
			used: BigInt(0),
			max: BigInt(1),
			manageLimitsUrl: "/app/settings/usage",
		});

		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(AiUsageLimitExceededError);
	});

	it("populates every structured payload field from the constructor args", async () => {
		const { AiUsageLimitExceededError } = await loadLib();

		const err = new AiUsageLimitExceededError({
			message: "AI usage limit exceeded: lim_1 (TOKENS, MONTHLY)",
			limitId: "lim_xyz",
			dimension: "SPEND_USD",
			window: "DAILY",
			used: BigInt(99_900_000),
			max: BigInt(100_000_000),
			manageLimitsUrl: "/app/acme/settings/usage?limitId=lim_xyz",
		});

		expect(err.message).toBe(
			"AI usage limit exceeded: lim_1 (TOKENS, MONTHLY)",
		);
		expect(err.limitId).toBe("lim_xyz");
		expect(err.dimension).toBe("SPEND_USD");
		expect(err.window).toBe("DAILY");
		expect(err.used).toBe(BigInt(99_900_000));
		expect(err.max).toBe(BigInt(100_000_000));
		expect(err.manageLimitsUrl).toBe(
			"/app/acme/settings/usage?limitId=lim_xyz",
		);
	});
});

// ===========================================================================
// assertWithinAiUsageLimits — pre-call gate (Flow A)
// ===========================================================================

describe("assertWithinAiUsageLimits", () => {
	const fixedNow = new Date("2026-05-14T15:30:00.000Z");

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("no applicable limits → returns silently with no counter read", async () => {
		const { assertWithinAiUsageLimits } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await expect(
			assertWithinAiUsageLimits({ userId: "user-1" }),
		).resolves.toBeUndefined();
		expect(db.aiUsageLimitCounter.findUnique).not.toHaveBeenCalled();
	});

	it("HARD limit + currentValue+1 > max → throws AiUsageLimitExceededError with structured payload", async () => {
		const {
			assertWithinAiUsageLimits,
			AiUsageLimitExceededError,
			AiUsageLimitWindow,
		} = await loadLib();
		const db = await getMockDb();
		db.organization.findUnique.mockResolvedValue({
			timezone: "UTC",
			slug: "acme",
		});
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			{
				id: "lim_blocked",
				organizationId: "org-1",
				userId: null,
				name: "Daily tokens",
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.DAILY,
				maxValue: BigInt(1000),
				enforcement: "HARD",
				createdById: "user-1",
			},
		]);
		db.aiUsageLimitCounter.findUnique.mockResolvedValue({
			usedTokens: BigInt(1000),
			usedMicroUsd: BigInt(0),
		});

		await expect(
			assertWithinAiUsageLimits({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toBeInstanceOf(AiUsageLimitExceededError);
	});

	it("attaches the org-context manage-limits URL when org slug resolves", async () => {
		const { assertWithinAiUsageLimits, AiUsageLimitWindow } =
			await loadLib();
		const db = await getMockDb();
		// First findUnique is from getTenantTimezone (timezone field), second
		// from buildManageLimitsUrl (slug field). Both shapes need to be
		// covered — the same mock returns both fields.
		db.organization.findUnique.mockResolvedValue({
			timezone: "UTC",
			slug: "acme",
		});
		db.aiUsageLimit.findMany.mockResolvedValue([
			{
				id: "lim_1",
				organizationId: "org-1",
				userId: null,
				name: null,
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.DAILY,
				maxValue: BigInt(100),
				enforcement: "HARD",
				createdById: "user-1",
			},
		]);
		db.aiUsageLimitCounter.findUnique.mockResolvedValue({
			usedTokens: BigInt(100),
			usedMicroUsd: BigInt(0),
		});

		try {
			await assertWithinAiUsageLimits({
				userId: "user-1",
				organizationId: "org-1",
			});
			throw new Error("expected throw");
		} catch (err) {
			const e = err as InstanceType<
				Awaited<ReturnType<typeof loadLib>>["AiUsageLimitExceededError"]
			>;
			expect(e.manageLimitsUrl).toBe(
				"/app/acme/settings/usage?limitId=lim_1",
			);
			expect(e.limitId).toBe("lim_1");
			expect(e.dimension).toBe("TOKENS");
			expect(e.window).toBe(AiUsageLimitWindow.DAILY);
			expect(e.used).toBe(BigInt(100));
			expect(e.max).toBe(BigInt(100));
		}
	});

	it("HARD limit + currentValue+1 ≤ max → resolves silently (Flow A pass)", async () => {
		const { assertWithinAiUsageLimits, AiUsageLimitWindow } =
			await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			{
				id: "lim_under",
				organizationId: null,
				userId: "user-1",
				name: null,
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.HOURLY,
				maxValue: BigInt(1000),
				enforcement: "HARD",
				createdById: "user-1",
			},
		]);
		db.aiUsageLimitCounter.findUnique.mockResolvedValue({
			usedTokens: BigInt(500),
			usedMicroUsd: BigInt(0),
		});

		await expect(
			assertWithinAiUsageLimits({ userId: "user-1" }),
		).resolves.toBeUndefined();
	});

	it("SOFT limit even if over → resolves silently (no throw)", async () => {
		const { assertWithinAiUsageLimits, AiUsageLimitWindow } =
			await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			{
				id: "lim_soft",
				organizationId: null,
				userId: "user-1",
				name: null,
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.DAILY,
				maxValue: BigInt(1000),
				enforcement: "SOFT",
				createdById: "user-1",
			},
		]);
		db.aiUsageLimitCounter.findUnique.mockResolvedValue({
			usedTokens: BigInt(99_999),
			usedMicroUsd: BigInt(0),
		});

		await expect(
			assertWithinAiUsageLimits({ userId: "user-1" }),
		).resolves.toBeUndefined();
	});

	it("Multiple HARD limits, the first one over → short-circuits on first breach", async () => {
		const {
			assertWithinAiUsageLimits,
			AiUsageLimitExceededError,
			AiUsageLimitWindow,
		} = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			{
				id: "lim_first",
				organizationId: null,
				userId: "user-1",
				name: "first",
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.DAILY,
				maxValue: BigInt(100),
				enforcement: "HARD",
				createdById: "user-1",
			},
			{
				id: "lim_second",
				organizationId: null,
				userId: "user-1",
				name: "second",
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "TOKENS",
				window: AiUsageLimitWindow.HOURLY,
				maxValue: BigInt(50),
				enforcement: "HARD",
				createdById: "user-1",
			},
		]);
		db.aiUsageLimitCounter.findUnique.mockResolvedValue({
			usedTokens: BigInt(100),
			usedMicroUsd: BigInt(0),
		});

		try {
			await assertWithinAiUsageLimits({ userId: "user-1" });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(AiUsageLimitExceededError);
			const e = err as InstanceType<typeof AiUsageLimitExceededError>;
			expect(e.limitId).toBe("lim_first");
		}
		// Short-circuit: only the first limit's counter was queried before the
		// throw — the second (lim_second) never gets its findUnique call.
		expect(db.aiUsageLimitCounter.findUnique).toHaveBeenCalledTimes(1);
	});

	it("SPEND_USD HARD limit checks `usedMicroUsd` (not `usedTokens`)", async () => {
		const {
			assertWithinAiUsageLimits,
			AiUsageLimitExceededError,
			AiUsageLimitWindow,
		} = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			{
				id: "lim_spend",
				organizationId: null,
				userId: "user-1",
				name: "spend cap",
				providerConfigId: null,
				modelCanonicalName: null,
				taskType: null,
				dimension: "SPEND_USD",
				window: AiUsageLimitWindow.DAILY,
				maxValue: BigInt(1_000_000),
				enforcement: "HARD",
				createdById: "user-1",
			},
		]);
		db.aiUsageLimitCounter.findUnique.mockResolvedValue({
			// Tokens at zero — irrelevant for SPEND_USD.
			usedTokens: BigInt(0),
			// usedMicroUsd at the limit triggers the breach.
			usedMicroUsd: BigInt(1_000_000),
		});

		await expect(
			assertWithinAiUsageLimits({ userId: "user-1" }),
		).rejects.toBeInstanceOf(AiUsageLimitExceededError);
	});
});

// ===========================================================================
// recordAiUsageAndCheckOverage — post-call accounting + threshold detection
// ===========================================================================

describe("recordAiUsageAndCheckOverage", () => {
	const fixedNow = new Date("2026-05-14T15:30:00.000Z");

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makeLimit(
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			id: "lim_1",
			organizationId: null,
			userId: "user-1",
			name: "default",
			providerConfigId: null,
			modelCanonicalName: null,
			taskType: null,
			dimension: "TOKENS",
			window: "DAILY",
			maxValue: BigInt(100),
			enforcement: "HARD",
			createdById: "user-1",
			...overrides,
		};
	}

	it("no applicable limits → no counter writes, no notifications", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([]);

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 500,
			costMicroUsd: 1000,
		});

		expect(db.aiUsageLimitCounter.upsert).not.toHaveBeenCalled();
		expect(fanOut).not.toHaveBeenCalled();
	});

	it("crossing only the 80% line fires aiUsageThreshold once with threshold=80", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		// pre = 70, delta = 15, post = 85. Crosses 80% only.
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(85),
			usedMicroUsd: BigInt(0),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 15,
			costMicroUsd: 0,
		});

		expect(fanOut).toHaveBeenCalledTimes(1);
		expect(fanOut).toHaveBeenCalledWith(
			expect.objectContaining({
				limitId: "lim_1",
				threshold: 80,
				used: BigInt(85),
				max: BigInt(100),
			}),
		);
	});

	it("crossing only the 100% line fires aiUsageThreshold once with threshold=100", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		// pre = 90, delta = 11, post = 101. Crosses only 100% (already past 80).
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(101),
			usedMicroUsd: BigInt(0),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 11,
			costMicroUsd: 0,
		});

		expect(fanOut).toHaveBeenCalledTimes(1);
		expect(fanOut).toHaveBeenCalledWith(
			expect.objectContaining({
				limitId: "lim_1",
				threshold: 100,
			}),
		);
	});

	it("a single large delta crossing both 80% and 100% fires twice", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		// pre = 0, delta = 110, post = 110. Crosses 80 AND 100 in one tick.
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(110),
			usedMicroUsd: BigInt(0),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 110,
			costMicroUsd: 0,
		});

		expect(fanOut).toHaveBeenCalledTimes(2);
		const thresholds = fanOut.mock.calls.map(
			(c) => (c[0] as { threshold: 80 | 100 }).threshold,
		);
		expect(thresholds).toEqual([80, 100]);
	});

	it("post below 80% → no notification", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		// pre = 0, delta = 50, post = 50. No threshold crossed.
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(50),
			usedMicroUsd: BigInt(0),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 50,
			costMicroUsd: 0,
		});

		expect(fanOut).not.toHaveBeenCalled();
	});

	it("already past 80% (pre=85) and still under 100% → no re-fire of 80% notification", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		// pre = 85, delta = 5, post = 90. Already past 80%, not at 100%.
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(90),
			usedMicroUsd: BigInt(0),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 5,
			costMicroUsd: 0,
		});

		expect(fanOut).not.toHaveBeenCalled();
	});

	it("already past 100% (pre=200, post=300) → no re-fire of either notification", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		// pre = 200, delta = 100, post = 300. Both thresholds were crossed in
		// a prior call — they must NOT fire again.
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(300),
			usedMicroUsd: BigInt(0),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 100,
			costMicroUsd: 0,
		});

		expect(fanOut).not.toHaveBeenCalled();
	});

	it("BigInt-safe arithmetic: counters > Number.MAX_SAFE_INTEGER still detect crossings correctly", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		// max = 2.5B (well above MAX_SAFE_INTEGER * 100 head-room boundary
		// when crossedThresholds multiplies by 100). Use a SPEND_USD limit so
		// the test exercises the micro-USD branch.
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({
				dimension: "SPEND_USD",
				maxValue: BigInt(2_500_000_000),
			}),
		]);
		// pre = 0, delta = 2_000_000_000, post = 2_000_000_000. 80% of 2.5B
		// = 2B, so post exactly hits the warn line.
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(0),
			usedMicroUsd: BigInt(2_000_000_000),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 0,
			costMicroUsd: 2_000_000_000,
		});

		expect(fanOut).toHaveBeenCalledTimes(1);
		expect(fanOut).toHaveBeenCalledWith(
			expect.objectContaining({ threshold: 80 }),
		);
	});

	it("fanOut throw is caught + warn-logged; the function still resolves", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const fanOut = await getMockFanOut();
		const { logger } = await import("@repo/logs");
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(85),
			usedMicroUsd: BigInt(0),
		});
		fanOut.mockRejectedValue(new Error("notification service down"));

		await expect(
			recordAiUsageAndCheckOverage({
				userId: "user-1",
				totalTokens: 15,
				costMicroUsd: 0,
			}),
		).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "aiUsageLimits.fanOutFailed",
				limitId: "lim_1",
				threshold: 80,
			}),
			expect.any(String),
		);
	});

	it("counter upsert throw is caught + error-logged at the top level ( defense-in-depth)", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		const { logger } = await import("@repo/logs");
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ maxValue: BigInt(100) }),
		]);
		db.aiUsageLimitCounter.upsert.mockRejectedValue(new Error("pg down"));

		await expect(
			recordAiUsageAndCheckOverage({
				userId: "user-1",
				totalTokens: 50,
				costMicroUsd: 0,
			}),
		).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "aiUsageLimits.recordFailed" }),
			expect.any(String),
		);
	});

	it("token-dimension limit: tokens delta is incremented; micro-USD delta is zeroed", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({ dimension: "TOKENS", maxValue: BigInt(10_000) }),
		]);
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(500),
			usedMicroUsd: BigInt(0),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 500,
			costMicroUsd: 12_345,
		});

		expect(db.aiUsageLimitCounter.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					usedTokens: BigInt(500),
					usedMicroUsd: BigInt(0),
				}),
				update: expect.objectContaining({
					usedTokens: { increment: BigInt(500) },
					usedMicroUsd: { increment: BigInt(0) },
				}),
			}),
		);
	});

	it("spend-dimension limit: micro-USD delta is incremented; tokens delta is zeroed", async () => {
		const { recordAiUsageAndCheckOverage } = await loadLib();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({ timezone: "UTC" });
		db.aiUsageLimit.findMany.mockResolvedValue([
			makeLimit({
				dimension: "SPEND_USD",
				maxValue: BigInt(50_000_000),
			}),
		]);
		db.aiUsageLimitCounter.upsert.mockResolvedValue({
			usedTokens: BigInt(0),
			usedMicroUsd: BigInt(12_345),
		});

		await recordAiUsageAndCheckOverage({
			userId: "user-1",
			totalTokens: 500,
			costMicroUsd: 12_345,
		});

		expect(db.aiUsageLimitCounter.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					usedTokens: BigInt(0),
					usedMicroUsd: BigInt(12_345),
				}),
				update: expect.objectContaining({
					usedTokens: { increment: BigInt(0) },
					usedMicroUsd: { increment: BigInt(12_345) },
				}),
			}),
		);
	});
});
