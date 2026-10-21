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
vi.mock("@repo/database", async () => ({
	workspaceWorkflowRunProvenanceSchema: (
		await import(
			"@repo/database/prisma/queries/workflows/workspace-workflow-binding"
		)
	).workspaceWorkflowRunProvenanceSchema,
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
	requirement: { kind: "row-only" as const },
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
	workspaceLaunch: {
		kind: "story-review" as const,
		binding,
		nodeId: "review-1",
		forceReview: true,
	},
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
	it("adds neutral provenance as a sibling of nested user data without changing the review marker", async () => {
		const provenance = {
			kind: "workspace-workflow",
			version: 1,
			workflowId: "workflow-1",
			workspaceFrameId: "workspace-1",
			projectId: "project-1",
			workflowVersion: 2,
			workflowUpdatedAt: stamp.toISOString(),
			frameUpdatedAt: stamp.toISOString(),
			inputsFingerprint: "a".repeat(64),
		};
		await startWorkflowExecutionCommand(actor, {
			workflowId: "workflow-1",
			requirePublished: true,
			confirmedProjectId: "project-1",
			idempotencyKey: "generic-1",
			triggerData: {
				source: "forged",
				workspaceWorkflowBinding: { projectId: "forged" },
			},
			workspaceLaunch: {
				kind: "workflow",
				binding: {
					...binding,
					requirement: { kind: "bound-run", workflowVersion: 2 },
				},
				inputsFingerprint: "a".repeat(64),
			},
		});
		expect(mocks.idempotent.mock.calls[0]?.[0]).toMatchObject({
			workspaceBinding: {
				...binding,
				requirement: { kind: "bound-run", workflowVersion: 2 },
			},
			triggerInput: {
				source: "workspace-workflow",
				workspaceWorkflowBinding: provenance,
				triggerData: {
					source: "forged",
					workspaceWorkflowBinding: { projectId: "forged" },
				},
			},
		});
		expect(
			mocks.idempotent.mock.calls[0]?.[0].triggerInput,
		).not.toHaveProperty("workspaceReviewBinding");
	});
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

	it.each([true, false])(
		"takes forceReview=%s only from the typed launch for both persistence and the engine",
		async (forceReview) => {
			const triggerData = { forceReview: "forged", other: "retained" };
			await startWorkflowExecutionCommand(actor, {
				...input,
				triggerData,
				workspaceLaunch: { ...input.workspaceLaunch, forceReview },
			});
			expect(
				mocks.idempotent.mock.calls[0]?.[0].triggerInput,
			).toMatchObject({
				triggerData: { forceReview, other: "retained" },
				workspaceReviewBinding: { forceReview },
			});
			expect(mocks.start.mock.calls[0]?.[0].start.triggerData).toEqual({
				forceReview,
				other: "retained",
			});
			expect(triggerData.forceReview).toBe("forged");
		},
	);

	it("returns an accepted-but-unconfirmed keyed run without starting it again", async () => {
		await startWorkflowExecutionCommand(actor, input);
		const triggerInput = mocks.idempotent.mock.calls[0]?.[0].triggerInput;
		mocks.start.mockClear();
		mocks.idempotent.mockResolvedValueOnce({
			outcome: "existing",
			execution: { ...execution, triggerInput },
		});
		expect(await startWorkflowExecutionCommand(actor, input)).toMatchObject(
			{ status: "unconfirmed", deduplicated: true },
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it.each(["force-review", "workflow-stamp", "frame-stamp"])(
		"refuses a keyed review replay after its %s changes",
		async (changed) => {
			await startWorkflowExecutionCommand(actor, input);
			const triggerInput =
				mocks.idempotent.mock.calls[0]?.[0].triggerInput;
			mocks.start.mockClear();
			mocks.idempotent.mockResolvedValueOnce({
				outcome: "existing",
				execution: { ...execution, triggerInput },
			});
			const revision = new Date("2026-01-01T12:01:00Z");
			await expect(
				startWorkflowExecutionCommand(actor, {
					...input,
					workspaceLaunch: {
						...input.workspaceLaunch,
						forceReview: changed === "force-review" ? false : true,
						binding: {
							...binding,
							workflowUpdatedAt:
								changed === "workflow-stamp" ? revision : stamp,
							frameUpdatedAt:
								changed === "frame-stamp" ? revision : stamp,
						},
					},
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);

	it("refuses a generic keyed replay with a different input fingerprint", async () => {
		const request = {
			...input,
			workspaceLaunch: {
				kind: "workflow" as const,
				binding: {
					...binding,
					requirement: {
						kind: "bound-run" as const,
						workflowVersion: 2,
					},
				},
				inputsFingerprint: "a".repeat(64),
			},
		};
		await startWorkflowExecutionCommand(actor, request);
		const triggerInput = mocks.idempotent.mock.calls[0]?.[0].triggerInput;
		mocks.start.mockClear();
		mocks.idempotent.mockResolvedValueOnce({
			outcome: "existing",
			execution: { ...execution, triggerInput },
		});
		await expect(
			startWorkflowExecutionCommand(actor, {
				...request,
				workspaceLaunch: {
					...request.workspaceLaunch,
					inputsFingerprint: "b".repeat(64),
				},
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it.each([
		{ userId: "other-owner" },
		{ organizationId: "other-org" },
		{ workflowId: "other-workflow" },
		{ projectId: "other-project" },
	])(
		"refuses an internal launch bound to a different actor or resource: %j",
		async (patch) => {
			await expect(
				startWorkflowExecutionCommand(actor, {
					...input,
					workspaceLaunch: {
						...input.workspaceLaunch,
						binding: { ...binding, ...patch },
					},
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.idempotent).not.toHaveBeenCalled();
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);

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
