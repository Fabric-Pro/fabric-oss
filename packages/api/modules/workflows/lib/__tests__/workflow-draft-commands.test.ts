/**
 * Creating and editing a scheduled-agent workflow shows a draft first. The
 * draft is derived from the graph that would be saved, with the checks
 * publishing runs, so what a person confirms is what is stored. A dry run
 * writes nothing and refuses exactly where the real write would.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	canCreate: vi.fn(),
	canUpdate: vi.fn(),
	getWorkflowById: vi.fn(),
	createWorkflow: vi.fn(),
	updateWorkflow: vi.fn(),
	projectPlacement: vi.fn(),
	projectFindUnique: vi.fn(),
	ownMcpConfigIds: vi.fn(),
	listMcpRouting: vi.fn(),
	syncSchedule: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
	canCreateOrganizationWorkflows: mocks.canCreate,
	canUpdateOrganizationWorkflows: mocks.canUpdate,
	getWorkflowById: mocks.getWorkflowById,
	createWorkflow: mocks.createWorkflow,
	updateWorkflow: mocks.updateWorkflow,
	projectPlacementRefusal: mocks.projectPlacement,
	ownMcpConfigIds: mocks.ownMcpConfigIds,
	listMcpConfigRoutingForTenant: mocks.listMcpRouting,
	isWorkflowLive: (status: string) =>
		status === "PUBLISHED" || status === "ACTIVE",
	BUILT_IN_TO_FABRIC_TOOLS: { "project-context": [] },
}));

vi.mock("@repo/temporal", () => ({ findScheduleCron: () => null }));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => value,
	decryptApiKeyMaybe: (value: string | null) => value,
}));
vi.mock("../sync-workflow-schedule", () => ({
	syncWorkflowSchedule: mocks.syncSchedule,
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));

import { WorkflowCommandError } from "../workflow-command-context";
import {
	buildWorkflowDraft,
	createWorkflowFromGraphCommand,
	createWorkflowFromPresetCommand,
	updateWorkflowWithDraftCommand,
} from "../workflow-draft-commands";

const ORG = "org-example-a";
const USER = "user-1";
const actor = { userId: USER, organizationId: ORG };

const PRESET = {
	name: "Weekly work items",
	cron: "0 9 * * 1",
	timezone: "Europe/Berlin",
	prompt: "Summarise my open work items.",
	builtInToolNames: ["project-context"],
	projectId: "project-1",
};

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(WorkflowCommandError);
	return error as WorkflowCommandError;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.canCreate.mockResolvedValue(true);
	mocks.canUpdate.mockResolvedValue(true);
	mocks.projectPlacement.mockResolvedValue(null);
	mocks.projectFindUnique.mockResolvedValue({
		id: "project-1",
		name: "Example project",
	});
	mocks.ownMcpConfigIds.mockResolvedValue([]);
	mocks.listMcpRouting.mockResolvedValue([]);
	mocks.createWorkflow.mockImplementation(async (data: object) => ({
		id: "wf-new",
		status: "DRAFT",
		...data,
	}));
	mocks.updateWorkflow.mockImplementation(
		async (_id: string, _user: string, patch: object) => ({
			id: "wf-1",
			status: "DRAFT",
			...patch,
		}),
	);
	mocks.syncSchedule.mockResolvedValue({ outcome: "none", reason: "test" });
});

describe("buildWorkflowDraft", () => {
	async function presetGraph() {
		const { buildAgentTaskToFramePreset } = await import(
			"@repo/temporal/agentic-workflow-preset"
		);
		return buildAgentTaskToFramePreset({
			...PRESET,
			mcpConfigIds: ["mcp-1"],
			outputTitle: "Weekly status",
		});
	}

	it("describes the schedule in words, and what the agent is told and may use", async () => {
		mocks.ownMcpConfigIds.mockResolvedValue([
			{
				id: "mcp-1",
				enabled: true,
				displayName: "Tracker",
				mcpServer: null,
			},
		]);
		const graph = await presetGraph();

		const draft = await buildWorkflowDraft(actor, {
			name: "Weekly work items",
			nodes: graph.nodes,
			edges: graph.edges,
		});

		expect(draft).toMatchObject({
			kind: "workflow",
			name: "Weekly work items",
			schedule: { cron: "0 9 * * 1", timezone: "Europe/Berlin" },
			prompt: PRESET.prompt,
			builtInTools: ["project-context"],
			outputTitle: "Weekly status",
			outputFormat: "html",
			problems: [],
		});
		expect(draft.schedule?.description).toContain("Monday");
		expect(draft.project).toEqual({
			id: "project-1",
			name: "Example project",
		});
	});

	it("takes the servers from the publish checks instead of looking them up again", async () => {
		mocks.ownMcpConfigIds.mockResolvedValue([
			{
				id: "mcp-1",
				enabled: true,
				displayName: "Tracker",
				mcpServer: null,
			},
		]);
		const graph = await presetGraph();

		const draft = await buildWorkflowDraft(actor, {
			name: "x",
			nodes: graph.nodes,
			edges: graph.edges,
		});

		expect(draft.mcpServers).toEqual([
			{ configId: "mcp-1", name: "Tracker" },
		]);
		expect(mocks.ownMcpConfigIds).toHaveBeenCalledOnce();
		expect(mocks.listMcpRouting).not.toHaveBeenCalled();
	});

	it("says what would stop it going live, and leaves a project the owner may not use out", async () => {
		mocks.projectPlacement.mockResolvedValue("not_found");
		const graph = await presetGraph();

		const draft = await buildWorkflowDraft(actor, {
			name: "x",
			nodes: graph.nodes,
			edges: graph.edges,
		});

		expect(draft.project).toBeNull();
		expect(draft.problems.join("\n")).toContain("does not exist");
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
	});
});

describe("createWorkflowFromPresetCommand", () => {
	it("returns the draft and writes nothing on a dry run", async () => {
		const outcome = await createWorkflowFromPresetCommand(actor, {
			preset: PRESET,
			dryRun: true,
		});

		expect(outcome.written).toBe(false);
		expect(outcome.draft.name).toBe("Weekly work items");
		expect(mocks.createWorkflow).not.toHaveBeenCalled();
	});

	it("creates a scheduled draft workflow from the graph the preset builds", async () => {
		const outcome = await createWorkflowFromPresetCommand(actor, {
			preset: PRESET,
		});

		expect(outcome.written).toBe(true);
		const [created] = mocks.createWorkflow.mock.calls[0];
		expect(created).toMatchObject({
			name: "Weekly work items",
			triggerType: "SCHEDULE",
			userId: USER,
			organizationId: ORG,
			projectId: "project-1",
		});
		expect(
			created.nodes.map((node: { type: string }) => node.type),
		).toEqual(["trigger", "agent-task", "publish-frame"]);
	});

	it("names the page after the workflow when the title is left out", async () => {
		const outcome = await createWorkflowFromPresetCommand(actor, {
			preset: PRESET,
			dryRun: true,
		});

		expect(outcome.draft.outputTitle).toBe("Weekly work items");
	});

	it.each([
		[
			"the preset's own",
			{ projectId: "preset-project" },
			"arg",
			"default",
			"preset-project",
		],
		["the call's", {}, "arg-project", "default-project", "arg-project"],
		[
			"the one the caller is working in",
			{},
			undefined,
			"default-project",
			"default-project",
		],
	])(
		"puts the workflow in %s project",
		async (_label, presetProject, argProject, defaultProject, expected) => {
			const { projectId: _omit, ...withoutProject } = PRESET;

			const outcome = await createWorkflowFromPresetCommand(actor, {
				preset: { ...withoutProject, ...presetProject },
				projectId: argProject,
				defaultProjectId: defaultProject,
				dryRun: true,
			});

			expect(mocks.projectPlacement).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: expected }),
			);
			expect(outcome.written).toBe(false);
		},
	);

	it("resolves a server named the way people say it to the caller's own connection", async () => {
		mocks.listMcpRouting.mockResolvedValue([
			{
				id: "mcp-1",
				enabled: true,
				displayName: "Azure DevOps",
				mcpServer: { name: "azure-devops" },
			},
		]);
		mocks.ownMcpConfigIds.mockResolvedValue([
			{
				id: "mcp-1",
				enabled: true,
				displayName: "Azure DevOps",
				mcpServer: null,
			},
		]);

		const outcome = await createWorkflowFromPresetCommand(actor, {
			preset: { ...PRESET, mcpServers: ["azure devops"] },
			dryRun: true,
		});

		expect(outcome.draft.mcpServers).toEqual([
			{ configId: "mcp-1", name: "Azure DevOps" },
		]);
	});

	it("refuses a server name that matches nothing, listing the ones that would work", async () => {
		mocks.listMcpRouting.mockResolvedValue([
			{
				id: "mcp-1",
				enabled: true,
				displayName: "Tracker",
				mcpServer: null,
			},
		]);

		const error = await refusal(
			createWorkflowFromPresetCommand(actor, {
				preset: { ...PRESET, mcpServers: ["Nonexistent"] },
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain(
			'No connected server matches "Nonexistent"',
		);
		expect(error.message).toContain("Tracker");
	});

	it("refuses a server name that matches several", async () => {
		mocks.listMcpRouting.mockResolvedValue([
			{ id: "a", enabled: true, displayName: "Tracker", mcpServer: null },
			{ id: "b", enabled: true, displayName: "tracker", mcpServer: null },
		]);

		const error = await refusal(
			createWorkflowFromPresetCommand(actor, {
				preset: { ...PRESET, mcpServers: ["Tracker"] },
			}),
		);

		expect(error.message).toContain("Several connected servers match");
	});

	it("refuses an invalid preset, naming the field", async () => {
		const error = await refusal(
			createWorkflowFromPresetCommand(actor, {
				preset: { ...PRESET, maxIterations: 50 },
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain("preset.maxIterations");
	});

	it("refuses an actor who may not create workflows before building any draft", async () => {
		mocks.canCreate.mockResolvedValue(false);

		const error = await refusal(
			createWorkflowFromPresetCommand(actor, {
				preset: PRESET,
				dryRun: true,
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.ownMcpConfigIds).not.toHaveBeenCalled();
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
	});

	it("asks who may create once for a real create", async () => {
		await createWorkflowFromPresetCommand(actor, { preset: PRESET });

		expect(mocks.canCreate).toHaveBeenCalledOnce();
		expect(mocks.membership).toHaveBeenCalledOnce();
	});
});

describe("createWorkflowFromGraphCommand", () => {
	const graph = {
		name: "Manual run",
		nodes: [
			{
				id: "trigger",
				type: "trigger",
				data: { config: { triggerType: "manual" } },
			},
		],
		edges: [],
	};

	it("creates a manually triggered workflow when the graph has no schedule", async () => {
		await createWorkflowFromGraphCommand(actor, graph);

		expect(mocks.createWorkflow.mock.calls[0][0]).toMatchObject({
			triggerType: "MANUAL",
		});
	});

	it("creates a scheduled one when the trigger carries a cron", async () => {
		await createWorkflowFromGraphCommand(actor, {
			...graph,
			nodes: [
				{
					id: "trigger",
					type: "trigger",
					data: {
						config: {
							triggerType: "schedule",
							scheduleCron: "0 9 * * 1",
						},
					},
				},
			],
		});

		expect(mocks.createWorkflow.mock.calls[0][0]).toMatchObject({
			triggerType: "SCHEDULE",
		});
	});

	it("writes nothing on a dry run", async () => {
		const outcome = await createWorkflowFromGraphCommand(actor, {
			...graph,
			dryRun: true,
		});

		expect(outcome.written).toBe(false);
		expect(mocks.createWorkflow).not.toHaveBeenCalled();
	});
});

describe("updateWorkflowWithDraftCommand", () => {
	async function stored(overrides: Record<string, unknown> = {}) {
		const { buildAgentTaskToFramePreset } = await import(
			"@repo/temporal/agentic-workflow-preset"
		);
		const graph = buildAgentTaskToFramePreset({
			...PRESET,
			outputTitle: "Weekly status",
		});
		return {
			id: "wf-1",
			name: "Weekly work items",
			description: null,
			userId: USER,
			organizationId: ORG,
			projectId: "project-1",
			status: "DRAFT",
			nodes: graph.nodes,
			edges: graph.edges,
			...overrides,
		};
	}

	beforeEach(async () => {
		mocks.getWorkflowById.mockResolvedValue(await stored());
	});

	it("applies a preset patch to the stored graph and saves it", async () => {
		await updateWorkflowWithDraftCommand(actor, {
			workflowId: "wf-1",
			preset: { prompt: "A new brief.", cron: "0 8 * * 5" },
		});

		const [id, user, patch, org] = mocks.updateWorkflow.mock.calls[0];
		expect([id, user, org]).toEqual(["wf-1", USER, ORG]);
		const agent = patch.nodes.find(
			(node: { type: string }) => node.type === "agent-task",
		);
		expect(agent.data.config.prompt).toBe("A new brief.");
		expect(patch.nodes[0].data.config.scheduleCron).toBe("0 8 * * 5");
	});

	it("shows what the change would make, and writes nothing, on a dry run", async () => {
		const outcome = await updateWorkflowWithDraftCommand(actor, {
			workflowId: "wf-1",
			preset: { prompt: "A new brief." },
			dryRun: true,
		});

		expect(outcome.written).toBe(false);
		expect(outcome.draft.prompt).toBe("A new brief.");
		expect(mocks.updateWorkflow).not.toHaveBeenCalled();
	});

	it("reads the workflow once, however many questions the edit asks", async () => {
		await updateWorkflowWithDraftCommand(actor, {
			workflowId: "wf-1",
			preset: { prompt: "A new brief." },
		});

		expect(mocks.getWorkflowById).toHaveBeenCalledOnce();
		expect(mocks.membership).toHaveBeenCalledOnce();
		expect(mocks.canUpdate).toHaveBeenCalledOnce();
	});

	it("resolves servers named in the patch to connection ids", async () => {
		mocks.listMcpRouting.mockResolvedValue([
			{
				id: "mcp-1",
				enabled: true,
				displayName: "Tracker",
				mcpServer: null,
			},
		]);

		await updateWorkflowWithDraftCommand(actor, {
			workflowId: "wf-1",
			preset: { mcpServers: ["Tracker"] },
			dryRun: true,
		});

		expect(mocks.ownMcpConfigIds).toHaveBeenCalledWith(
			["mcp-1"],
			expect.objectContaining({ userId: USER }),
		);
	});

	it("refuses a preset change on a graph without the step it belongs to", async () => {
		mocks.getWorkflowById.mockResolvedValue(await stored({ nodes: [] }));

		const error = await refusal(
			updateWorkflowWithDraftCommand(actor, {
				workflowId: "wf-1",
				preset: { prompt: "A new brief." },
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain("no agent step");
		expect(mocks.updateWorkflow).not.toHaveBeenCalled();
	});

	it("keeps the stored name and project in the draft when only the graph changes", async () => {
		const outcome = await updateWorkflowWithDraftCommand(actor, {
			workflowId: "wf-1",
			preset: { outputTitle: "Friday digest" },
			dryRun: true,
		});

		expect(outcome.draft).toMatchObject({
			name: "Weekly work items",
			outputTitle: "Friday digest",
			project: { id: "project-1" },
		});
	});

	it("refuses an actor without the permission to edit, before building a draft", async () => {
		mocks.canUpdate.mockResolvedValue(false);

		const error = await refusal(
			updateWorkflowWithDraftCommand(actor, {
				workflowId: "wf-1",
				preset: { prompt: "x" },
				dryRun: true,
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.ownMcpConfigIds).not.toHaveBeenCalled();
	});
});
