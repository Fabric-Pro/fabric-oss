import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	BindingConflict: class extends Error {},
	start: vi.fn(),
	history: vi.fn(),
	frame: vi.fn(),
	membership: vi.fn(),
	read: vi.fn(),
	edit: vi.fn(),
	load: vi.fn(),
	update: vi.fn(),
	project: vi.fn(),
	sync: vi.fn(),
	validation: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {},
	WorkspaceWorkflowBindingConflictError: mocks.BindingConflict,
	getAccessibleFrameById: mocks.frame,
	listWorkspaceReviewHistory: mocks.history,
	canReadOrganizationWorkflows: mocks.read,
	canUpdateOrganizationWorkflows: mocks.edit,
	getWorkflowById: mocks.load,
	updateWorkflow: mocks.update,
	projectPlacementRefusal: mocks.project,
	isWorkflowLive: (status: string) =>
		status === "PUBLISHED" || status === "ACTIVE",
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../agentic-publish-validation", () => ({
	findAgenticPublishProblems: mocks.validation,
}));
vi.mock("../sync-workflow-schedule", () => ({
	syncWorkflowSchedule: mocks.sync,
}));
vi.mock("../workflow-execution-commands", () => ({
	startWorkflowExecutionCommand: mocks.start,
}));
vi.mock("@repo/temporal", () => ({ findScheduleCron: vi.fn() }));
vi.mock("@repo/utils", () => ({
	decryptApiKeyMaybe: vi.fn(),
	encryptApiKey: vi.fn(),
}));

import { ADO_STORY_REVIEW_NODE_TYPE } from "@repo/temporal/workflow-node-types";
import { applyWorkflowUpdate } from "../workflow-commands";
import { loadEditableWorkflow } from "../workflow-command-context";
import {
	configureWorkspaceStoryReviewCommand,
	getWorkspaceStoryReviewCommand,
	listWorkspaceStoryReviewRunsCommand,
	runWorkspaceStoryReviewCommand,
} from "../workspace-story-review-commands";

const actor = { userId: "owner-1", organizationId: "org-1" };
const binding = { id: "workspace-1", ...actor, projectId: "project-1" };
const config = {
	assignee: { mode: "current" as const },
	rubric: "Check clarity",
	workItemTypes: ["Requirement"],
	requirementFields: ["System.Title"],
	model: "example-model",
	skills: [],
};
const updatedAt = new Date("2026-01-01T12:00:00Z");
function workflow() {
	return {
		id: "workflow-1",
		...actor,
		projectId: "project-1",
		name: "Example review",
		status: "PUBLISHED",
		version: 2,
		updatedAt,
		settings: { privateSetting: "not-for-pages" },
		variables: { privateVariable: "not-for-pages" },
		nodes: [
			{
				id: "schedule",
				type: "trigger",
				position: { x: 10, y: 20 },
				data: {
					label: "Daily",
					config: {
						triggerType: "Schedule",
						scheduleCron: "0 9 * * *",
						scheduleTimezone: "UTC",
						preserve: true,
					},
				},
			},
			{
				id: "review",
				type: ADO_STORY_REVIEW_NODE_TYPE,
				position: { x: 30, y: 40 },
				data: {
					label: "Review",
					config: { ...config, workspaceFrameId: binding.id },
				},
			},
			{
				id: "other",
				type: "transform",
				data: { label: "Keep", config: { expression: "value" } },
			},
		],
		edges: [
			{ id: "e1", source: "schedule", target: "review" },
			{ id: "e2", source: "review", target: "other" },
		],
	};
}
function input() {
	return {
		workflowId: "workflow-1",
		expectedUpdatedAt: updatedAt.toISOString(),
		config: {
			...config,
			assignee: {
				mode: "selected" as const,
				uniqueName: "member@example.com",
			},
		},
		schedule: { cron: "0 10 * * *", timezone: "Europe/Berlin" },
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.membership.mockResolvedValue({ id: "membership-1" });
	mocks.read.mockResolvedValue(true);
	mocks.edit.mockResolvedValue(true);
	mocks.load.mockResolvedValue(workflow());
	mocks.project.mockResolvedValue(null);
	mocks.validation.mockResolvedValue({ problems: [] });
	mocks.update.mockImplementation(async (_id, _userId, patch) => ({
		...workflow(),
		...patch,
		updatedAt: new Date("2026-01-01T13:00:00Z"),
	}));
	mocks.sync.mockResolvedValue({ outcome: "updated", cron: "0 10 * * *" });
});

