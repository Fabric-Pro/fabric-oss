/**
 * A scheduled run uses its owner's rights, so each fire first asks whether the
 * owner may still run workflows in the organization. When not, the workflow
 * pauses the way a run of failures pauses it (status, recorded reason,
 * schedule removed) and nothing runs.
 *
 * These drive `createScheduledExecution` against an in-memory workflow row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface WorkflowRow {
	id: string;
	organizationId: string | null;
	userId: string;
	status: string;
	version: number;
	projectId: string | null;
	settings: Record<string, unknown> | null;
}

const world = vi.hoisted(() => ({ workflow: null as unknown }));
const canRunOrganizationWorkflows = vi.hoisted(() => vi.fn());
const createWorkflowExecution = vi.hoisted(() => vi.fn());
const deleteWorkflowSchedule = vi.hoisted(() => vi.fn());
const getScheduleClient = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => {
	const tx = {
		$queryRaw: vi.fn(),
		workflow: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) => {
					const row = world.workflow as WorkflowRow | null;
					return row &&
						row.id === where.id &&
						row.organizationId === where.organizationId
						? { ...row }
						: null;
				},
			),
		},
	};
	return {
		canRunOrganizationWorkflows,
		createWorkflowExecution,
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
		getWorkflowById: vi.fn(async (id: string, userId: string) => {
			const row = world.workflow as WorkflowRow | null;
			return row && row.id === id && row.userId === userId
				? { ...row }
				: null;
		}),
		isWorkflowLive: (status: string) =>
			status === "PUBLISHED" || status === "ACTIVE",
		db: { $transaction: async (run: (t: typeof tx) => unknown) => run(tx) },
	};
});
vi.mock("../../client", () => ({ getScheduleClient }));
vi.mock("../../schedules/workflow-builder-schedule", () => ({
	deleteWorkflowSchedule,
}));

import { createScheduledExecution } from "../workflow-schedule-kickoff";

function row(): WorkflowRow {
	return world.workflow as WorkflowRow;
}

function fire(organizationId: string | undefined = "org-1") {
	return createScheduledExecution({
		workflowId: "wf-1",
		userId: "user-1",
		organizationId,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	world.workflow = {
		id: "wf-1",
		organizationId: "org-1",
		userId: "user-1",
		status: "PUBLISHED",
		version: 4,
		projectId: "project-1",
		settings: { publishFrameIds: { "publish-frame": "frame-1" } },
	} satisfies WorkflowRow;
	canRunOrganizationWorkflows.mockResolvedValue(true);
	createWorkflowExecution.mockResolvedValue({ id: "exec-1" });
	getScheduleClient.mockResolvedValue({ client: true });
	deleteWorkflowSchedule.mockResolvedValue({ deleted: true });
});

describe("createScheduledExecution - owner re-check", () => {
	it("asks whether the owner may still run workflows in the organization", async () => {
		await fire();

		expect(canRunOrganizationWorkflows).toHaveBeenCalledExactlyOnceWith(
			"user-1",
			"org-1",
		);
	});

	it("runs when the owner still may", async () => {
		const result = await fire();

		expect(result).toEqual({
			executionId: "exec-1",
			version: 4,
			projectId: "project-1",
			shouldRun: true,
		});
		expect(row().status).toBe("PUBLISHED");
		expect(deleteWorkflowSchedule).not.toHaveBeenCalled();
	});

	it("runs nothing and says why when the owner has lost access", async () => {
		canRunOrganizationWorkflows.mockResolvedValue(false);

		const result = await fire();

		expect(result).toEqual({
			executionId: "",
			version: 4,
			shouldRun: false,
			reason: "owner-access-lost",
		});
		expect(createWorkflowExecution).not.toHaveBeenCalled();
	});

	it("pauses the workflow with the reason recorded and keeps its other settings", async () => {
		canRunOrganizationWorkflows.mockResolvedValue(false);

		await fire();

		expect(row().status).toBe("PAUSED");
		expect(row().settings).toMatchObject({
			publishFrameIds: { "publish-frame": "frame-1" },
			pausedReason: "owner-access-lost",
		});
		expect(typeof row().settings?.pausedAt).toBe("string");
	});

	it("removes the workflow's schedule", async () => {
		canRunOrganizationWorkflows.mockResolvedValue(false);

		await fire();

		expect(deleteWorkflowSchedule).toHaveBeenCalledExactlyOnceWith("wf-1", {
			client: true,
		});
	});

	it("does not ask about a workflow that is no longer published", async () => {
		row().status = "PAUSED";
		canRunOrganizationWorkflows.mockResolvedValue(false);

		const result = await fire();

		expect(result).toMatchObject({
			shouldRun: false,
			reason: "Workflow is PAUSED, not published",
		});
		expect(canRunOrganizationWorkflows).not.toHaveBeenCalled();
		expect(row().settings).not.toHaveProperty("pausedReason");
	});
});
