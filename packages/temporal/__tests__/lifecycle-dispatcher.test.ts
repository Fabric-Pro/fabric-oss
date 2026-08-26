import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		agentDeploymentTrigger: {
			findMany: mocks.findMany,
		},
	},
}));

vi.mock("../src/client", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

import { dispatchLifecycleEvent } from "../src/lib/lifecycle-dispatcher";

describe("dispatchLifecycleEvent", () => {
	beforeEach(() => {
		mocks.findMany.mockReset();
		mocks.workflowStart.mockReset();
		mocks.workflowStart.mockResolvedValue(undefined);
	});

	it("uses strict personal tenant filtering and starts matching lifecycle triggers", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "trigger-1",
				config: {
					resource: "task",
					event: "completed",
					conditions: { projectId: "project-1" },
				},
			},
		]);

		const result = await dispatchLifecycleEvent({
			resource: "task",
			event: "completed",
			projectId: "project-1",
			entityId: "task-1",
			userId: "user-1",
			organizationId: null,
			data: { taskId: "task-1" },
		});

		expect(mocks.findMany).toHaveBeenCalledWith({
			where: {
				type: "LIFECYCLE_EVENT",
				isActive: true,
				organizationId: null,
				userId: "user-1",
			},
			include: { deployment: true },
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"triggerEventWorkflow",
			expect.objectContaining({
				workflowId:
					"trigger-event-lifecycle-task-completed-task-1-trigger-1",
				taskQueue: "trigger-system",
			}),
		);
		expect(result).toEqual({ matched: 1, started: 1 });
	});

	it("uses org tenant filtering without adding a personal user filter", async () => {
		mocks.findMany.mockResolvedValue([]);

		await dispatchLifecycleEvent({
			resource: "story",
			event: "created",
			projectId: "project-1",
			entityId: "story-1",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(mocks.findMany).toHaveBeenCalledWith({
			where: {
				type: "LIFECYCLE_EVENT",
				isActive: true,
				organizationId: "org-1",
			},
			include: { deployment: true },
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("does not start triggers when resource, event, or conditions do not match", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "wrong-event",
				config: { resource: "task", event: "created" },
			},
			{
				id: "wrong-condition",
				config: {
					resource: "task",
					event: "completed",
					conditions: { projectId: "other-project" },
				},
			},
		]);

		const result = await dispatchLifecycleEvent({
			resource: "task",
			event: "completed",
			projectId: "project-1",
			entityId: "task-1",
			userId: "user-1",
		});

		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(result).toEqual({ matched: 0, started: 0 });
	});

	it("continues when one trigger fails to start", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "trigger-1",
				config: { resource: "comment", event: "created" },
			},
			{
				id: "trigger-2",
				config: { resource: "comment", event: "created" },
			},
		]);
		mocks.workflowStart
			.mockRejectedValueOnce(new Error("Temporal unavailable"))
			.mockResolvedValueOnce(undefined);

		const result = await dispatchLifecycleEvent({
			resource: "comment",
			event: "created",
			projectId: "project-1",
			entityId: "comment-1",
			userId: "user-1",
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ matched: 2, started: 1 });
	});
});
