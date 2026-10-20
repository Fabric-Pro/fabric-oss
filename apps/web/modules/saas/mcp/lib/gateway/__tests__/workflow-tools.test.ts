/**
 * The workflow tools of the Fabric MCP gateway.
 *
 * The commands behind them carry the tenancy and permission rules, build and
 * check the draft, and are tested where they live, in
 * `packages/api/modules/workflows/lib/__tests__`. These pin what the tools add:
 * how arguments map onto a command, what each tool makes of a command's
 * outcome (the draft a person is asked to confirm, what to do next), the
 * confirm marker, scopes and annotations, and that a refusal is an error
 * result written for a person.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/workflow-tools
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createFromPreset: vi.fn(),
	createFromGraph: vi.fn(),
	updateWithDraft: vi.fn(),
	describeWorkflowSchedule: vi.fn(),
	publishWorkflowCommand: vi.fn(),
	unpublishWorkflowCommand: vi.fn(),
	pauseWorkflowCommand: vi.fn(),
	resumeWorkflowCommand: vi.fn(),
	listWorkflowRunsCommand: vi.fn(),
	listWorkflowsCommand: vi.fn(),
	getWorkflowWithLatestRunCommand: vi.fn(),
	getWorkflowExecutionCommand: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	BUILT_IN_TO_FABRIC_TOOLS: { "project-context": ["project_rag_query"] },
}));

vi.mock("@repo/api/modules/workflows/lib/workflow-commands", () => ({
	publishWorkflowCommand: mocks.publishWorkflowCommand,
	unpublishWorkflowCommand: mocks.unpublishWorkflowCommand,
	pauseWorkflowCommand: mocks.pauseWorkflowCommand,
	resumeWorkflowCommand: mocks.resumeWorkflowCommand,
}));

vi.mock("@repo/api/modules/workflows/lib/workflow-draft-commands", () => ({
	createWorkflowFromPresetCommand: mocks.createFromPreset,
	createWorkflowFromGraphCommand: mocks.createFromGraph,
	updateWorkflowWithDraftCommand: mocks.updateWithDraft,
}));

vi.mock(
	"@repo/api/modules/workflows/lib/workflow-schedule-description",
	() => ({
		describeWorkflowSchedule: mocks.describeWorkflowSchedule,
	}),
);

vi.mock("@repo/api/modules/workflows/lib/workflow-execution-commands", () => ({
	startWorkflowExecutionCommand: vi.fn(),
	listWorkflowRunsCommand: mocks.listWorkflowRunsCommand,
}));

vi.mock("@repo/api/modules/workflows/lib/workflow-read-commands", () => ({
	listWorkflowsCommand: mocks.listWorkflowsCommand,
	getWorkflowWithLatestRunCommand: mocks.getWorkflowWithLatestRunCommand,
	getWorkflowExecutionCommand: mocks.getWorkflowExecutionCommand,
}));

import { WorkflowCommandError } from "@repo/api/modules/workflows/lib/workflow-command-context";
import { confirmationMeta } from "@repo/temporal/fabric-tool-definition";
import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
	TOOL_SCOPES,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const ORG = "org-example-a";
const PROJECT = "project-example-1";
const ACTOR = { userId: "user-1", organizationId: ORG };

function sessionWith(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		sessionId: "sess-1",
		userId: "user-1",
		organizationId: ORG,
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "service",
		scopes: [
			"workflows:read",
			"workflows:write",
			"workflows:run",
			"frames:read",
			"frames:write",
		],
		actingContext: { projectId: PROJECT },
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
		...overrides,
	};
}

function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

const PRESET = {
	name: "Weekly work item digest",
	cron: "0 9 * * 1",
	timezone: "Europe/Berlin",
	prompt: "Summarise the open work items for the project.",
	mcpServers: ["Example Tracker"],
	builtInToolNames: ["project-context"],
	outputTitle: "Weekly digest",
};

const DRAFT = {
	kind: "workflow" as const,
	name: "Weekly work item digest",
	description: null,
	schedule: {
		cron: "0 9 * * 1",
		timezone: "Europe/Berlin",
		description: "every Monday at 09:00 (Europe/Berlin)",
	},
	prompt: PRESET.prompt,
	mcpServers: [{ configId: "cfg-tracker", name: "Example Tracker" }],
	builtInTools: ["project-context"],
	project: { id: PROJECT, name: "Example Project" },
	outputTitle: "Weekly digest",
	outputFormat: "html",
	steps: [{ type: "trigger", label: "Schedule" }],
	problems: [] as string[],
};

const SCHEDULE = {
	cron: "0 9 * * 1",
	timezone: "UTC",
	description: "every Monday at 09:00 (UTC)",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createFromPreset.mockResolvedValue({ written: false, draft: DRAFT });
	mocks.createFromGraph.mockResolvedValue({ written: false, draft: DRAFT });
	mocks.updateWithDraft.mockResolvedValue({ written: false, draft: DRAFT });
	mocks.describeWorkflowSchedule.mockReturnValue(SCHEDULE);
});

describe("tool definitions", () => {
	const workflowTools = PLATFORM_TOOL_DEFINITIONS.filter((tool) =>
		/^fabric_(list|get|create|update|publish|unpublish|pause|resume|execute)_workflow/.test(
			tool.name,
		),
	);

	it("offers the whole workflow family", () => {
		expect(workflowTools.map((tool) => tool.name).sort()).toEqual([
			"fabric_create_workflow",
			"fabric_execute_workflow",
			"fabric_get_workflow",
			"fabric_get_workflow_execution",
			"fabric_list_workflow_runs",
			"fabric_list_workflows",
			"fabric_pause_workflow",
			"fabric_publish_workflow",
			"fabric_resume_workflow",
			"fabric_unpublish_workflow",
			"fabric_update_workflow",
		]);
	});

	it("marks every workflow write for confirmation on every call, and no read", () => {
		const marked = workflowTools
			.filter((tool) => tool._meta !== undefined)
			.map((tool) => [tool.name, tool._meta])
			.sort();

		expect(marked).toEqual(
			[
				"fabric_create_workflow",
				"fabric_execute_workflow",
				"fabric_pause_workflow",
				"fabric_publish_workflow",
				"fabric_resume_workflow",
				"fabric_unpublish_workflow",
				"fabric_update_workflow",
			].map((name) => [
				name,
				confirmationMeta({ name, confirm: "always" }),
			]),
		);
	});

	it("declares readOnlyHint on every read and not on any write", () => {
		for (const tool of workflowTools) {
			const isRead = TOOL_SCOPES[tool.name]?.kind === "read";
			expect(tool.annotations?.readOnlyHint === true).toBe(isRead);
			if (!isRead) {
				expect(tool.annotations?.destructiveHint).toBeDefined();
				expect(tool.annotations?.idempotentHint).toBeDefined();
			}
		}
	});

	it("holds reads to workflows:read, running to workflows:run and every other write to workflows:write", () => {
		for (const tool of workflowTools) {
			const required = TOOL_SCOPES[tool.name];
			const expected =
				required?.kind === "read"
					? "workflows:read"
					: tool.name === "fabric_execute_workflow"
						? "workflows:run"
						: "workflows:write";
			expect(required?.scope).toBe(expected);
		}
	});
});

describe("fabric_create_workflow with a preset", () => {
	it("returns the draft a person confirms, as the command built it", async () => {
		const result = await executePlatformTool(
			"fabric_create_workflow",
			{ preset: PRESET, dryRun: true },
			sessionWith(),
		);

		expect(result.isError).toBeFalsy();
		expect(payload(result)).toEqual({ draft: DRAFT });
	});

	it("hands the command the actor, the preset and the dry run", async () => {
		await executePlatformTool(
			"fabric_create_workflow",
			{ preset: PRESET, dryRun: true },
			sessionWith(),
		);

		expect(mocks.createFromPreset).toHaveBeenCalledExactlyOnceWith(ACTOR, {
			preset: expect.objectContaining({
				name: PRESET.name,
				cron: PRESET.cron,
				mcpServers: ["Example Tracker"],
			}),
			projectId: undefined,
			defaultProjectId: PROJECT,
			dryRun: true,
		});
		expect(mocks.createFromGraph).not.toHaveBeenCalled();
	});

	it("offers the project the chat was opened from as the default, and the call's own project as named", async () => {
		await executePlatformTool(
			"fabric_create_workflow",
			{ preset: PRESET, projectId: "project-named" },
			sessionWith({ actingContext: { projectId: "project-from-page" } }),
		);

		expect(mocks.createFromPreset.mock.calls[0][1]).toMatchObject({
			projectId: "project-named",
			defaultProjectId: "project-from-page",
		});
	});

	it("reports a created workflow with its problems and what to do next", async () => {
		mocks.createFromPreset.mockResolvedValue({
			written: true,
			draft: DRAFT,
			workflow: {
				id: "wf-new",
				name: PRESET.name,
				status: "DRAFT",
				triggerType: "SCHEDULE",
				projectId: PROJECT,
			},
		});

		const result = await executePlatformTool(
			"fabric_create_workflow",
			{ preset: PRESET },
			sessionWith(),
		);

		expect(payload(result)).toMatchObject({
			created: true,
			workflow: {
				id: "wf-new",
				status: "DRAFT",
				triggerType: "SCHEDULE",
			},
			problems: [],
			next: expect.stringContaining("fabric_publish_workflow"),
		});
	});

	it("tells the caller to fix the problems before publishing when there are some", async () => {
		mocks.createFromPreset.mockResolvedValue({
			written: true,
			draft: { ...DRAFT, problems: ["Schedule: too frequent"] },
			workflow: {
				id: "wf-new",
				name: PRESET.name,
				status: "DRAFT",
				triggerType: "SCHEDULE",
				projectId: null,
			},
		});

		const result = await executePlatformTool(
			"fabric_create_workflow",
			{ preset: PRESET },
			sessionWith(),
		);

		expect(payload(result)).toMatchObject({
			problems: ["Schedule: too frequent"],
			next: expect.stringContaining("fabric_update_workflow"),
		});
	});

	it("accepts the preset's own fields, such as the model and the iteration ceiling", async () => {
		await executePlatformTool(
			"fabric_create_workflow",
			{ preset: { ...PRESET, modelId: "model-x", maxIterations: 4 } },
			sessionWith(),
		);

		expect(mocks.createFromPreset.mock.calls[0][1].preset).toMatchObject({
			modelId: "model-x",
			maxIterations: 4,
		});
	});

	it("refuses a preset field the preset itself would refuse, naming it", async () => {
		const result = await executePlatformTool(
			"fabric_create_workflow",
			{ preset: { ...PRESET, maxIterations: 50 } },
			sessionWith(),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("preset.maxIterations");
		expect(mocks.createFromPreset).not.toHaveBeenCalled();
	});

	it("passes a refusal of the command through as an error", async () => {
		mocks.createFromPreset.mockRejectedValue(
			new WorkflowCommandError(
				"FORBIDDEN",
				"You do not have permission to create workflows in this organization",
			),
		);

		const result = await executePlatformTool(
			"fabric_create_workflow",
			{ preset: PRESET, dryRun: true },
			sessionWith(),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("permission");
	});

	it("names the connected servers that would work when one does not match", async () => {
		mocks.createFromPreset.mockRejectedValue(
			new WorkflowCommandError(
				"BAD_REQUEST",
				'No connected server matches "Nonexistent". Your connected servers: Example Tracker, Example Chat.',
			),
		);

		const result = await executePlatformTool(
			"fabric_create_workflow",
			{
				preset: { ...PRESET, mcpServers: ["Nonexistent"] },
				dryRun: true,
			},
			sessionWith(),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("Example Tracker");
	});

	it("refuses a session with no organization without asking the command", async () => {
		const result = await executePlatformTool(
			"fabric_create_workflow",
			{ preset: PRESET },
			sessionWith({ organizationId: null }),
		);

		expect(result.isError).toBe(true);
		expect(mocks.createFromPreset).not.toHaveBeenCalled();
	});
});

describe("fabric_create_workflow with a graph", () => {
	const GRAPH = {
		name: "Manual report",
		nodes: [{ id: "n1", type: "http-request", data: { label: "Call" } }],
		edges: [],
	};

	it("hands the command the nodes and edges, with no default project", async () => {
		await executePlatformTool(
			"fabric_create_workflow",
			GRAPH,
			sessionWith(),
		);

		expect(mocks.createFromGraph).toHaveBeenCalledExactlyOnceWith(ACTOR, {
			name: "Manual report",
			description: undefined,
			nodes: GRAPH.nodes,
			edges: [],
			projectId: undefined,
			dryRun: undefined,
		});
		expect(mocks.createFromPreset).not.toHaveBeenCalled();
	});

	it("refuses a call that sends both a preset and a graph, or neither", async () => {
		const both = await executePlatformTool(
			"fabric_create_workflow",
			{ ...GRAPH, preset: PRESET },
			sessionWith(),
		);
		const neither = await executePlatformTool(
			"fabric_create_workflow",
			{},
			sessionWith(),
		);

		expect(both.isError).toBe(true);
		expect(neither.isError).toBe(true);
		expect(mocks.createFromPreset).not.toHaveBeenCalled();
		expect(mocks.createFromGraph).not.toHaveBeenCalled();
	});
});

describe("fabric_update_workflow", () => {
	const WORKFLOW = {
		id: "wf-1",
		name: "Weekly work item digest",
		status: "DRAFT",
		triggerType: "SCHEDULE",
		projectId: PROJECT,
	};

	it("hands the command the workflow, the fields to change and the dry run", async () => {
		await executePlatformTool(
			"fabric_update_workflow",
			{
				workflowId: "wf-1",
				name: "Renamed",
				preset: { cron: "30 8 * * 1-5", mcpServers: ["Example Chat"] },
				dryRun: true,
			},
			sessionWith(),
		);

		expect(mocks.updateWithDraft).toHaveBeenCalledExactlyOnceWith(ACTOR, {
			workflowId: "wf-1",
			name: "Renamed",
			preset: { cron: "30 8 * * 1-5", mcpServers: ["Example Chat"] },
			dryRun: true,
		});
	});

	it("leaves a field the call omitted out of the preset, instead of filling in a default", async () => {
		await executePlatformTool(
			"fabric_update_workflow",
			{ workflowId: "wf-1", preset: { prompt: "A new prompt" } },
			sessionWith(),
		);

		expect(mocks.updateWithDraft.mock.calls[0][1].preset).toEqual({
			prompt: "A new prompt",
		});
	});

	it("shows the draft and writes nothing on a dry run", async () => {
		const result = await executePlatformTool(
			"fabric_update_workflow",
			{
				workflowId: "wf-1",
				preset: { cron: "30 8 * * 1-5" },
				dryRun: true,
			},
			sessionWith(),
		);

		expect(payload(result)).toEqual({ draft: DRAFT });
	});

	it("reports an update, and that a draft still has to be published", async () => {
		mocks.updateWithDraft.mockResolvedValue({
			written: true,
			draft: DRAFT,
			workflow: WORKFLOW,
			live: false,
		});

		const result = await executePlatformTool(
			"fabric_update_workflow",
			{ workflowId: "wf-1", preset: { prompt: "x" } },
			sessionWith(),
		);

		expect(payload(result)).toMatchObject({
			updated: true,
			workflow: { id: "wf-1" },
			next: expect.stringContaining("to put it on its schedule"),
		});
	});

	it("tells the caller to publish when the workflow is live", async () => {
		mocks.updateWithDraft.mockResolvedValue({
			written: true,
			draft: DRAFT,
			workflow: { ...WORKFLOW, status: "PUBLISHED" },
			live: true,
		});

		const result = await executePlatformTool(
			"fabric_update_workflow",
			{ workflowId: "wf-1", preset: { prompt: "x" } },
			sessionWith(),
		);

		expect(payload(result).next).toContain("fabric_publish_workflow");
		expect(payload(result).next).toContain("next run");
	});

	it("refuses to take both a preset and nodes", async () => {
		const result = await executePlatformTool(
			"fabric_update_workflow",
			{ workflowId: "wf-1", preset: { prompt: "x" }, nodes: [{}] },
			sessionWith(),
		);

		expect(result.isError).toBe(true);
		expect(mocks.updateWithDraft).not.toHaveBeenCalled();
	});

	it("answers the command's refusal as an error result", async () => {
		mocks.updateWithDraft.mockRejectedValue(
			new WorkflowCommandError("NOT_FOUND", "Workflow not found"),
		);

		const result = await executePlatformTool(
			"fabric_update_workflow",
			{ workflowId: "wf-other-org", dryRun: true },
			sessionWith(),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("Workflow not found");
	});
});

describe("publish, unpublish, pause and resume", () => {
	it("reports the problems that keep a workflow from going live", async () => {
		mocks.publishWorkflowCommand.mockResolvedValue({
			success: false,
			validation: {
				valid: false,
				errors: ["Agent Task: prompt — too small"],
				warnings: [],
			},
		});

		const result = await executePlatformTool(
			"fabric_publish_workflow",
			{ workflowId: "wf-1" },
			sessionWith(),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).problems).toEqual([
			"Agent Task: prompt — too small",
		]);
	});

	it("reports the version and the schedule outcome of a publish", async () => {
		mocks.publishWorkflowCommand.mockResolvedValue({
			success: true,
			version: 2,
			publishedAt: new Date(),
			schedule: { outcome: "created", cron: "0 9 * * 1" },
			validation: { valid: true, errors: [], warnings: ["a warning"] },
		});

		const result = await executePlatformTool(
			"fabric_publish_workflow",
			{ workflowId: "wf-1" },
			sessionWith(),
		);

		expect(payload(result)).toMatchObject({
			published: true,
			version: 2,
			schedule: { outcome: "created" },
			warnings: ["a warning"],
		});
		expect(mocks.publishWorkflowCommand).toHaveBeenCalledWith(ACTOR, {
			workflowId: "wf-1",
		});
	});

	it("pauses and resumes through the shared commands", async () => {
		mocks.pauseWorkflowCommand.mockResolvedValue({
			id: "wf-1",
			status: "PAUSED",
		});
		mocks.resumeWorkflowCommand.mockResolvedValue({
			id: "wf-1",
			status: "PUBLISHED",
		});

		const paused = await executePlatformTool(
			"fabric_pause_workflow",
			{ workflowId: "wf-1" },
			sessionWith(),
		);
		const resumed = await executePlatformTool(
			"fabric_resume_workflow",
			{ workflowId: "wf-1" },
			sessionWith(),
		);

		expect(payload(paused).status).toBe("PAUSED");
		expect(payload(resumed).status).toBe("PUBLISHED");
	});

	it("unpublishes to draft", async () => {
		mocks.unpublishWorkflowCommand.mockResolvedValue({
			success: true,
			message: "Workflow unpublished and reverted to draft status",
		});

		const result = await executePlatformTool(
			"fabric_unpublish_workflow",
			{ workflowId: "wf-1" },
			sessionWith(),
		);

		expect(payload(result).status).toBe("DRAFT");
	});

	it("is held to workflows:write: a read-only key cannot pause", async () => {
		const result = await executePlatformTool(
			"fabric_pause_workflow",
			{ workflowId: "wf-1" },
			sessionWith({
				credential: "personal-key",
				scopes: ["workflows:read"],
			}),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("workflows:write");
		expect(mocks.pauseWorkflowCommand).not.toHaveBeenCalled();
	});
});

describe("reads", () => {
	it("carries the page project into the canonical workflow read actor", async () => {
		mocks.listWorkflowsCommand.mockResolvedValue({
			workflows: [],
			total: 0,
			hasMore: false,
		});
		await executePlatformTool(
			"fabric_list_workflows",
			{},
			sessionWith({ pageProjectId: PROJECT }),
		);
		expect(mocks.listWorkflowsCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				...ACTOR,
				projectRestrictionId: PROJECT,
			}),
			expect.any(Object),
		);
	});
	const LISTED = {
		id: "wf-1",
		name: "Weekly report",
		description: null,
		status: "PUBLISHED",
		triggerType: "SCHEDULE",
		publishedAt: new Date(),
		projectId: PROJECT,
		createdAt: new Date(),
		updatedAt: new Date(),
		nodes: [{ id: "trigger" }],
	};

	it("lists the caller's workflows, filtering scheduled ones, with the schedule in words", async () => {
		mocks.listWorkflowsCommand.mockResolvedValue({
			workflows: [LISTED],
			total: 1,
			hasMore: false,
		});

		const result = await executePlatformTool(
			"fabric_list_workflows",
			{ scheduled: true },
			sessionWith(),
		);

		expect(mocks.listWorkflowsCommand).toHaveBeenCalledWith(
			ACTOR,
			expect.objectContaining({ triggerType: "SCHEDULE", limit: 20 }),
		);
		expect(mocks.describeWorkflowSchedule).toHaveBeenCalledWith(
			LISTED.nodes,
		);
		expect(payload(result).workflows[0].schedule.description).toBe(
			"every Monday at 09:00 (UTC)",
		);
	});

	it("does not filter by trigger type when scheduled workflows were not asked for", async () => {
		mocks.listWorkflowsCommand.mockResolvedValue({
			workflows: [],
			total: 0,
			hasMore: false,
		});

		await executePlatformTool("fabric_list_workflows", {}, sessionWith());

		expect(mocks.listWorkflowsCommand.mock.calls[0][1]).not.toHaveProperty(
			"triggerType",
		);
	});

	it("answers a refusal to list as an error", async () => {
		mocks.listWorkflowsCommand.mockRejectedValue(
			new WorkflowCommandError(
				"FORBIDDEN",
				"You do not have permission to read workflows in this organization",
			),
		);

		const result = await executePlatformTool(
			"fabric_list_workflows",
			{},
			sessionWith(),
		);

		expect(result.isError).toBe(true);
	});

	it("gets a workflow with its latest run", async () => {
		mocks.getWorkflowWithLatestRunCommand.mockResolvedValue({
			workflow: {
				...LISTED,
				edges: [],
				nodes: [],
			},
			latestRun: {
				id: "exec-9",
				status: "COMPLETED",
				startedAt: new Date(),
				completedAt: new Date(),
				durationMs: 1,
				error: null,
				frameId: "frame-1",
				output: null,
			},
		});

		const result = await executePlatformTool(
			"fabric_get_workflow",
			{ workflowId: "wf-1" },
			sessionWith(),
		);

		expect(mocks.getWorkflowWithLatestRunCommand).toHaveBeenCalledWith(
			ACTOR,
			"wf-1",
		);
		expect(payload(result).latestRun).toMatchObject({
			id: "exec-9",
			frameId: "frame-1",
		});
		expect(payload(result).schedule.description).toBe(
			"every Monday at 09:00 (UTC)",
		);
	});

	it("reports no latest run for a workflow that has not run", async () => {
		mocks.getWorkflowWithLatestRunCommand.mockResolvedValue({
			workflow: { ...LISTED, edges: [], nodes: [] },
			latestRun: null,
		});

		const result = await executePlatformTool(
			"fabric_get_workflow",
			{ workflowId: "wf-1" },
			sessionWith(),
		);

		expect(payload(result).latestRun).toBeNull();
	});

	it("refuses another organization's workflow with the command's own words", async () => {
		mocks.getWorkflowWithLatestRunCommand.mockRejectedValue(
			new WorkflowCommandError("NOT_FOUND", "Workflow not found"),
		);

		const result = await executePlatformTool(
			"fabric_get_workflow",
			{ workflowId: "wf-1" },
			sessionWith({ organizationId: "org-example-b" }),
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("Workflow not found");
	});

	it("lists runs for a workflow", async () => {
		mocks.listWorkflowRunsCommand.mockResolvedValue([]);

		const result = await executePlatformTool(
			"fabric_list_workflow_runs",
			{ workflowId: "wf-1", limit: 5 },
			sessionWith(),
		);

		expect(mocks.listWorkflowRunsCommand).toHaveBeenCalledWith(ACTOR, {
			workflowId: "wf-1",
			limit: 5,
		});
		expect(payload(result)).toEqual({ workflowId: "wf-1", runs: [] });
	});

	it("brings a run limit above 20 down to 20 instead of refusing it, since a page's script asked for it", async () => {
		mocks.listWorkflowRunsCommand.mockResolvedValue([]);

		const result = await executePlatformTool(
			"fabric_list_workflow_runs",
			{ workflowId: "wf-1", limit: 200 },
			sessionWith(),
		);

		expect(result.isError).toBeFalsy();
		expect(mocks.listWorkflowRunsCommand).toHaveBeenCalledWith(ACTOR, {
			workflowId: "wf-1",
			limit: 20,
		});
	});
});

describe("numeric bounds: what the tools advertise is what they accept", () => {
	const advertised = (toolName: string, property: string) => {
		const properties = PLATFORM_TOOL_DEFINITIONS.find(
			(tool) => tool.name === toolName,
		)?.inputSchema.properties as
			| Record<string, Record<string, unknown>>
			| undefined;
		return properties?.[property];
	};

	it("advertises the list limit's minimum and maximum", () => {
		expect(advertised("fabric_list_workflows", "limit")).toMatchObject({
			minimum: 1,
			maximum: 50,
		});
	});

	it("advertises the runs limit's minimum and maximum", () => {
		expect(advertised("fabric_list_workflow_runs", "limit")).toMatchObject({
			minimum: 1,
			maximum: 20,
		});
	});

	it("advertises the graph size the create and update tools accept", () => {
		for (const tool of [
			"fabric_create_workflow",
			"fabric_update_workflow",
		]) {
			expect(advertised(tool, "nodes")).toMatchObject({ maxItems: 100 });
			expect(advertised(tool, "edges")).toMatchObject({ maxItems: 300 });
		}
	});

	it("passes the largest advertised list limit through and brings a larger one down to it", async () => {
		mocks.listWorkflowsCommand.mockResolvedValue({
			workflows: [],
			total: 0,
			hasMore: false,
		});
		const max = (advertised("fabric_list_workflows", "limit")?.maximum ??
			0) as number;

		await executePlatformTool(
			"fabric_list_workflows",
			{ limit: max },
			sessionWith(),
		);
		const result = await executePlatformTool(
			"fabric_list_workflows",
			{ limit: max + 1000 },
			sessionWith(),
		);

		expect(result.isError).toBeFalsy();
		expect(
			mocks.listWorkflowsCommand.mock.calls.map(
				([, input]) => input.limit,
			),
		).toEqual([max, max]);
	});

	it("keeps a limit below the minimum at the minimum", async () => {
		mocks.listWorkflowsCommand.mockResolvedValue({
			workflows: [],
			total: 0,
			hasMore: false,
		});

		await executePlatformTool(
			"fabric_list_workflows",
			{ limit: 0 },
			sessionWith(),
		);

		expect(mocks.listWorkflowsCommand.mock.calls[0][1].limit).toBe(1);
	});

	it("still refuses a graph larger than the advertised size", async () => {
		const nodes = Array.from({ length: 101 }, (_, index) => ({
			id: `n${index}`,
		}));

		const result = await executePlatformTool(
			"fabric_create_workflow",
			{ name: "Big", nodes, edges: [] },
			sessionWith(),
		);

		expect(result.isError).toBe(true);
	});
});
