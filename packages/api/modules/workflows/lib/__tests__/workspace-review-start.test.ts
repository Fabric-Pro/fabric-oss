import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	membership: vi.fn(),
	permitted: vi.fn(),
	project: vi.fn(),
	idempotent: vi.fn(),
	reserve: vi.fn(),
	start: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	canRunOrganizationWorkflows: mocks.permitted,
	getWorkflowById: mocks.load,
	canEditProject: mocks.project,
	createWorkflowExecutionIdempotent: mocks.idempotent,
	isWorkflowLive: (status: string) =>
		status === "PUBLISHED" || status === "ACTIVE",
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../execution-concurrency", () => ({
	resolveExecutionConcurrencyLimit: async () => 3,
	createExecutionWithinConcurrencyCap: mocks.reserve,
	concurrencyRefusalMessage: () => "At capacity",
}));
vi.mock("../start-reserved-execution", () => ({
	startReservedExecution: mocks.start,
}));

import { startWorkflowExecutionCommand } from "../workflow-execution-commands";

const actor = { userId: "owner-1", organizationId: "org-1" };
const nodes = [
	{
		id: "trigger",
		type: "trigger",
		data: { config: { triggerType: "Schedule" } },
		position: { x: 0, y: 0 },
	},
];
const stamp = new Date("2026-01-01T12:00:00Z");
const binding = {
	workflowId: "workflow-1",
	...actor,
	projectId: "project-1",
	workspaceFrameId: "workspace-1",
	workflowUpdatedAt: stamp,
	frameUpdatedAt: stamp,
	status: "PUBLISHED" as const,
};
const input = {
	workflowId: "workflow-1",
	requirePublished: true,
	confirmedProjectId: "project-1",
	idempotencyKey: "click-1",
	source: "workspace-story-review",
	triggerData: { forceReview: true },
	nodes,
	edges: [],
	workspaceReview: { binding, nodeId: "review-1" },
};
const execution = {
	id: "execution-1",
	status: "PENDING",
	triggerInput: {},
	temporalRunId: null,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.permitted.mockResolvedValue(true);
	mocks.project.mockResolvedValue(true);
	mocks.load.mockResolvedValue({
		id: "workflow-1",
		...actor,
		projectId: "project-1",
		name: "Example",
		status: "PUBLISHED",
		version: 2,
		nodes,
		edges: [],
	});
	mocks.idempotent.mockResolvedValue({ outcome: "created", execution });
	mocks.reserve.mockResolvedValue({ allowed: true, execution });
	mocks.start.mockResolvedValue({
		status: "started",
		temporalWorkflowId: "workflow-execution-execution-1",
	});
});

describe("canonical guarded review starts", () => {
	it("passes binding into reservation and writes the reserved marker outside triggerData", async () => {
		await startWorkflowExecutionCommand(actor, input);
		expect(mocks.idempotent).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceBinding: binding,
				limit: 3,
				triggerInput: {
					triggerData: { forceReview: true },
					variables: undefined,
					source: "workspace-story-review",
					workspaceReviewBinding: {
						kind: "workspace-story-review",
						version: 1,
						workflowId: "workflow-1",
						workspaceFrameId: "workspace-1",
						projectId: "project-1",
						nodeId: "review-1",
						workflowUpdatedAt: stamp.toISOString(),
						frameUpdatedAt: stamp.toISOString(),
						forceReview: true,
					},
				},
			}),
		);
		expect(mocks.start).toHaveBeenCalledWith(
			expect.objectContaining({
				start: expect.objectContaining({
					nodes,
					edges: [],
					projectId: "project-1",
				}),
			}),
		);
	});

	it("does not reach Temporal after a reservation guard conflict", async () => {
		const conflict = new Error("Binding conflict");
		mocks.idempotent.mockRejectedValueOnce(conflict);
		await expect(startWorkflowExecutionCommand(actor, input)).rejects.toBe(
			conflict,
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("returns an accepted-but-unconfirmed keyed run without starting it again", async () => {
		mocks.idempotent.mockResolvedValueOnce({
			outcome: "existing",
			execution,
		});
		expect(await startWorkflowExecutionCommand(actor, input)).toMatchObject(
			{ status: "unconfirmed", deduplicated: true },
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("keeps legacy unkeyed calls free of controller metadata and guard arguments", async () => {
		await startWorkflowExecutionCommand(actor, {
			workflowId: "workflow-1",
			requirePublished: true,
		});
		expect(mocks.reserve.mock.calls[0][0]).not.toHaveProperty(
			"workspaceBinding",
		);
		expect(
			mocks.reserve.mock.calls[0][0].data.triggerInput,
		).not.toHaveProperty("workspaceReviewBinding");
	});
});
