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

import { defineFabricTools } from "./fabric-tool-definition";

export const WORKFLOW_STATUSES = [
	"DRAFT",
	"PUBLISHED",
	"ACTIVE",
	"PAUSED",
	"ARCHIVED",
] as const;

const WORKFLOW_ID = { workflowId: { type: "string" } } as const;

const BY_ID = {
	type: "object",
	properties: WORKFLOW_ID,
	required: ["workflowId"],
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
		name: "fabric_list_workflows",
		description: "Lists your workflows.",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", enum: [...WORKFLOW_STATUSES] },
				scheduled: { type: "boolean" },
				search: { type: "string" },
				limit: { type: "number" },
				offset: { type: "number" },
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
			properties: { ...WORKFLOW_ID, limit: { type: "number" } },
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
						builtInToolNames: {
							type: "array",
							items: { type: "string" },
						},
						outputTitle: { type: "string" },
						projectId: { type: "string" },
					},
					required: ["name", "cron", "prompt"],
				},
				name: { type: "string" },
				nodes: { type: "array" },
				edges: { type: "array" },
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
				preset: { type: "object" },
				nodes: { type: "array" },
				edges: { type: "array" },
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
