/**
 * Unit tests for the per-context Temporal Schedule helpers
 * (`packages/temporal/src/schedules/url-source-schedule.ts`).
 *
 * `ScheduleClient` is a thin shape — we mock its `create` + `getHandle.delete`
 * methods directly so we never reach the Temporal SDK in test runs.
 *
 * Covers:
 *   - `createUrlSourceSchedule` produces the right cron + scheduleId for
 *     each cadence (DAILY/WEEKLY/MONTHLY).
 *   - `updateUrlSourceSchedule` transitions:
 *       scheduled → scheduled  : delete + create (action "updated")
 *       scheduled → ONCE/LIVE  : delete (action "deleted")
 *       ONCE/LIVE → scheduled  : create (action "created")
 *       same scheduled         : no-op
 *       ONCE ↔ LIVE            : no-op
 *   - `deleteUrlSourceSchedule` swallows "not found".
 *   - Switching INTO scheduled without `apiKey` throws
 *     `MissingFirecrawlKeyError`.
 */

import type { ScheduleClient } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import {
	buildUrlSourceScheduleId,
	cadenceNextFireUtc,
	createUrlSourceSchedule,
	cronForRefreshMode,
	deleteUrlSourceSchedule,
	MissingFirecrawlKeyError,
	parseContextIdFromScheduleId,
	updateUrlSourceSchedule,
} from "../../src/schedules/url-source-schedule";

function makeFakeClient() {
	const create = vi.fn().mockResolvedValue(undefined);
	const handleDelete = vi.fn().mockResolvedValue(undefined);
	const getHandle = vi.fn().mockReturnValue({ delete: handleDelete });
	const list = vi.fn();

	return {
		client: { create, getHandle, list } as unknown as ScheduleClient,
		create,
		handleDelete,
		getHandle,
	};
}

const baseArgs = {
	contextId: "ctx-1",
	url: "https://example.com/hc/en-us",
	scope: "PATH_PREFIX" as const,
	maxPages: 100,
	projectId: "proj-1",
	userId: "user-1",
	organizationId: null,
	apiKey: "fc-decrypted-key",
	parentSourceTitle: "Help Center",
};

describe("cronForRefreshMode", () => {
	it("maps DAILY to once-per-day midnight cron", () => {
		expect(cronForRefreshMode("DAILY")).toBe("0 0 * * *");
	});
	it("maps WEEKLY to Sunday midnight cron", () => {
		expect(cronForRefreshMode("WEEKLY")).toBe("0 0 * * 0");
	});
	it("maps MONTHLY to 1st-of-month midnight cron", () => {
		expect(cronForRefreshMode("MONTHLY")).toBe("0 0 1 * *");
	});
	it("returns null for ONCE / LIVE / null", () => {
		expect(cronForRefreshMode("ONCE")).toBeNull();
		expect(cronForRefreshMode("LIVE")).toBeNull();
		expect(cronForRefreshMode(null)).toBeNull();
		expect(cronForRefreshMode(undefined)).toBeNull();
	});
});