const executionBinding = { ...binding, updatedAt };
const runInput = {
	workflowId: "workflow-1",
	expectedUpdatedAt: updatedAt.toISOString(),
	idempotencyKey: "click-1",
};

describe("bound review run and safe history", () => {
	it("uses the server graph, binding, one-off force and fixed source", async () => {
		mocks.start.mockResolvedValueOnce({
			status: "unconfirmed",
			execution: { id: "run-1" },
			message: "private engine detail",
		});
		const result = await runWorkspaceStoryReviewCommand(
			actor,
			executionBinding,
			{ ...runInput, forceReview: true },
		);
		expect(mocks.start).toHaveBeenCalledWith(
			actor,
			expect.objectContaining({
				workflowId: "workflow-1",
				confirmedProjectId: "project-1",
				requirePublished: true,
				source: "workspace-story-review",
				idempotencyKey: "workspace-review:workspace-1:click-1",
				nodes: expect.arrayContaining([
					expect.objectContaining({ id: "review" }),
				]),
				edges: workflow().edges,
				workspaceLaunch: {
					kind: "story-review",
					binding: {
						workflowId: "workflow-1",
						...actor,
						projectId: "project-1",
						workspaceFrameId: "workspace-1",
						workflowUpdatedAt: updatedAt,
						frameUpdatedAt: updatedAt,
						status: "PUBLISHED",
						requirement: { kind: "row-only" },
					},
					nodeId: "review",
					forceReview: true,
				},
			}),
		);
		expect(result).toEqual({
			workflowId: "workflow-1",
			executionId: "run-1",
			startStatus: "unconfirmed",
			deduplicated: false,
			failure: null,
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("maps a reservation conflict without returning private data", async () => {
		mocks.start.mockRejectedValueOnce(
			new mocks.BindingConflict("Read current settings."),
		);
		await expect(
			runWorkspaceStoryReviewCommand(actor, executionBinding, runInput),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it.each([
		{ nodes: [] },
		{ projectId: "foreign" },
		{ workspaceReviewBinding: {} },
		{ idempotencyKey: undefined },
		{ forceReview: "true" },
	])(
		"rejects foreign graphs/scopes, forged markers and invalid run arguments",
		async (patch) => {
			await expect(
				runWorkspaceStoryReviewCommand(actor, executionBinding, {
					...runInput,
					...patch,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);

	it("projects only the bound node's validated counts and an accessible project artifact", async () => {
		mocks.history.mockResolvedValueOnce({
			hasMore: true,
			nextOffset: 2,
			executions: [
				{
					id: "run-1",
					status: "COMPLETED",
					triggerType: "MANUAL",
					startedAt: updatedAt,
					completedAt: updatedAt,
					duration: 1,
					hasError: true,
					frameId: "artifact-1",
					review: {
						counts: {
							total: 2,
							reviewed: 1,
							reused: 1,
							removed: 0,
						},
						forced: false,
						capture: { requirementsAsOf: updatedAt.toISOString() },
						html: "private HTML",
						cache: { private: true },
						selection: {
							assignee: {
								mode: "selected",
								uniqueName: "past@example.com",
							},
							workItemTypes: ["Bug"],
						},
					},
				},
			],
		});
		mocks.frame.mockResolvedValueOnce({
			id: "artifact-1",
			...actor,
			projectId: binding.projectId,
			surface: "artifact",
		});
		const result = await listWorkspaceStoryReviewRunsCommand(
			actor,
			executionBinding,
			{ workflowId: "workflow-1", limit: 2 },
		);
		expect(mocks.history).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 2,
				offset: 0,
				nodeId: "review",
				binding: expect.objectContaining({
					workflowUpdatedAt: updatedAt,
					frameUpdatedAt: updatedAt,
				}),
			}),
		);
		expect(result).toMatchObject({
			hasMore: true,
			nextOffset: 2,
			runs: [
				{
					id: "run-1",
					hasError: true,
					frameId: "artifact-1",
					review: {
						counts: {
							total: 2,
							reviewed: 1,
							reused: 1,
							removed: 0,
						},
						selection: {
							assignee: {
								mode: "selected",
								uniqueName: "past@example.com",
							},
							workItemTypes: ["Bug"],
						},
					},
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it.each([
		null,
		{
			id: "foreign",
			organizationId: "other-org",
			projectId: "project-1",
			surface: "artifact",
		},
		{
			id: "foreign",
			organizationId: "org-1",
			projectId: "other-project",
			surface: "artifact",
		},
	])(
		"omits inaccessible result references and rejects invalid metrics without fallback",
		async (frame) => {
			mocks.frame.mockResolvedValueOnce(frame);
			mocks.history.mockResolvedValueOnce({
				hasMore: false,
				executions: [
					{
						id: "run-1",
						status: "COMPLETED",
						triggerType: "SCHEDULE",
						startedAt: updatedAt,
						completedAt: updatedAt,
						duration: 0,
						hasError: false,
						frameId: "artifact-1",
						review: {
							counts: { total: 999 },
							html: "private HTML",
						},
					},
				],
			});
			expect(
				await listWorkspaceStoryReviewRunsCommand(
					actor,
					executionBinding,
					{ workflowId: "workflow-1" },
				),
			).toMatchObject({ runs: [{ frameId: null, review: null }] });
		},
	);

	it("preserves normalized sprint selections in historical run output", async () => {
		mocks.history.mockResolvedValueOnce({
			hasMore: false,
			executions: [
				{
					id: "sprint-run",
					frameId: null,
					review: {
						counts: {
							total: 1,
							reviewed: 0,
							reused: 1,
							removed: 0,
						},
						forced: false,
						capture: { requirementsAsOf: updatedAt.toISOString() },
						selection: {
							assignee: { mode: "current" },
							workItemTypes: ["User Story"],
							sprintContext: {
								iterationPaths: [
									" Example\\Sprint 2 ",
									"Example\\Sprint 1",
								],
								assignmentFields: [
									"System.AssignedTo",
									"Custom.Engineer",
								],
								assignedItemTypes: ["Task", "Bug", "Task"],
								parentSourceTypes: ["Task", "Bug"],
								relationKinds: ["related", "child"],
							},
						},
					},
				},
			],
		});
		const result = await listWorkspaceStoryReviewRunsCommand(
			actor,
			executionBinding,
			{ workflowId: "workflow-1" },
		);
		expect(result).toMatchObject({
			runs: [
				{
					review: {
						selection: {
							sprintContext: {
								iterationPaths: [
									"Example\\Sprint 1",
									"Example\\Sprint 2",
								],
								assignmentFields: [
									"Custom.Engineer",
									"System.AssignedTo",
								],
								assignedItemTypes: ["Bug", "Task"],
								parentSourceTypes: ["Bug", "Task"],
								relationKinds: ["child", "related"],
								excludedAssignedStates: [],
							},
						},
					},
				},
			],
		});
	});

	it("leaves legacy selection absent instead of relabeling it with current settings", async () => {
		mocks.history.mockResolvedValueOnce({
			hasMore: false,
			executions: [
				{
					id: "legacy",
					frameId: null,
					review: {
						counts: {
							total: 0,
							reviewed: 0,
							reused: 0,
							removed: 0,
						},
						forced: false,
						capture: { requirementsAsOf: updatedAt.toISOString() },
					},
				},
			],
		});
		expect(
			await listWorkspaceStoryReviewRunsCommand(actor, executionBinding, {
				workflowId: "workflow-1",
			}),
		).toMatchObject({ runs: [{ review: { selection: null } }] });
	});

	it("maps a history guard conflict and bounds pagination before lookup", async () => {
		mocks.history.mockRejectedValueOnce(
			new mocks.BindingConflict("Read current settings."),
		);
		await expect(
			listWorkspaceStoryReviewRunsCommand(actor, executionBinding, {
				workflowId: "workflow-1",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		mocks.load.mockClear();
		await expect(
			listWorkspaceStoryReviewRunsCommand(actor, executionBinding, {
				workflowId: "workflow-1",
				limit: 21,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.load).not.toHaveBeenCalled();
	});
});

describe("Workspace review configuration", () => {
	it("reads the current canonical config and safe source IDs without raw workflow data", async () => {
		const result = await getWorkspaceStoryReviewCommand(
			actor,
			binding,
			"workflow-1",
		);
		expect(result).toMatchObject({
			id: "workflow-1",
			version: 2,
			nodeId: "review",
			updatedAt: updatedAt.toISOString(),
			config: { workItemTypes: ["Requirement"] },
			schedule: { cron: "0 9 * * *", timezone: "UTC" },
			source: { workspaceFrameId: "workspace-1", projectId: "project-1" },
		});
		expect(result).not.toHaveProperty("settings");
		expect(result).not.toHaveProperty("nodes");
		expect(result).not.toHaveProperty("variables");
		expect(mocks.load).toHaveBeenCalledWith(
			"workflow-1",
			"owner-1",
			"org-1",
		);
	});

	it.each(["membership", "read", "edit"] as const)(
		"requires the actor's current %s",
		async (permission) => {
			mocks[permission].mockResolvedValueOnce(false);
			const call =
				permission === "read"
					? getWorkspaceStoryReviewCommand(
							actor,
							binding,
							"workflow-1",
						)
					: configureWorkspaceStoryReviewCommand(
							actor,
							binding,
							input(),
						);
			await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.sync).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ ...binding, userId: "other-owner" },
		{ ...binding, organizationId: "other-org" },
	])("refuses foreign server bindings", async (foreign) => {
		await expect(
			configureWorkspaceStoryReviewCommand(actor, foreign, input()),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.load).not.toHaveBeenCalled();
	});

	it.each([
		"project",
		"frame",
		"review-count",
		"trigger-count",
		"missing-trigger",
		"wrong-trigger",
	])("refuses a changed or ambiguous %s binding", async (change) => {
		const current = workflow();
		if (change === "project") current.projectId = "other-project";
		if (change === "frame") {
			current.nodes[1].data.config = {
				...config,
				workspaceFrameId: "other-workspace",
			};
		}
		if (change === "review-count") {
			current.nodes.push({ ...current.nodes[1], id: "second-review" });
		}
		if (change === "trigger-count") {
			current.nodes.push({ ...current.nodes[0], id: "second-trigger" });
		}
		if (change === "missing-trigger") current.nodes.splice(0, 1);
		if (change === "wrong-trigger") {
			current.nodes[0].data.config = { triggerType: "Manual" };
		}
		mocks.load.mockResolvedValueOnce(current);
		await expect(
			configureWorkspaceStoryReviewCommand(actor, binding, input()),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("patches only the review and schedule configs and passes an atomic CAS", async () => {
		const current = workflow();
		const result = await configureWorkspaceStoryReviewCommand(
			actor,
			binding,
			input(),
		);
		const patch = mocks.update.mock.calls[0][2];
		expect(Object.keys(patch)).toEqual(["nodes"]);
		expect(patch.nodes[0]).toEqual({
			...current.nodes[0],
			data: {
				...current.nodes[0].data,
				config: {
					...current.nodes[0].data.config,
					scheduleCron: "0 10 * * *",
					scheduleTimezone: "Europe/Berlin",
				},
			},
		});
		expect(patch.nodes[1]).toMatchObject({
			...current.nodes[1],
			data: {
				...current.nodes[1].data,
				config: {
					...config,
					assignee: {
						mode: "selected",
						uniqueName: "member@example.com",
					},
					maxStories: 20,
					workspaceFrameId: binding.id,
				},
			},
		});
		expect(patch.nodes[2]).toEqual(current.nodes[2]);
		expect(mocks.update).toHaveBeenCalledWith(
			"workflow-1",
			"owner-1",
			patch,
			"org-1",
			{ expectedUpdatedAt: updatedAt },
		);
		expect(result.schedule).toEqual({
			outcome: "updated",
			cron: "0 10 * * *",
		});
	});

	it("surfaces failed sync after a successful save", async () => {
		mocks.sync.mockResolvedValueOnce({
			outcome: "failed",
			reason: "Example scheduler unavailable",
		});
		const result = await configureWorkspaceStoryReviewCommand(
			actor,
			binding,
			input(),
		);
		expect(result).toMatchObject({
			workflow: { updatedAt: "2026-01-01T13:00:00.000Z" },
			schedule: { outcome: "failed" },
		});
	});

	it("maps a stale database CAS to CONFLICT and never syncs", async () => {
		mocks.update.mockRejectedValueOnce(
			Object.assign(new Error("Row changed"), { code: "P2025" }),
		);
		await expect(
			configureWorkspaceStoryReviewCommand(actor, binding, input()),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.sync).not.toHaveBeenCalled();
	});

	it("validates explicit draft config without scheduling or activating it", async () => {
		const draft = { ...workflow(), status: "DRAFT" };
		mocks.load.mockResolvedValueOnce(draft);
		mocks.update.mockImplementationOnce(async (_id, _user, patch) => ({
			...draft,
			...patch,
		}));
		const result = await configureWorkspaceStoryReviewCommand(
			actor,
			binding,
			input(),
		);
		expect(result).toMatchObject({
			workflow: { status: "DRAFT" },
			schedule: null,
		});
		expect(mocks.validation).toHaveBeenCalled();
		expect(mocks.sync).not.toHaveBeenCalled();
	});

	it.each([
		{ expectedUpdatedAt: undefined },
		{ config: { ...config, maxStories: 51 } },
		{ config: { ...config, workspaceFrameId: "foreign" } },
		{ config: { ...config, forceReview: true } },
		{ projectId: "foreign" },
		{ nodes: [] },
	])(
		"rejects invalid settings and unsupported args before writes",
		async (patch) => {
			await expect(
				configureWorkspaceStoryReviewCommand(actor, binding, {
					...input(),
					...patch,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.validation).not.toHaveBeenCalled();
		},
	);

	it("holds draft settings to canonical publish checks", async () => {
		mocks.load.mockResolvedValueOnce({ ...workflow(), status: "DRAFT" });
		mocks.validation.mockResolvedValueOnce({
			problems: ["Example invalid selection"],
		});
		await expect(
			configureWorkspaceStoryReviewCommand(actor, binding, input()),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("preserves the old update command's row return contract", async () => {
		const current = await loadEditableWorkflow(actor, "workflow-1", "edit");
		const result = await applyWorkflowUpdate(actor, current, {
			id: current.id,
			name: "Updated",
		});
		expect(result).toMatchObject({ id: "workflow-1", name: "Updated" });
		expect(result).not.toHaveProperty("workflow");
		expect(result).not.toHaveProperty("schedule");
		expect(mocks.update.mock.calls[0]).toHaveLength(4);
	});
});
