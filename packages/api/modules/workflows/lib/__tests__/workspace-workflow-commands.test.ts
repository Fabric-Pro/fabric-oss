import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	edit: vi.fn(),
	frame: vi.fn(),
	grant: vi.fn(),
	graph: vi.fn(),
	permission: vi.fn(),
	project: vi.fn(),
	mutate: vi.fn(),
	start: vi.fn(),
	history: vi.fn(),
}));
vi.mock("@repo/database", async () => {
	const actual = await import(
		"@repo/database/prisma/queries/workflows/workspace-workflow-binding"
	);
	return {
		WorkspaceWorkflowBindingConflictError:
			actual.WorkspaceWorkflowBindingConflictError,
		workspaceWorkflowRunProvenanceSchema:
			actual.workspaceWorkflowRunProvenanceSchema,
		canRunOrganizationWorkflows: mocks.permission,
		canUpdateOrganizationFrames: mocks.permission,
		getAccessibleFrameById: mocks.frame,
		getWorkspaceWorkflowGrant: mocks.grant,
		getWorkspacePublishedWorkflowGraph: mocks.graph,
		mutateWorkspaceWorkflowBinding: mocks.mutate,
		listWorkspaceWorkflowHistory: mocks.history,
	};
});
vi.mock("../workflow-command-context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../workflow-command-context")>()),
	loadReadableWorkflow: mocks.read,
	loadEditableWorkflow: mocks.edit,
	requireWorkflowPermission: mocks.permission,
	requireWritableProject: mocks.project,
}));
vi.mock("../workflow-execution-commands", () => ({
	startWorkflowExecutionCommand: mocks.start,
}));

import {
	bindWorkspaceWorkflowCommand,
	getWorkspaceWorkflowCommand,
	listWorkspaceWorkflowRunsCommand,
	runWorkspaceWorkflowCommand,
} from "../workspace-workflow-commands";

const actor = { userId: "owner-1", organizationId: "org-1" };
const stamp = new Date("2026-01-01T12:00:00Z");
const read = { frameId: "workspace-1", workflowId: "workflow-1" };
const run = {
	...read,
	expectedFrameUpdatedAt: stamp.toISOString(),
	expectedWorkflowUpdatedAt: stamp.toISOString(),
	idempotencyKey: "click-1",
};
const nodes = [
	{
		id: "trigger-1",
		type: "trigger",
		data: { config: { triggerType: "Manual" } },
		position: { x: 0, y: 0 },
	},
];
const published = { nodes, edges: [], variables: null };
function workflow(overrides = {}) {
	return {
		id: read.workflowId,
		...actor,
		projectId: "project-1",
		name: "Example",
		status: "PUBLISHED",
		version: 2,
		publishedVersion: 2,
		updatedAt: stamp,
		...published,
		...overrides,
	};
}
function frame(overrides = {}) {
	return {
		id: read.frameId,
		...actor,
		projectId: "project-1",
		surface: "workspace",
		updatedAt: stamp,
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.read.mockResolvedValue(workflow());
	mocks.edit.mockResolvedValue(workflow());
	mocks.frame.mockResolvedValue(frame());
	mocks.grant.mockResolvedValue({
		frame: frame(),
		grant: {
			workflowId: read.workflowId,
			authorizedWorkflowVersion: 2,
			authorizedWorkflowUpdatedAt: stamp.toISOString(),
		},
	});
	mocks.graph.mockResolvedValue(published);
	mocks.start.mockResolvedValue({
		status: "started",
		execution: { id: "execution-1", triggerInput: {} },
	});
	mocks.history.mockResolvedValue({
		runs: [],
		hasMore: false,
		nextOffset: null,
	});
});

