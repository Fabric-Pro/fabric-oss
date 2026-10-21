/**
 * What Fabric tells a client about its workflow tools: names, descriptions,
 * input schemas, annotations, the scope each needs and when a call needs the
 * person's yes. One list, read by the Fabric MCP gateway (which serves it), by
 * the Orchestrator's tool catalogue (which indexes it so a chat can find the
 * tools) and by the workflow sandbox (which only needs the names), so none of
 * them can describe a tool differently. Pure data with no zod, which the
 * workflow bundle keeps out, importable by the web app through
 * `@repo/temporal/fabric-workflow-tool-definitions`.
 *
 * Kept lean on purpose — a gateway client may resend every definition on every
 * request — so how to schedule, confirm and explain belongs in the
 * "Automations & pages" skill, not in these descriptions. The `preset` schema
 * is the model-visible part of `AgentTaskToFramePresetSchema`; a test pins every
 * property of it to a key of that schema.
 *
 * Every write asks for every call: a workflow runs unattended as the person,
 * so each create, edit, publish, unpublish, pause, resume and run is theirs to
 * allow.
 */

import {
	AGENT_TASK_CAPABILITY_KEYS,
	describeAgentTaskCapabilities,
} from "./agent-task-capabilities";
import { defineFabricTools } from "./fabric-tool-definition";

export const WORKFLOW_STATUSES = [
	"DRAFT",
	"PUBLISHED",
	"ACTIVE",
	"PAUSED",
	"ARCHIVED",
] as const;

/**
 * The numeric bounds the workflow tools hold their arguments to. Both the JSON
 * schema below and the gateway's zod schema read them, so what a client is
 * told is what the gateway accepts. A `limit` above `max` is brought down to
 * it (the way the frame and page tools treat theirs) instead of refused, since
 * a page's script is written by a model and a refusal breaks the page.
 */
export const WORKFLOW_LIST_LIMIT = { min: 1, max: 50, default: 20 } as const;
export const WORKFLOW_RUNS_LIMIT = { min: 1, max: 20, default: 10 } as const;
export const WORKFLOW_GRAPH_LIMITS = { nodes: 100, edges: 300 } as const;

const GRAPH_NODES = {
	type: "array",
	maxItems: WORKFLOW_GRAPH_LIMITS.nodes,
} as const;
const GRAPH_EDGES = {
	type: "array",
	maxItems: WORKFLOW_GRAPH_LIMITS.edges,
} as const;

const WORKFLOW_ID = { workflowId: { type: "string" } } as const;

const BY_ID = {
	type: "object",
	properties: WORKFLOW_ID,
	required: ["workflowId"],
} as const;

/**
 * The data and tools a scheduled agent may be given. The agent runs unattended
 * and has none unless this names them, so a model that leaves it out, or passes
 * tool names where these keys belong, publishes a page built from nothing.
 */
const BUILT_IN_TOOL_NAMES = {
	type: "array",
	items: { type: "string", enum: [...AGENT_TASK_CAPABILITY_KEYS] },
	description: `What the agent may use: ${describeAgentTaskCapabilities()}.`,
} as const;

/** The same keys on an edit, which does not repeat what each grants. */
const BUILT_IN_TOOL_NAMES_UPDATE = {
	type: "array",
	items: BUILT_IN_TOOL_NAMES.items,
	description: "As in fabric_create_workflow.",
} as const;

const READ = { readOnlyHint: true } as const;

const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
} as const;

const IDEMPOTENT_WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
} as const;