describe("cadenceNextFireUtc", () => {
	// Anchor: Wednesday 2026-05-13 14:30 UTC.
	const NOW = new Date("2026-05-13T14:30:00.000Z");

	it("returns null for ONCE / LIVE / null / undefined", () => {
		expect(cadenceNextFireUtc("ONCE", NOW)).toBeNull();
		expect(cadenceNextFireUtc("LIVE", NOW)).toBeNull();
		expect(cadenceNextFireUtc(null, NOW)).toBeNull();
		expect(cadenceNextFireUtc(undefined, NOW)).toBeNull();
	});

	it("DAILY → next 00:00 UTC after now", () => {
		const next = cadenceNextFireUtc("DAILY", NOW);
		expect(next?.toISOString()).toBe("2026-05-14T00:00:00.000Z");
	});

	it("WEEKLY → next Sunday 00:00 UTC after now", () => {
		// 2026-05-13 is a Wednesday (UTC). Next Sunday is 2026-05-17.
		const next = cadenceNextFireUtc("WEEKLY", NOW);
		expect(next?.toISOString()).toBe("2026-05-17T00:00:00.000Z");
	});

	it("WEEKLY on Sunday advances a full 7 days (no double-fire window)", () => {
		// 2026-05-17 is a Sunday.
		const onSunday = new Date("2026-05-17T08:00:00.000Z");
		const next = cadenceNextFireUtc("WEEKLY", onSunday);
		expect(next?.toISOString()).toBe("2026-05-24T00:00:00.000Z");
	});

	it("MONTHLY → 1st of next month at 00:00 UTC", () => {
		const next = cadenceNextFireUtc("MONTHLY", NOW);
		expect(next?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
	});

	it("MONTHLY in December rolls over to January", () => {
		const dec = new Date("2026-12-15T12:00:00.000Z");
		const next = cadenceNextFireUtc("MONTHLY", dec);
		expect(next?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
	});

	// Yellow B — the cadence helper used to add one period regardless,
	// so calling it at EXACTLY the boundary moment (Sunday 00:00 UTC etc.)
	// drifted the persisted `urlNextRefreshAt` by a whole period. The
	// boundary now returns the boundary itself.
	describe("exact boundary returns the boundary moment", () => {
		it("DAILY at exactly 00:00 UTC returns today's midnight", () => {
			const midnight = new Date("2026-05-13T00:00:00.000Z");
			vi.useFakeTimers();
			vi.setSystemTime(midnight);
			try {
				const next = cadenceNextFireUtc("DAILY", midnight);
				expect(next?.toISOString()).toBe("2026-05-13T00:00:00.000Z");
			} finally {
				vi.useRealTimers();
			}
		});

		it("WEEKLY at exactly Sunday 00:00 UTC returns this Sunday", () => {
			// 2026-05-17 is a Sunday.
			const sundayMidnight = new Date("2026-05-17T00:00:00.000Z");
			vi.useFakeTimers();
			vi.setSystemTime(sundayMidnight);
			try {
				const next = cadenceNextFireUtc("WEEKLY", sundayMidnight);
				expect(next?.toISOString()).toBe("2026-05-17T00:00:00.000Z");
			} finally {
				vi.useRealTimers();
			}
		});

		it("MONTHLY at exactly 1st-of-month 00:00 UTC returns this 1st", () => {
			const monthStart = new Date("2026-06-01T00:00:00.000Z");
			vi.useFakeTimers();
			vi.setSystemTime(monthStart);
			try {
				const next = cadenceNextFireUtc("MONTHLY", monthStart);
				expect(next?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
			} finally {
				vi.useRealTimers();
			}
		});

		it("WEEKLY one millisecond after Sunday midnight still advances", () => {
			const justAfter = new Date("2026-05-17T00:00:00.001Z");
			const next = cadenceNextFireUtc("WEEKLY", justAfter);
			expect(next?.toISOString()).toBe("2026-05-24T00:00:00.000Z");
		});
	});
});

describe("buildUrlSourceScheduleId / parseContextIdFromScheduleId", () => {
	it("round-trips a contextId through the schedule-id format", () => {
		const id = buildUrlSourceScheduleId("ctx-42");
		expect(id).toBe("url-source-schedule-ctx-42");
		expect(parseContextIdFromScheduleId(id)).toBe("ctx-42");
	});
	it("returns null for schedules that don't match the prefix", () => {
		expect(parseContextIdFromScheduleId("agent-health-monitor")).toBeNull();
		expect(parseContextIdFromScheduleId("url-source-schedule-")).toBeNull();
	});
});

describe("createUrlSourceSchedule", () => {
	it("creates a schedule with the DAILY cron and the expected scheduleId", async () => {
		const { client, create } = makeFakeClient();

		const result = await createUrlSourceSchedule(
			{ ...baseArgs, refreshMode: "DAILY" },
			client,
		);

		expect(result.scheduleId).toBe("url-source-schedule-ctx-1");
		expect(create).toHaveBeenCalledTimes(1);
		const callArg = create.mock.calls[0][0];
		expect(callArg.scheduleId).toBe("url-source-schedule-ctx-1");
		expect(callArg.spec.cronExpressions).toEqual(["0 0 * * *"]);
		expect(callArg.action.type).toBe("startWorkflow");
		expect(callArg.action.workflowType).toBe("urlSourceCrawlWorkflow");
		expect(callArg.action.taskQueue).toBe("project-documents");
		expect(callArg.action.workflowId).toBe("url-crawl-ctx-1");
		expect(callArg.action.args[0]).toMatchObject({
			contextId: "ctx-1",
			apiKey: "fc-decrypted-key",
			urlRefreshMode: "DAILY",
			mode: "scheduled",
		});
	});

	it("uses the WEEKLY cron when refreshMode is WEEKLY", async () => {
		const { client, create } = makeFakeClient();
		await createUrlSourceSchedule(
			{ ...baseArgs, refreshMode: "WEEKLY" },
			client,
		);
		expect(create.mock.calls[0][0].spec.cronExpressions).toEqual([
			"0 0 * * 0",
		]);
	});

	it("uses the MONTHLY cron when refreshMode is MONTHLY", async () => {
		const { client, create } = makeFakeClient();
		await createUrlSourceSchedule(
			{ ...baseArgs, refreshMode: "MONTHLY" },
			client,
		);
		expect(create.mock.calls[0][0].spec.cronExpressions).toEqual([
			"0 0 1 * *",
		]);
	});

	it("throws MissingFirecrawlKeyError when apiKey is empty", async () => {
		const { client } = makeFakeClient();
		await expect(
			createUrlSourceSchedule(
				{ ...baseArgs, apiKey: "", refreshMode: "DAILY" },
				client,
			),
		).rejects.toBeInstanceOf(MissingFirecrawlKeyError);
	});

	it("throws when called with a non-scheduled refreshMode", async () => {
		const { client } = makeFakeClient();
		await expect(
			createUrlSourceSchedule(
				{ ...baseArgs, refreshMode: "ONCE" as never },
				client,
			),
		).rejects.toThrow(/non-scheduled mode/);
	});
});

describe("updateUrlSourceSchedule — transitions", () => {
	it("scheduled → scheduled: deletes then recreates", async () => {
		const { client, create, handleDelete } = makeFakeClient();
		const result = await updateUrlSourceSchedule(
			{
				contextId: "ctx-1",
				oldRefreshMode: "DAILY",
				newRefreshMode: "WEEKLY",
				url: "https://example.com",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				projectId: "proj-1",
				userId: "u-1",
				organizationId: null,
				apiKey: "k",
			},
			client,
		);

		expect(result.action).toBe("updated");
		expect(result.scheduleId).toBe("url-source-schedule-ctx-1");
		expect(handleDelete).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0].spec.cronExpressions).toEqual([
			"0 0 * * 0",
		]);
	});

	it("scheduled → ONCE: deletes, returns scheduleId null", async () => {
		const { client, create, handleDelete } = makeFakeClient();
		const result = await updateUrlSourceSchedule(
			{
				contextId: "ctx-1",
				oldRefreshMode: "WEEKLY",
				newRefreshMode: "ONCE",
				url: "https://example.com",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				projectId: "proj-1",
				userId: "u-1",
				organizationId: null,
			},
			client,
		);

		expect(result.action).toBe("deleted");
		expect(result.scheduleId).toBeNull();
		expect(handleDelete).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
	});

	it("ONCE → scheduled: creates, returns scheduleId", async () => {
		const { client, create, handleDelete } = makeFakeClient();
		const result = await updateUrlSourceSchedule(
			{
				contextId: "ctx-1",
				oldRefreshMode: "ONCE",
				newRefreshMode: "DAILY",
				url: "https://example.com",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				projectId: "proj-1",
				userId: "u-1",
				organizationId: null,
				apiKey: "k",
			},
			client,
		);

		expect(result.action).toBe("created");
		expect(result.scheduleId).toBe("url-source-schedule-ctx-1");
		expect(create).toHaveBeenCalledTimes(1);
		expect(handleDelete).not.toHaveBeenCalled();
	});

	it("LIVE → scheduled: creates", async () => {
		const { client, create } = makeFakeClient();
		const result = await updateUrlSourceSchedule(
			{
				contextId: "ctx-1",
				oldRefreshMode: "LIVE",
				newRefreshMode: "MONTHLY",
				url: "https://example.com",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				projectId: "proj-1",
				userId: "u-1",
				organizationId: null,
				apiKey: "k",
			},
			client,
		);
		expect(result.action).toBe("created");
		expect(create.mock.calls[0][0].spec.cronExpressions).toEqual([
			"0 0 1 * *",
		]);
	});

	it("scheduled → LIVE: deletes", async () => {
		const { client, create, handleDelete } = makeFakeClient();
		const result = await updateUrlSourceSchedule(
			{
				contextId: "ctx-1",
				oldRefreshMode: "DAILY",
				newRefreshMode: "LIVE",
				url: "https://example.com",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				projectId: "proj-1",
				userId: "u-1",
				organizationId: null,
			},
			client,
		);
		expect(result.action).toBe("deleted");
		expect(result.scheduleId).toBeNull();
		expect(handleDelete).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
	});

	it("same scheduled mode: no-op", async () => {
		const { client, create, handleDelete } = makeFakeClient();
		const result = await updateUrlSourceSchedule(
			{
				contextId: "ctx-1",
				oldRefreshMode: "DAILY",
				newRefreshMode: "DAILY",
				url: "https://example.com",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				projectId: "proj-1",
				userId: "u-1",
				organizationId: null,
				apiKey: "k",
			},
			client,
		);
		expect(result.action).toBe("noop");
		expect(create).not.toHaveBeenCalled();
		expect(handleDelete).not.toHaveBeenCalled();
	});

	it("ONCE ↔ LIVE: no-op", async () => {
		const { client, create, handleDelete } = makeFakeClient();
		const result = await updateUrlSourceSchedule(
			{
				contextId: "ctx-1",
				oldRefreshMode: "ONCE",
				newRefreshMode: "LIVE",
				url: "https://example.com",
				scope: "SINGLE_PAGE",
				maxPages: 1,
				projectId: "proj-1",
				userId: "u-1",
				organizationId: null,
			},
			client,
		);
		expect(result.action).toBe("noop");
		expect(create).not.toHaveBeenCalled();
		expect(handleDelete).not.toHaveBeenCalled();
	});

	it("switching INTO scheduled without apiKey throws MissingFirecrawlKeyError", async () => {
		const { client } = makeFakeClient();
		await expect(
			updateUrlSourceSchedule(
				{
					contextId: "ctx-1",
					oldRefreshMode: "ONCE",
					newRefreshMode: "DAILY",
					url: "https://example.com",
					scope: "SINGLE_PAGE",
					maxPages: 1,
					projectId: "proj-1",
					userId: "u-1",
					organizationId: null,
					// apiKey omitted
				},
				client,
			),
		).rejects.toBeInstanceOf(MissingFirecrawlKeyError);
	});
});

describe("deleteUrlSourceSchedule", () => {
	it("calls delete on the handle and returns deleted: true", async () => {
		const { client, getHandle, handleDelete } = makeFakeClient();
		const result = await deleteUrlSourceSchedule(
			{ scheduleId: "url-source-schedule-ctx-1" },
			client,
		);
		expect(result.deleted).toBe(true);
		expect(getHandle).toHaveBeenCalledWith("url-source-schedule-ctx-1");
		expect(handleDelete).toHaveBeenCalledTimes(1);
	});

	it("swallows 'not found' errors and returns deleted: false", async () => {
		const handleDelete = vi
			.fn()
			.mockRejectedValue(new Error("schedule not found"));
		const client = {
			getHandle: vi.fn().mockReturnValue({ delete: handleDelete }),
		} as unknown as ScheduleClient;

		const result = await deleteUrlSourceSchedule(
			{ scheduleId: "url-source-schedule-orphan" },
			client,
		);
		expect(result.deleted).toBe(false);
	});

	it("rethrows non-not-found errors", async () => {
		const handleDelete = vi
			.fn()
			.mockRejectedValue(new Error("connection refused"));
		const client = {
			getHandle: vi.fn().mockReturnValue({ delete: handleDelete }),
		} as unknown as ScheduleClient;

		await expect(
			deleteUrlSourceSchedule(
				{ scheduleId: "url-source-schedule-ctx-1" },
				client,
			),
		).rejects.toThrow(/connection refused/);
	});
});