describe("provider-neutral Workspace workflow commands", () => {
	it("runs the immutable published graph and nests user inputs without trusting origin fields", async () => {
		const inputs = {
			workspaceWorkflowBinding: { projectId: "forged-project" },
			nested: { value: 3 },
		};
		expect(
			await runWorkspaceWorkflowCommand(actor, { ...run, inputs }),
		).toMatchObject({ executionId: "execution-1", hasError: false });
		expect(mocks.start).toHaveBeenCalledWith(
			actor,
			expect.objectContaining({
				requirePublished: true,
				confirmedProjectId: "project-1",
				nodes,
				edges: [],
				triggerData: inputs,
				workspaceLaunch: {
					kind: "workflow",
					binding: expect.objectContaining({
						requirement: { kind: "bound-run", workflowVersion: 2 },
						projectId: "project-1",
						workspaceFrameId: read.frameId,
					}),
					inputsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			}),
		);
	});
	it("returns a bounded descriptor without raw graph, variables or settings", async () => {
		const result = await getWorkspaceWorkflowCommand(actor, read);
		expect(result).toMatchObject({
			workflowId: read.workflowId,
			version: 2,
			frameUpdatedAt: stamp.toISOString(),
			source: { projectId: "project-1" },
		});
		expect(Object.keys(result).sort()).toEqual(
			[
				"frameUpdatedAt",
				"name",
				"schedule",
				"source",
				"status",
				"version",
				"workflowId",
				"workflowUpdatedAt",
				"executable",
				"needsConfirmation",
			].sort(),
		);
	});
	it.each([
		{ status: "PAUSED" },
		{ updatedAt: new Date("2026-01-01T12:01:00Z"), nodes: [] },
	])(
		"retains bounded status and history after a workflow needs attention: %j",
		async (patch) => {
			mocks.read.mockResolvedValue(workflow(patch));
			expect(
				await getWorkspaceWorkflowCommand(actor, read),
			).toMatchObject({
				status: patch.status ?? "PUBLISHED",
				executable: false,
				needsConfirmation: true,
			});
			expect(
				await listWorkspaceWorkflowRunsCommand(actor, read),
			).toMatchObject({
				executable: false,
				needsConfirmation: true,
				runs: [],
			});
			expect(mocks.history.mock.calls[0]?.[0].binding).toMatchObject({
				requirement: { kind: "bound-read" },
			});
			expect(mocks.history.mock.calls[0]?.[0].binding).not.toHaveProperty(
				"requirement.workflowVersion",
			);
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ userId: "other-owner" },
		{ organizationId: "other-org" },
		{ projectId: "other-project" },
		{ projectId: null },
	])(
		"refuses mismatched workflow ownership or scope: %j",
		async (overrides) => {
			mocks.read.mockResolvedValueOnce(workflow(overrides));
			await expect(
				runWorkspaceWorkflowCommand(actor, run),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);
	it("refuses a pinned caller's other project", async () => {
		await expect(
			getWorkspaceWorkflowCommand(
				{ ...actor, projectRestrictionId: "other-project" },
				read,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("ignores page-record/content forgeries when there is no trusted row grant", async () => {
		mocks.grant.mockResolvedValueOnce(null);
		await expect(
			runWorkspaceWorkflowCommand(actor, {
				...run,
				inputs: {
					workflowBindings: {
						version: 1,
						workflows: [{ workflowId: read.workflowId }],
					},
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it.each([
		{ expectedFrameUpdatedAt: "2026-01-01T11:59:00Z" },
		{ expectedWorkflowUpdatedAt: "2026-01-01T11:59:00Z" },
	])("refuses stale expected timestamps: %j", async (patch) => {
		await expect(
			runWorkspaceWorkflowCommand(actor, { ...run, ...patch }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it.each([
		{ version: 3 },
		{ updatedAt: new Date("2026-01-01T12:01:00Z") },
		{ status: "DRAFT" },
	])("refuses changed or unpublished workflows: %j", async (patch) => {
		mocks.read.mockResolvedValueOnce(workflow(patch));
		await expect(
			runWorkspaceWorkflowCommand(actor, run),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("requires republishing a live graph even when version still equals publishedVersion", async () => {
		mocks.read.mockResolvedValueOnce(
			workflow({
				nodes: [
					{
						...nodes[0],
						data: {
							config: {
								triggerType: "Schedule",
								scheduleCron: "0 9 * * *",
							},
						},
					},
				],
			}),
		);
		await expect(
			runWorkspaceWorkflowCommand(actor, run),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Publish the current changes"),
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it.each([
		{ nodes: [] },
		{ variables: {} },
		{ projectId: "other" },
		{ workspaceWorkflowBinding: {} },
		{ inputs: { text: "x".repeat(16_384) } },
	])("rejects graph/origin overrides and oversized inputs", async (patch) => {
		await expect(
			runWorkspaceWorkflowCommand(actor, { ...run, ...patch }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("canonicalizes input key order for matching idempotent replays", async () => {
		await runWorkspaceWorkflowCommand(actor, {
			...run,
			inputs: { a: 1, b: { x: 2, y: 3 } },
		});
		const fingerprint =
			mocks.start.mock.calls[0]?.[1].workspaceLaunch.inputsFingerprint;
		mocks.start.mockResolvedValueOnce({
			status: "started",
			deduplicated: true,
			execution: {
				id: "execution-1",
			},
		});
		expect(
			await runWorkspaceWorkflowCommand(actor, {
				...run,
				inputs: { b: { y: 3, x: 2 }, a: 1 },
			}),
		).toMatchObject({ executionId: "execution-1", deduplicated: true });
		expect(
			mocks.start.mock.calls[1]?.[1].workspaceLaunch.inputsFingerprint,
		).toBe(fingerprint);
	});
	it("distinguishes different input payloads in the launch fingerprint", async () => {
		await runWorkspaceWorkflowCommand(actor, {
			...run,
			inputs: { text: "first" },
		});
		const first =
			mocks.start.mock.calls[0]?.[1].workspaceLaunch.inputsFingerprint;
		await runWorkspaceWorkflowCommand(actor, {
			...run,
			inputs: { text: "second" },
		});
		expect(
			mocks.start.mock.calls[1]?.[1].workspaceLaunch.inputsFingerprint,
		).not.toBe(first);
	});
	it("keeps history pagination bounded before touching storage", async () => {
		await expect(
			listWorkspaceWorkflowRunsCommand(actor, { ...read, limit: 21 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			listWorkspaceWorkflowRunsCommand(actor, { ...read, offset: 1001 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.history).not.toHaveBeenCalled();
	});
	it("does not bind after a current permission check is refused", async () => {
		mocks.permission.mockRejectedValueOnce(new Error("Permission denied"));
		await expect(
			bindWorkspaceWorkflowCommand(
				actor,
				{
					...read,
					expectedFrameUpdatedAt: stamp.toISOString(),
					expectedWorkflowUpdatedAt: stamp.toISOString(),
					action: "bind",
				},
				actor,
			),
		).rejects.toThrow("Permission denied");
		expect(mocks.mutate).not.toHaveBeenCalled();
	});
	it("does not bind live edits without republishing them", async () => {
		mocks.edit.mockResolvedValueOnce(
			workflow({ variables: { changed: true } }),
		);
		await expect(
			bindWorkspaceWorkflowCommand(
				actor,
				{
					...read,
					expectedFrameUpdatedAt: stamp.toISOString(),
					expectedWorkflowUpdatedAt: stamp.toISOString(),
					action: "bind",
				},
				actor,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.mutate).not.toHaveBeenCalled();
	});
	it("allows revocation after a workflow is paused and edited", async () => {
		mocks.edit.mockResolvedValueOnce(
			workflow({ status: "PAUSED", version: 3, nodes: [] }),
		);
		await bindWorkspaceWorkflowCommand(
			actor,
			{
				...read,
				expectedFrameUpdatedAt: stamp.toISOString(),
				expectedWorkflowUpdatedAt: stamp.toISOString(),
				action: "unbind",
			},
			actor,
		);
		expect(mocks.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "unbind",
				binding: expect.objectContaining({ status: "PAUSED" }),
			}),
		);
		expect(mocks.graph).not.toHaveBeenCalled();
	});
});
