/**
 * Registration guard for the Proposal export cleanup schedule (Fizzy #2946).
 *
 * Exported PDF and Word files are kept for a day; this daily schedule is the
 * only thing that deletes them afterwards. Failures this file covers are
 * silent in production: a registration function nobody calls, a
 * `workflowType` no worker resolves, an activity the worker never registers,
 * an `already exists` rejection that fails the second boot, and a payload
 * drifting from what the cleanup's comments promise (overlap skipped, one
 * hour of catchup).
 *
 * Mocks mirror `mcp-oauth-state-cleanup-schedule.test.ts`.
 */

import type { ScheduleClient } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
	PROPOSAL_EXPORT_CLEANUP_CRON_SCHEDULE,
	PROPOSAL_EXPORT_CLEANUP_SCHEDULE_ID,
	PROPOSAL_EXPORT_CLEANUP_WORKFLOW_NAME,
	registerProposalExportCleanupSchedule,
	registerSystemSchedules,
} from "../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the Proposal export cleanup schedule", () => {
	it("creates the schedule with exactly this payload", async () => {
		await registerProposalExportCleanupSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: "proposal-export-cleanup",
			spec: { cronExpressions: ["15 6 * * *"] },
			action: {
				type: "startWorkflow",
				workflowType: "proposalExportCleanupWorkflow",
				taskQueue: "fabric-worker",
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: expect.stringContaining("Proposal"),
			},
		});
		expect(PROPOSAL_EXPORT_CLEANUP_SCHEDULE_ID).toBe(
			"proposal-export-cleanup",
		);
		expect(PROPOSAL_EXPORT_CLEANUP_WORKFLOW_NAME).toBe(
			"proposalExportCleanupWorkflow",
		);
		expect(PROPOSAL_EXPORT_CLEANUP_CRON_SCHEDULE).toBe("15 6 * * *");
	});

	it("names a workflow the workflows barrel exports, next to the export workflow", async () => {
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			PROPOSAL_EXPORT_CLEANUP_WORKFLOW_NAME,
		);
		expect(Object.keys(workflows)).toContain("proposalExportWorkflow");
	});

	it("uses activities the top-level activities barrel registers, and its module exports nothing else", async () => {
		const activities = await import("../src/activities");
		expect(Object.keys(activities)).toContain(
			"cleanupExpiredProposalExportsActivity",
		);
		expect(Object.keys(activities)).toContain(
			"exportProposalDocumentActivity",
		);

		const module = await import("../src/activities/proposal-export");
		expect(Object.keys(module).sort()).toEqual([
			"cleanupExpiredProposalExportsActivity",
			"exportProposalDocumentActivity",
		]);
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
			registerProposalExportCleanupSchedule(fakeClient(create)),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerProposalExportCleanupSchedule(fakeClient(create)),
		).rejects.toThrow("namespace not found");
	});

	it("is invoked by registerSystemSchedules", async () => {
		await registerSystemSchedules();
		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		expect(ids).toContain(PROPOSAL_EXPORT_CLEANUP_SCHEDULE_ID);
	});
});
