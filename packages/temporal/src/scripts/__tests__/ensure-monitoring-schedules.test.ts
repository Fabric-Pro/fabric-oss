/**
 * Every monitoring workflow must actually be SCHEDULED.
 *
 * A workflow can be written, exported, registered on the worker and still never
 * run — the schedule is a separate step, and nothing about the code looks wrong
 * when it is missing. That is not hypothetical: the Alertmanager `errorRate`
 * branch shipped in exactly that state. This test invokes the real
 * `ensureMonitoringSchedules` against a fake ScheduleClient and asserts the set
 * of schedule ids it creates, so dropping a registration call fails here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		// One probed provider, so the registry-driven loop is exercised without
		// pinning this test to the live provider list.
		getProvidersForSyntheticProbe: () => [
			{ key: "example-provider", syntheticProbe: { interval: "5m" } },
		],
	};
});

const { ensureMonitoringSchedules } = await import(
	"../ensure-monitoring-schedules"
);

type CreateArgs = {
	scheduleId: string;
	spec: { cronExpressions: string[] };
	action: { workflowType: string; taskQueue: string; args: unknown[] };
	policies: { overlap: string; catchupWindow: string };
	state: { paused: boolean; note: string };
};

const create = vi.fn();
const scheduleClient = { create } as unknown as Parameters<
	typeof ensureMonitoringSchedules
>[0];

function created(): CreateArgs[] {
	return create.mock.calls.map((c) => c[0] as CreateArgs);
}

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue(undefined);
});

describe("the full monitoring schedule set", () => {
	it("registers every schedule, including the announcement sweeper", async () => {
		await ensureMonitoringSchedules(scheduleClient);

		expect(
			created()
				.map((c) => c.scheduleId)
				.sort(),
		).toEqual([
			"monitoring-error-rate-weekly-digest",
			"monitoring-project-service-alert-digest",
			"monitoring-prune-old-incidents",
			"monitoring-status-announcement-notifications",
			"monitoring-status-page-poller",
			"monitoring-synthetic-probe-example-provider",
		]);
	});

	it("gives every schedule a cron, a task queue and a workflow type", async () => {
		await ensureMonitoringSchedules(scheduleClient);

		for (const c of created()) {
			expect(c.spec.cronExpressions[0]).toMatch(/\S/);
			expect(c.action.workflowType).toMatch(/Workflow$/);
			expect(c.action.taskQueue).toBe("fabric-worker");
		}
	});

	it("leaves no schedule paused — a paused schedule is silently inert", async () => {
		await ensureMonitoringSchedules(scheduleClient);

		expect(created().every((c) => c.state.paused === false)).toBe(true);
	});
});

describe("the status-announcement sweeper's own schedule", () => {
	async function sweeper(): Promise<CreateArgs> {
		await ensureMonitoringSchedules(scheduleClient);
		const found = created().find(
			(c) =>
				c.scheduleId === "monitoring-status-announcement-notifications",
		);
		if (!found) {
			throw new Error("sweeper schedule was not registered");
		}
		return found;
	}

	it("starts statusAnnouncementNotificationWorkflow every 5 minutes", async () => {
		const c = await sweeper();

		expect(c.action.workflowType).toBe(
			"statusAnnouncementNotificationWorkflow",
		);
		expect(c.spec.cronExpressions).toEqual(["*/5 * * * *"]);
	});

	it("skips overlapping runs, so two sweeps cannot double-send", async () => {
		// Concurrent sweeps would race on the same dedupeKey. The unique index
		// would still hold, but SKIP keeps it from being load-bearing.
		const c = await sweeper();

		expect(c.policies.overlap).toBe("SKIP");
	});

	it("names the flag in its note, so an operator can find the switch", async () => {
		const c = await sweeper();

		expect(c.state.note).toContain(
			"FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED",
		);
	});
});

describe("registration survives a schedule that already exists", () => {
	it("continues past ScheduleAlreadyRunning and registers the rest", async () => {
		// The realistic steady state: the worker restarts and most schedules are
		// already there. An unhandled throw on the first one would leave every
		// later schedule — including a newly added one — uninstalled.
		const { ScheduleAlreadyRunning } = await import("@temporalio/client");
		create.mockImplementation(async (args: CreateArgs) => {
			if (args.scheduleId === "monitoring-status-page-poller") {
				throw new ScheduleAlreadyRunning("exists", "x");
			}
		});

		await expect(
			ensureMonitoringSchedules(scheduleClient),
		).resolves.toBeUndefined();

		expect(
			created().some(
				(c) =>
					c.scheduleId ===
					"monitoring-status-announcement-notifications",
			),
		).toBe(true);
	});
});
