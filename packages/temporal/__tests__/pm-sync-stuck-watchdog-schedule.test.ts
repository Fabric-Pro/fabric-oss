/**
 * Registration guard for the stuck PM-sync watchdog schedule.
 *
 * The watchdog used to be a Vercel cron route, so it ran only where Vercel
 * Cron triggered it (`apps/web/vercel.json`); the Docker/Azure build had no
 * trigger at all. It is now a Temporal schedule registered at worker startup.
 * These registration failures can be silent in production: a registration
 * function nobody calls, a `workflowType` no worker resolves, an activity the
 * worker does not register, an `already exists` rejection that fails the second
 * boot.
 *
 * Mocks mirror `project-instruction-reaper-schedule.test.ts`.
 */

import type { ScheduleClient } from "@temporalio/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { scheduleCreate, FakeScheduleAlreadyRunning, FakeScheduleClient } =
	vi.hoisted(() => {
		const create = vi.fn().mockResolvedValue(undefined);
		return {
			scheduleCreate: create,
			FakeScheduleAlreadyRunning: class FakeScheduleAlreadyRunning extends Error {},
			FakeScheduleClient: class FakeScheduleClient {
				create = create;
			},
		};
	});

vi.mock("@temporalio/client", () => ({
	Connection: { connect: vi.fn().mockResolvedValue({ close: vi.fn() }) },
	ScheduleClient: FakeScheduleClient,
	ScheduleAlreadyRunning: FakeScheduleAlreadyRunning,
}));
vi.mock("../src/scripts/ensure-ai-usage-schedules", () => ({
	ensureAiUsageSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/scripts/ensure-context-summarization-schedules", () => ({
	ensureContextSummarizationSchedules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/scripts/ensure-monitoring-schedules", () => ({
	ensureMonitoringSchedules: vi.fn().mockResolvedValue(undefined),
}));

import {
	PM_SYNC_STUCK_WATCHDOG_CRON_SCHEDULE,
	PM_SYNC_STUCK_WATCHDOG_SCHEDULE_ID,
	PM_SYNC_STUCK_WATCHDOG_WORKFLOW_NAME,
	registerPmSyncStuckWatchdogSchedule,
	registerSystemSchedules,
} from "../src/schedules";

// The worker barrel loads the provider/database dependency graph. Give that
// setup its own budget under parallel transforms; assertions keep the test timeout.
let activities: typeof import("../src/activities");
beforeAll(async () => {
	activities = await import("../src/activities");
}, 120_000);

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the stuck PM-sync watchdog schedule", () => {
	it("creates the expected schedule payload", async () => {
		await registerPmSyncStuckWatchdogSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: PM_SYNC_STUCK_WATCHDOG_SCHEDULE_ID,
			spec: { cronExpressions: [PM_SYNC_STUCK_WATCHDOG_CRON_SCHEDULE] },
			action: {
				type: "startWorkflow",
				workflowType: PM_SYNC_STUCK_WATCHDOG_WORKFLOW_NAME,
				taskQueue: "fabric-worker",
				args: [{}],
			},
			policies: { overlap: "SKIP", catchupWindow: "10 minutes" },
			state: {
				paused: false,
				note: expect.stringContaining("pending_timeout"),
			},
		});
	});

	it("runs on the five-minute cadence of the cron it replaces", () => {
		expect(PM_SYNC_STUCK_WATCHDOG_CRON_SCHEDULE).toBe("*/5 * * * *");
	});

	it("names a workflow the workflows barrel exports", async () => {
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			PM_SYNC_STUCK_WATCHDOG_WORKFLOW_NAME,
		);
	});

	it("uses activities the top-level activities barrel registers, and nothing else from their module", async () => {
		const names = [
			"findStuckPmSyncRowsActivity",
			"probeStuckPmSyncActivity",
			"retryStuckPmSyncActivity",
			"giveUpStuckPmSyncActivity",
		];
		for (const name of names) {
			expect(Object.keys(activities)).toContain(name);
		}
		const module = await import(
			"../src/activities/pm-sync-stuck-watchdog-activities"
		);
		expect(Object.keys(module).sort()).toEqual([...names].sort());
	});

	it("runs on a queue a worker is listening to", async () => {
		const workerSrc = await import("node:fs").then((fs) =>
			fs.readFileSync(
				new URL("../src/worker.ts", import.meta.url),
				"utf8",
			),
		);
		expect(workerSrc).toContain('taskQueue: "fabric-worker"');
	});

	it("treats an already-registered schedule as success", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new FakeScheduleAlreadyRunning("exists"));
		await expect(
			registerPmSyncStuckWatchdogSchedule(fakeClient(create)),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerPmSyncStuckWatchdogSchedule(fakeClient(create)),
		).rejects.toThrow("namespace not found");
	});

	it("is invoked by registerSystemSchedules", async () => {
		await registerSystemSchedules();
		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		expect(ids).toContain(PM_SYNC_STUCK_WATCHDOG_SCHEDULE_ID);
	});

	it("is the only scheduler: the web app no longer registers the cron route", async () => {
		const fs = await import("node:fs");
		const vercel = JSON.parse(
			fs.readFileSync(
				new URL("../../../apps/web/vercel.json", import.meta.url),
				"utf8",
			),
		) as { crons?: { path: string }[] };
		expect((vercel.crons ?? []).map((cron) => cron.path)).not.toContain(
			"/api/cron/fail-stuck-pm-sync",
		);
		expect(
			fs.existsSync(
				new URL(
					"../../../apps/web/app/api/cron/fail-stuck-pm-sync/route.ts",
					import.meta.url,
				),
			),
		).toBe(false);
	});
});
