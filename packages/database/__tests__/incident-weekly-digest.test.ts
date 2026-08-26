/**
 * Tests for the SEV-3 weekly digest helper.
 *
 * Coverage:
 *   - Summary aggregates both error-rate + integration incidents within the
 *     [weekEnd - 7d, weekEnd) window.
 *   - Dispatch is a no-op when the week has no incidents.
 *   - Dispatch fans out one row per admin with a deterministic dedupe key.
 *   - Dedupe collisions (P2002) are counted as not-written rather than
 *     surfaced as an error.
 *
 * Run with: pnpm --filter @repo/database test __tests__/incident-weekly-digest.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const errorRateFindManyMock = vi.fn();
const integrationFindManyMock = vi.fn();
const userFindManyMock = vi.fn();
const notificationCreateMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		errorRateIncident: {
			findMany: (args: unknown) => errorRateFindManyMock(args),
		},
		integrationIncident: {
			findMany: (args: unknown) => integrationFindManyMock(args),
		},
		user: {
			findMany: (args: unknown) => userFindManyMock(args),
		},
		notification: {
			create: (args: unknown) => notificationCreateMock(args),
		},
	},
	Prisma: {},
}));

import {
	dispatchWeeklyIncidentDigest,
	summarizeWeeklyIncidents,
} from "../prisma/queries/incident-weekly-digest";

function makeP2002(): Error & { code: string } {
	const err = new Error("unique violation") as Error & { code: string };
	err.code = "P2002";
	return err;
}

const WEEK_END = new Date("2026-05-18T09:00:00.000Z"); // Monday 09:00 UTC

beforeEach(() => {
	errorRateFindManyMock.mockReset();
	integrationFindManyMock.mockReset();
	userFindManyMock.mockReset();
	notificationCreateMock.mockReset();
	errorRateFindManyMock.mockResolvedValue([]);
	integrationFindManyMock.mockResolvedValue([]);
	userFindManyMock.mockResolvedValue([]);
	notificationCreateMock.mockResolvedValue({ id: "n-stub" });
});

describe("summarizeWeeklyIncidents", () => {
	it("counts incidents from both tables and groups error-rate by service+feature", async () => {
		errorRateFindManyMock.mockResolvedValue([
			{ severity: "SEV3", service: "api", feature: "ai_generation" },
			{ severity: "SEV3", service: "api", feature: "ai_generation" },
			{ severity: "SEV2", service: "api", feature: "pm_sync" },
		]);
		integrationFindManyMock.mockResolvedValue([
			{ severity: "SEV3", providerKey: "notion" },
		]);

		const summary = await summarizeWeeklyIncidents(WEEK_END);

		expect(summary.totalIncidents).toBe(4);
		expect(summary.bySeverity).toEqual({ sev1: 0, sev2: 1, sev3: 3 });
		expect(summary.topServicesByFeature[0]).toMatchObject({
			service: "api",
			feature: "ai_generation",
			count: 2,
		});
		// Week window: 7 days back from weekEnd.
		expect(summary.weekStart.toISOString()).toBe(
			"2026-05-11T09:00:00.000Z",
		);
	});
});

describe("dispatchWeeklyIncidentDigest", () => {
	it("skips when the week has no incidents", async () => {
		const result = await dispatchWeeklyIncidentDigest(WEEK_END);

		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("no-incidents-this-week");
		expect(result.adminsNotified).toBe(0);
		expect(notificationCreateMock).not.toHaveBeenCalled();
	});

	it("skips when no admins are configured", async () => {
		errorRateFindManyMock.mockResolvedValue([
			{ severity: "SEV3", service: "api", feature: "x" },
		]);

		const result = await dispatchWeeklyIncidentDigest(WEEK_END);

		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("no-admins-configured");
		expect(result.adminsNotified).toBe(0);
	});

	it("fans out one row per admin with a deterministic dedupe key", async () => {
		errorRateFindManyMock.mockResolvedValue([
			{ severity: "SEV3", service: "api", feature: "ai_generation" },
		]);
		userFindManyMock.mockResolvedValue([
			{ id: "admin-1" },
			{ id: "admin-2" },
		]);

		const result = await dispatchWeeklyIncidentDigest(WEEK_END);

		expect(result.adminsNotified).toBe(2);
		expect(notificationCreateMock).toHaveBeenCalledTimes(2);
		const calls = notificationCreateMock.mock.calls.map(
			(c) => (c[0] as { data: Record<string, unknown> }).data,
		);
		expect(calls[0]?.dedupeKey).toBe("weekly-digest:2026-05-18:admin-1");
		expect(calls[1]?.dedupeKey).toBe("weekly-digest:2026-05-18:admin-2");
		// All rows are system-scoped: organizationId null, type SYSTEM_INCIDENT.
		for (const data of calls) {
			expect(data.organizationId).toBeNull();
			expect(data.type).toBe("SYSTEM_INCIDENT");
			expect(data.category).toBe("SYSTEM");
		}
	});

	it("counts P2002 collisions as not-written without throwing", async () => {
		errorRateFindManyMock.mockResolvedValue([
			{ severity: "SEV3", service: "api", feature: "ai_generation" },
		]);
		userFindManyMock.mockResolvedValue([
			{ id: "admin-1" },
			{ id: "admin-2" },
		]);
		notificationCreateMock
			.mockResolvedValueOnce({ id: "n-1" })
			.mockRejectedValueOnce(makeP2002());

		const result = await dispatchWeeklyIncidentDigest(WEEK_END);

		expect(result.adminsNotified).toBe(1);
		expect(result.skipped).toBe(false);
	});
});