export const FABRIC_WORKFLOW_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_bind_workspace_workflow",
		description:
			"Bind a published workflow or revoke its binding to an owned Workspace in the same project. Pass current timestamps.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				frameId: { type: "string", minLength: 1, maxLength: 128 },
				workflowId: { type: "string", minLength: 1, maxLength: 128 },
				action: { type: "string", enum: ["bind", "unbind"] },
				expectedFrameUpdatedAt: { type: "string", format: "date-time" },
				expectedWorkflowUpdatedAt: {
					type: "string",
					format: "date-time",
				},
			},
			required: [
				"frameId",
				"workflowId",
				"action",
				"expectedFrameUpdatedAt",
				"expectedWorkflowUpdatedAt",
			],
		},
		annotations: WRITE,
		scope: "workflows:write",
		confirm: "always",
	},
	{
		name: "fabric_list_workflows",
		description: "Lists your workflows.",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", enum: [...WORKFLOW_STATUSES] },
				scheduled: { type: "boolean" },
				search: { type: "string" },
				limit: {
					type: "integer",
					minimum: WORKFLOW_LIST_LIMIT.min,
					maximum: WORKFLOW_LIST_LIMIT.max,
					default: WORKFLOW_LIST_LIMIT.default,
				},
				offset: { type: "integer", minimum: 0 },
			},
		},
		annotations: READ,
		scope: "workflows:read",
	},
	{
		name: "fabric_get_workflow",
		description: "Gets a workflow with its schedule and latest run.",
		inputSchema: BY_ID,
		annotations: READ,
		scope: "workflows:read",
	},
	{
		name: "fabric_list_workflow_runs",
		description: "Lists a workflow's recent runs.",
		inputSchema: {
			type: "object",
			properties: {
				...WORKFLOW_ID,
				limit: {
					type: "integer",
					minimum: WORKFLOW_RUNS_LIMIT.min,
					maximum: WORKFLOW_RUNS_LIMIT.max,
					default: WORKFLOW_RUNS_LIMIT.default,
				},
			},
			required: ["workflowId"],
		},
		annotations: READ,
		scope: "workflows:read",
	},
	{
		name: "fabric_get_workflow_execution",
		description: "Gets one run's status and result.",
		inputSchema: {
			type: "object",
			properties: { executionId: { type: "string" } },
			required: ["executionId"],
		},
		annotations: READ,
		scope: "workflows:read",
	},
	{
		name: "fabric_execute_workflow",
		description: "Starts a published workflow now, whatever its trigger.",
		inputSchema: {
			type: "object",
			properties: { ...WORKFLOW_ID, inputs: { type: "object" } },
			required: ["workflowId"],
		},
		annotations: WRITE,
		scope: "workflows:run",
		confirm: "always",
	},
	{
		name: "fabric_create_workflow",
		description:
			"Creates a draft workflow from a `preset` (scheduled agent that publishes a page) or `nodes` and `edges`. `dryRun` writes nothing.",
		inputSchema: {
			type: "object",
			properties: {
				preset: {
					type: "object",
					properties: {
						name: { type: "string" },
						cron: { type: "string" },
						timezone: { type: "string" },
						prompt: { type: "string" },
						mcpServers: {
							type: "array",
							items: { type: "string" },
						},
						builtInToolNames: BUILT_IN_TOOL_NAMES,
						modelId: {
							type: "string",
							description:
								"Optional AI model ID for the agent task.",
						},
						outputTitle: { type: "string" },
						projectId: { type: "string" },
					},
					required: ["name", "cron", "prompt"],
				},
				name: { type: "string" },
				nodes: GRAPH_NODES,
				edges: GRAPH_EDGES,
				projectId: { type: "string" },
				dryRun: { type: "boolean" },
			},
		},
		annotations: WRITE,
		scope: "workflows:write",
		confirm: "always",
	},
	{
		name: "fabric_update_workflow",
		description:
			"Edits a workflow: a `preset` with the fields to change, or `nodes` and `edges`. `dryRun` writes nothing.",
		inputSchema: {
			type: "object",
			properties: {
				...WORKFLOW_ID,
				name: { type: "string" },
				preset: {
					type: "object",
					properties: {
						cron: { type: "string" },
						timezone: { type: "string" },
						prompt: { type: "string" },
						mcpServers: {
							type: "array",
							items: { type: "string" },
						},
						builtInToolNames: BUILT_IN_TOOL_NAMES_UPDATE,
						modelId: {
							type: "string",
							description: "AI model ID for the agent task.",
						},
						outputTitle: { type: "string" },
						projectId: { type: "string" },
					},
				},
				nodes: GRAPH_NODES,
				edges: GRAPH_EDGES,
				dryRun: { type: "boolean" },
			},
			required: ["workflowId"],
		},
		annotations: { ...IDEMPOTENT_WRITE, destructiveHint: true },
		scope: "workflows:write",
		confirm: "always",
	},
	{
		name: "fabric_publish_workflow",
		description: "Publishes a workflow and starts its schedule.",
		inputSchema: BY_ID,
		annotations: WRITE,
		scope: "workflows:write",
		confirm: "always",
	},
	{
		name: "fabric_unpublish_workflow",
		description: "Reverts a workflow to draft and stops its schedule.",
		inputSchema: BY_ID,
		annotations: IDEMPOTENT_WRITE,
		scope: "workflows:write",
		confirm: "always",
	},
	{
		name: "fabric_pause_workflow",
		description: "Pauses a published workflow's schedule.",
		inputSchema: BY_ID,
		annotations: IDEMPOTENT_WRITE,
		scope: "workflows:write",
		confirm: "always",
	},
	{
		name: "fabric_resume_workflow",
		description: "Resumes a paused workflow's schedule.",
		inputSchema: BY_ID,
		annotations: IDEMPOTENT_WRITE,
		scope: "workflows:write",
		confirm: "always",
	},
]);

export type FabricWorkflowToolName =
	(typeof FABRIC_WORKFLOW_TOOL_DEFINITIONS)[number]["name"];

/**
 * What the person's yes to a created workflow also covers, for that workflow
 * only: putting it on its schedule and one run now. Both chat engines read
 * this one list, and the approval each shows says so.
 */
export const CREATE_WORKFLOW_FOLLOW_UPS = [
	"fabric_publish_workflow",
	"fabric_execute_workflow",
] as const satisfies readonly FabricWorkflowToolName[];

const CREATE_FOLLOW_UP_NAMES: ReadonlySet<string> = new Set(
	CREATE_WORKFLOW_FOLLOW_UPS,
);

function isEmptyObject(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 0
	);
}

/**
 * A Fabric call's arguments as what it does rather than how the model spelled
 * it: a run started with empty `inputs` is the run started with none (it
 * starts on `inputs ?? {}`). Nothing else is folded together.
 */
export function canonicalFabricCallArgs(
	toolName: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	return toolName === "fabric_execute_workflow" && isEmptyObject(args.inputs)
		? Object.fromEntries(
				Object.entries(args).filter(([key]) => key !== "inputs"),
			)
		: args;
}

/**
 * Whether a call is one of the follow-ups a created workflow's approval
 * covers, for that workflow: publishing it, or running it with no inputs.
 */
export function isCreateFollowUpCall(
	toolName: string,
	args: Record<string, unknown>,
	workflowId: string,
): boolean {
	if (!CREATE_FOLLOW_UP_NAMES.has(toolName)) {
		return false;
	}
	const canonical = canonicalFabricCallArgs(toolName, args);
	return (
		Object.keys(canonical).length === 1 &&
		canonical.workflowId === workflowId
	);
}
