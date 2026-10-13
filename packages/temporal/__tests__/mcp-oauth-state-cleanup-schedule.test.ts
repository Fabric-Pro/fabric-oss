/**
 * Registration guard for the MCP OAuth-state cleanup schedule.
 *
 * The cleanup used to be a Vercel cron route, so it ran only where Vercel Cron
 * triggered it (`apps/web/vercel.json`); the Docker/Azure build never purged
 * expired rows. It is now a Temporal schedule registered at worker startup.
 * Failures this file covers are silent in production: a registration function
 * nobody calls, a `workflowType` no worker resolves, an activity the worker
 * never registers, an `already exists` rejection that fails the second boot,
 * and the old cron still being declared (a double run).
 *
 * Mocks mirror `pm-sync-stuck-watchdog-schedule.test.ts`.
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
	MCP_OAUTH_STATE_CLEANUP_CRON_SCHEDULE,
	MCP_OAUTH_STATE_CLEANUP_SCHEDULE_ID,
	MCP_OAUTH_STATE_CLEANUP_WORKFLOW_NAME,
	registerMcpOAuthStateCleanupSchedule,
	registerSystemSchedules,
} from "../src/schedules";

function fakeClient(create = scheduleCreate): ScheduleClient {
	return { create } as unknown as ScheduleClient;
}

afterEach(() => {
	scheduleCreate.mockClear();
	scheduleCreate.mockResolvedValue(undefined);
});

describe("the MCP OAuth-state cleanup schedule", () => {
	it("creates the schedule with exactly this payload", async () => {
		await registerMcpOAuthStateCleanupSchedule(fakeClient());

		expect(scheduleCreate).toHaveBeenCalledTimes(1);
		expect(scheduleCreate.mock.calls[0][0]).toEqual({
			scheduleId: "mcp-oauth-state-cleanup",
			spec: { cronExpressions: ["0 * * * *"] },
			action: {
				type: "startWorkflow",
				workflowType: "mcpOAuthStateCleanupWorkflow",
				taskQueue: "fabric-worker",
				args: [],
			},
			policies: { overlap: "SKIP", catchupWindow: "1 hour" },
			state: {
				paused: false,
				note: expect.stringContaining("OAuth state"),
			},
		});
		expect(MCP_OAUTH_STATE_CLEANUP_SCHEDULE_ID).toBe(
			"mcp-oauth-state-cleanup",
		);
		expect(MCP_OAUTH_STATE_CLEANUP_WORKFLOW_NAME).toBe(
			"mcpOAuthStateCleanupWorkflow",
		);
		expect(MCP_OAUTH_STATE_CLEANUP_CRON_SCHEDULE).toBe("0 * * * *");
	});

	it("names a workflow the workflows barrel exports", async () => {
		const workflows = await import("../src/workflows");
		expect(Object.keys(workflows)).toContain(
			MCP_OAUTH_STATE_CLEANUP_WORKFLOW_NAME,
		);
	});

	it("uses an activity the top-level activities barrel registers, and nothing else from its module", async () => {
		const activities = await import("../src/activities");
		expect(Object.keys(activities)).toContain(
			"cleanupExpiredMcpOAuthStatesActivity",
		);
		const module = await import(
			"../src/activities/mcp-oauth-state-cleanup"
		);
		expect(Object.keys(module)).toEqual([
			"cleanupExpiredMcpOAuthStatesActivity",
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
			registerMcpOAuthStateCleanupSchedule(fakeClient(create)),
		).resolves.toBeUndefined();
	});

	it("rethrows any other registration failure", async () => {
		const create = vi
			.fn()
			.mockRejectedValue(new Error("namespace not found"));
		await expect(
			registerMcpOAuthStateCleanupSchedule(fakeClient(create)),
		).rejects.toThrow("namespace not found");
	});

	it("is invoked by registerSystemSchedules", async () => {
		await registerSystemSchedules();
		const ids = scheduleCreate.mock.calls.map(
			(call) => (call[0] as { scheduleId: string }).scheduleId,
		);
		expect(ids).toContain(MCP_OAUTH_STATE_CLEANUP_SCHEDULE_ID);
	});

	it("is the only scheduler: the web app no longer declares the cron route", async () => {
		const fs = await import("node:fs");
		const vercel = JSON.parse(
			fs.readFileSync(
				new URL("../../../apps/web/vercel.json", import.meta.url),
				"utf8",
			),
		) as { crons?: { path: string }[] };
		expect((vercel.crons ?? []).map((cron) => cron.path)).not.toContain(
			"/api/cron/cleanup-oauth-states",
		);
		expect(
			fs.existsSync(
				new URL(
					"../../../apps/web/app/api/cron/cleanup-oauth-states/route.ts",
					import.meta.url,
				),
			),
		).toBe(false);
	});
});
