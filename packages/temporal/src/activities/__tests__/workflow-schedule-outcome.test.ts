/**
 * An unattended scheduled workflow that keeps failing pauses itself after three
 * runs in a row. These drive the counting activity against an in-memory
 * workflow row and notification table, so the assertions are about what the
 * owner is left with: the status, the counter, the notifications, and whether
 * the Temporal schedule is gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface WorkflowRow {
	id: string;
	organizationId: string | null;
	userId: string;
	name: string;
	status: string;
	settings: Record<string, unknown> | null;
}

interface NotificationRow {
	userId: string;
	organizationId: string | null;
	type: string;
	category: string;
	title: string;
	snippet: string;
	link: string;
	payload: Record<string, unknown>;
}

const world = vi.hoisted(() => ({
	workflow: null as unknown,
	notifications: [] as unknown[],
	executionOutput: null as unknown,
	findFirstWheres: [] as unknown[],
}));
const deleteWorkflowSchedule = vi.hoisted(() => vi.fn());
const getScheduleClient = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => {
	const tx = {
		$queryRaw: vi.fn(),
		workflow: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) => {
					world.findFirstWheres.push(where);
					const row = world.workflow as WorkflowRow | null;
					return row &&
						row.id === where.id &&
						row.organizationId === where.organizationId
						? { ...row }
						: null;
				},
			),
		},
		workflowExecution: {
			findFirst: vi.fn(async () => ({ output: world.executionOutput })),
		},
		notification: {
			create: vi.fn(async ({ data }: { data: NotificationRow }) => {
				world.notifications.push(data);
			}),
		},
	};
	return {
		canRunOrganizationWorkflows: vi.fn(),
		createWorkflowExecution: vi.fn(),
		getWorkflowById: vi.fn(),
		writeWorkflowRunState: vi.fn(
			async (
				_tx: unknown,
				data: {
					workflowId: string;
					organizationId: string | null;
					settings: Record<string, unknown>;
					status?: string;
				},
			) => {
				const row = world.workflow as WorkflowRow;
				expect(data.workflowId).toBe(row.id);
				expect(data.organizationId).toBe(row.organizationId);
				row.settings = data.settings;
				if (data.status) {
					row.status = data.status;
				}
				return 1;
			},
		),
		isWorkflowLive: (status: string) =>
			status === "PUBLISHED" || status === "ACTIVE",
		db: { $transaction: async (run: (t: typeof tx) => unknown) => run(tx) },
	};
});
vi.mock("../../client", () => ({ getScheduleClient }));
vi.mock("../../schedules/workflow-builder-schedule", () => ({
	deleteWorkflowSchedule,
}));

import { PAUSE_AFTER_CONSECUTIVE_FAILURES } from "../lib/scheduled-run-outcome";
import { recordScheduledRunOutcome } from "../workflow-schedule-kickoff";

function row(): WorkflowRow {
	return world.workflow as WorkflowRow;
}
function notifications(): NotificationRow[] {
	return world.notifications as NotificationRow[];
}

function outcome(
	executionId: string,
	status: "COMPLETED" | "FAILED" | "CANCELLED",
	organizationId: string | undefined = "org-1",
) {
	return recordScheduledRunOutcome({
		workflowId: "wf-1",
		executionId,
		organizationId,
		status,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	world.notifications = [];
	world.executionOutput = null;
	world.findFirstWheres = [];
	world.workflow = {
		id: "wf-1",
		organizationId: "org-1",
		userId: "user-1",
		name: "Weekly status",
		status: "PUBLISHED",
		settings: null,
	} satisfies WorkflowRow;
	getScheduleClient.mockResolvedValue({ client: true });
	deleteWorkflowSchedule.mockResolvedValue({ deleted: true });
});

describe("recordScheduledRunOutcome - failures", () => {
	it("counts a failed run and tells the owner, without the raw error", async () => {
		const result = await outcome("exec-1", "FAILED");

		expect(result).toEqual({
			recorded: true,
			consecutiveFailures: 1,
			paused: false,
		});
		expect(row().settings).toMatchObject({
			consecutiveFailures: 1,
			lastOutcomeExecutionId: "exec-1",
		});
		expect(row().status).toBe("PUBLISHED");
		expect(notifications()).toEqual([
			{
				userId: "user-1",
				organizationId: "org-1",
				type: "WORKFLOW_RUN_FAILED",
				category: "SYSTEM",
				title: 'Scheduled workflow "Weekly status" failed',
				snippet: "Open the run history to see what went wrong.",
				link: "workflows/wf-1",
				payload: {
					workflowId: "wf-1",
					workflowName: "Weekly status",
					executionId: "exec-1",
					status: "FAILED",
					paused: false,
				},
			},
		]);
		expect(deleteWorkflowSchedule).not.toHaveBeenCalled();
	});

	it("notifies on every failure", async () => {
		await outcome("exec-1", "FAILED");
		await outcome("exec-2", "FAILED");

		expect(notifications().map((n) => n.type)).toEqual([
			"WORKFLOW_RUN_FAILED",
			"WORKFLOW_RUN_FAILED",
		]);
	});

	it(`pauses the workflow and removes its schedule on failure number ${PAUSE_AFTER_CONSECUTIVE_FAILURES}`, async () => {
		await outcome("exec-1", "FAILED");
		await outcome("exec-2", "FAILED");
		expect(row().status).toBe("PUBLISHED");

		const result = await outcome("exec-3", "FAILED");

		expect(PAUSE_AFTER_CONSECUTIVE_FAILURES).toBe(3);
		expect(result).toEqual({
			recorded: true,
			consecutiveFailures: 3,
			paused: true,
		});
		expect(row().status).toBe("PAUSED");
		expect(row().settings).toMatchObject({
			consecutiveFailures: 3,
			pausedReason: "Paused automatically after 3 failed runs in a row.",
		});
		expect(typeof row().settings?.pausedAt).toBe("string");
		expect(deleteWorkflowSchedule).toHaveBeenCalledExactlyOnceWith("wf-1", {
			client: true,
		});
		const last = notifications().at(-1);
		expect(last).toMatchObject({
			type: "WORKFLOW_RUN_FAILED",
			title: 'Scheduled workflow "Weekly status" was paused after 3 failed runs',
			payload: { paused: true },
		});
		expect(notifications()).toHaveLength(3);
	});

	it("does not pause a workflow that is not live", async () => {
		row().status = "DRAFT";
		row().settings = { consecutiveFailures: 5 };

		const result = await outcome("exec-1", "FAILED");

		expect(result.paused).toBe(false);
		expect(row().status).toBe("DRAFT");
		expect(deleteWorkflowSchedule).not.toHaveBeenCalled();
	});
});

describe("recordScheduledRunOutcome - successes", () => {
	it("resets the streak", async () => {
		await outcome("exec-1", "FAILED");
		await outcome("exec-2", "FAILED");

		await outcome("exec-3", "COMPLETED");
		await outcome("exec-4", "FAILED");
		await outcome("exec-5", "FAILED");

		expect(row().status).toBe("PUBLISHED");
		expect(row().settings?.consecutiveFailures).toBe(2);
	});

	it("announces the first success with a link to what it published, once", async () => {
		world.executionOutput = {
			trigger: { source: "schedule" },
			"publish-frame": {
				frameId: "frame-9",
				url: "/app/example-org/frames/frame-9",
			},
		};

		await outcome("exec-1", "COMPLETED");
		await outcome("exec-2", "COMPLETED");

		expect(notifications()).toEqual([
			{
				userId: "user-1",
				organizationId: "org-1",
				type: "WORKFLOW_RUN_COMPLETED",
				category: "SYSTEM",
				title: 'Scheduled workflow "Weekly status" has run for the first time',
				snippet: "Its first result is ready to open.",
				link: "frames/frame-9",
				payload: {
					workflowId: "wf-1",
					workflowName: "Weekly status",
					executionId: "exec-1",
					status: "COMPLETED",
					frameId: "frame-9",
				},
			},
		]);
	});

	it("links to the workflow when the first run published no frame", async () => {
		world.executionOutput = { trigger: { source: "schedule" } };

		await outcome("exec-1", "COMPLETED");

		expect(notifications()[0]).toMatchObject({
			link: "workflows/wf-1",
			payload: { status: "COMPLETED" },
		});
		expect(notifications()[0].payload).not.toHaveProperty("frameId");
	});

	it("does not announce the first success again after a failure in between", async () => {
		await outcome("exec-1", "COMPLETED");
		await outcome("exec-2", "FAILED");
		await outcome("exec-3", "COMPLETED");

		expect(
			notifications().filter((n) => n.type === "WORKFLOW_RUN_COMPLETED"),
		).toHaveLength(1);
	});
});

describe("recordScheduledRunOutcome - idempotency", () => {
	it("counts and announces one execution once, however often the activity retries", async () => {
		await outcome("exec-1", "FAILED");
		const retry = await outcome("exec-1", "FAILED");

		expect(retry.recorded).toBe(false);
		expect(row().settings?.consecutiveFailures).toBe(1);
		expect(notifications()).toHaveLength(1);
	});

	it("repeats the schedule removal on a retry after the pause committed", async () => {
		row().settings = { consecutiveFailures: 2 };
		deleteWorkflowSchedule.mockRejectedValueOnce(
			new Error("temporal down"),
		);

		await expect(outcome("exec-3", "FAILED")).rejects.toThrow(
			"temporal down",
		);
		expect(row().status).toBe("PAUSED");

		const retry = await outcome("exec-3", "FAILED");

		expect(retry).toMatchObject({ recorded: false, paused: true });
		expect(deleteWorkflowSchedule).toHaveBeenCalledTimes(2);
		expect(notifications()).toHaveLength(1);
		expect(row().settings?.consecutiveFailures).toBe(3);
	});

	it("leaves the streak alone for a cancelled run", async () => {
		row().settings = { consecutiveFailures: 2 };

		await outcome("exec-1", "CANCELLED");

		expect(row().settings).toMatchObject({
			consecutiveFailures: 2,
			lastOutcomeExecutionId: "exec-1",
		});
		expect(notifications()).toEqual([]);
		expect(row().status).toBe("PUBLISHED");
	});

	it("keeps unrelated settings", async () => {
		row().settings = { publishFrameIds: { "publish-frame": "frame-1" } };

		await outcome("exec-1", "FAILED");

		expect(row().settings).toMatchObject({
			publishFrameIds: { "publish-frame": "frame-1" },
			consecutiveFailures: 1,
		});
	});
});

describe("recordScheduledRunOutcome - resuming", () => {
	it("starts a fresh streak when the owner resumed an auto-paused workflow", async () => {
		row().status = "PUBLISHED";
		row().settings = {
			consecutiveFailures: 3,
			pausedAt: "2026-10-01T00:00:00.000Z",
			pausedReason: "Paused automatically after 3 failed runs in a row.",
		};

		const result = await outcome("exec-9", "FAILED");

		expect(result).toMatchObject({ consecutiveFailures: 1, paused: false });
		expect(row().status).toBe("PUBLISHED");
		expect(row().settings).not.toHaveProperty("pausedAt");
		expect(row().settings).not.toHaveProperty("pausedReason");
	});
});

describe("recordScheduledRunOutcome - tenancy", () => {
	it("never touches a workflow in another organization", async () => {
		const result = await outcome("exec-1", "FAILED", "org-2");

		expect(result).toEqual({
			recorded: false,
			consecutiveFailures: 0,
			paused: false,
		});
		expect(notifications()).toEqual([]);
		expect(row().settings).toBeNull();
		expect(deleteWorkflowSchedule).not.toHaveBeenCalled();
		expect(world.findFirstWheres).toEqual([
			{ id: "wf-1", organizationId: "org-2" },
		]);
	});

	it("does not match an organization-less call to an organization's workflow", async () => {
		const result = await recordScheduledRunOutcome({
			workflowId: "wf-1",
			executionId: "exec-1",
			status: "FAILED",
		});

		expect(result.recorded).toBe(false);
		expect(notifications()).toEqual([]);
	});
});
