/**
 * The Fabric tools the gateway serves its own agent runtime and the page host:
 * the workflow tools, the frame tools, the tools a page keeps things with and
 * the version tools, as one list. Each tool's access and confirmation policy
 * come from its own definition. The chat engines offer their model the names
 * that are not `pageOnly` (the allowlist); the gateway serves them all. Pure and
 * zod-free, so the workflow sandbox can read the names and the worker everything
 * else.
 */

import { FABRIC_FRAME_TOOL_DEFINITIONS } from "./fabric-frame-tool-definitions";
import { FABRIC_FRAME_VERSION_TOOL_DEFINITIONS } from "./fabric-frame-version-tool-definitions";
import { FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS } from "./fabric-page-discovery-tool-definitions";
import { FABRIC_PAGE_TOOL_DEFINITIONS } from "./fabric-page-tool-definitions";
import { FABRIC_PROJECT_PM_TOOL_DEFINITIONS } from "./fabric-project-pm-tool-definitions";
import { FABRIC_PROJECT_READ_TOOL_DEFINITIONS } from "./fabric-project-read-tool-definitions";
import {
	callNeedsConfirmation,
	type FabricToolDefinition,
	toolAccess,
} from "./fabric-tool-definition";
import { FABRIC_WORKFLOW_TOOL_DEFINITIONS } from "./fabric-workflow-tool-definitions";

import { FABRIC_WORKSPACE_TOOL_DEFINITIONS } from "./fabric-workspace-tool-definitions";

export {
	DELIVERY_SOURCE_TOOL_NAMES,
	FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS,
} from "./fabric-delivery-source-tool-definitions";
export { FABRIC_DASHBOARD_TOOL_DEFINITIONS } from "./fabric-dashboard-tool-definitions";
export { FABRIC_WORKSPACE_TOOL_DEFINITIONS } from "./fabric-workspace-tool-definitions";

export const FABRIC_PROJECT_DELIVERY_TOOL_DEFINITIONS = [
	{
		name: "fabric_get_project_delivery",
		description:
			"Inspect bounded current project work, task and implementation outcomes, explicit source references and context processing health. PR merge is not deployment; external-agent costs and uncollected lead time remain unknown. Read-only; no source bodies, private runtime sessions or raw logs.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
			},
			required: ["projectId"],
			additionalProperties: false,
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
] as const satisfies readonly FabricToolDefinition[];

/** External/human reads only; deliberately excluded from native agent tool admission. */
export const FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS = [
	{
		name: "fabric_list_delivery_signals",
		description:
			"Browse source-backed work already saved in a project. Excludes incoming messages and pending proposals. Requires projects:read AND features:read plus current project/work-item access. Reuse cursor only with the same actor, project and filters.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["projectId"],
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
				source: {
					type: "string",
					enum: ["SLACK", "TEAMS", "JIRA", "AZURE_DEVOPS", "FIZZY"],
				},
				search: { type: "string", maxLength: 120 },
				limit: { type: "integer", minimum: 1, maximum: 50 },
				cursor: { type: "string", maxLength: 2048 },
			},
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "fabric_get_delivery_signal",
		description:
			"Read minimized metadata of one source-backed saved project work item. Requires projects:read AND features:read and current project/work-item access. No original message, transcript, proposal or external URL.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["projectId", "id"],
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
				id: { type: "string", minLength: 1, maxLength: 200 },
			},
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "fabric_get_delivery_signal_sources",
		description:
			"Inspect only your own matching saved source setup. Not a live connection/capture test. Requires projects:read, features:read AND integrations:read, current project/work-item access and organization integration-read permission. Shared/legacy unverified setup is excluded.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["projectId"],
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
			},
		},
		scope: "projects:read",
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
] as const satisfies readonly FabricToolDefinition[];

const implementationId = {
	type: "string",
	minLength: 1,
	maxLength: 200,
} as const;
const implementationIdentity = {
	projectId: implementationId,
	id: implementationId,
} as const;
/** Same native sessions and current actor grants as the Portal; no separate agent runtime. */
export const FABRIC_IMPLEMENTATION_TOOL_DEFINITIONS = [
	{
		name: "fabric_list_implementation_sessions",
		description:
			"List bounded project-visible implementation outcomes. A PR merge is not deployment; private runtime hosts, prompts and raw events are omitted.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: implementationId,
				storyId: implementationId,
				cursor: implementationId,
				limit: { type: "integer", minimum: 1, maximum: 50 },
			},
			required: ["projectId"],
		},
		scope: "agents:read",
		annotations: { readOnlyHint: true },
	},
	{
		name: "fabric_get_implementation_session",
		description:
			"Read a project's recorded implementation outcome, PR-merge evidence and explicit unknown deployment/cost. No private host or raw logs.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: implementationIdentity,
			required: ["projectId", "id"],
		},
		scope: "agents:read",
		annotations: { readOnlyHint: true },
	},
	{
		name: "fabric_start_implementation_session",
		description:
			"Start the existing durable CodingRun for an authorized ready work item using an already configured Fabric Agents server/Desktop connection. Requires stable requestId UUID; reuse it with identical input after a lost response. Changed input conflicts. Does not publish, merge or deploy code.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: implementationId,
				storyId: implementationId,
				taskId: { type: ["string", "null"] },
				requestId: { type: "string", format: "uuid" },
				kind: { type: "string", enum: ["IMPLEMENT", "SPIKE"] },
				spikeQuestion: {
					type: "string",
					minLength: 10,
					maxLength: 2000,
				},
				serverId: implementationId,
				llmConnection: { type: "string", minLength: 1, maxLength: 120 },
				model: implementationId,
				targetMachine: implementationId,
				fallbackPolicy: {
					type: "string",
					enum: [
						"subscription_harnesses",
						"org_paid_api",
						"pause_on_limit",
					],
				},
			},
			required: ["projectId", "storyId", "requestId"],
		},
		scope: "agents:execute",
		annotations: { readOnlyHint: false, idempotentHint: true },
		confirm: "always",
	},
	{
		name: "fabric_cancel_implementation_session",
		description:
			"Request cancellation of an existing authorized session through the native provider and Temporal workflow. Unknown remote outcomes remain active for inspection.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: implementationIdentity,
			required: ["projectId", "id"],
		},
		scope: "agents:execute",
		annotations: { readOnlyHint: false },
		confirm: "always",
	},
	{
		name: "fabric_follow_up_implementation_session",
		description:
			"Continue the existing session with a stable promptId UUID. Reuse identical promptId/message to recover the native receipt after a lost response. Legacy follow-ups have no durable receipt; inspect messages before deciding whether to retry an uncertain outcome. Requires current project edit and private/team server access; no replacement session.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...implementationIdentity,
				message: { type: "string", minLength: 1, maxLength: 4000 },
				promptId: { type: "string", format: "uuid" },
			},
			required: ["projectId", "id", "message", "promptId"],
		},
		scope: "agents:execute",
		annotations: { readOnlyHint: false, idempotentHint: false },
		confirm: "always",
	},
	{
		name: "fabric_get_implementation_messages",
		description:
			"Read up to 40 messages from an existing native session after current private/team server access is checked. Text is bounded; truncated is explicit. Never grants access to another developer's private server.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: implementationIdentity,
			required: ["projectId", "id"],
		},
		scope: "agents:read",
		annotations: { readOnlyHint: true },
	},
] as const satisfies readonly FabricToolDefinition[];

/** Reviewed company/client branding; source records remain separate from fetched suggestions. */
export const FABRIC_BRAND_TOOL_DEFINITIONS = [
	{
		name: "fabric_get_artifact_brand",
		description:
			"Read saved company and project-client branding before creating a proposal or client artifact. Company is prepared-by; client is prepared-for. Returns confirmed values, versions and missing client fields, never asset URLs. Provide projectId for a client's brand. Ask which visual brand to use and collect missing fields; never invent a logo or colors.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
			},
		},
		annotations: { readOnlyHint: true },
		scope: "projects:read",
	},
	{
		name: "fabric_update_company_brand",
		description:
			"Save reviewed company brand text, preserving logo, fonts and images. Requires expectedVersion from fabric_get_artifact_brand and current company administrator access plus explicit orgs:write scope. Website fetch suggestions must first be reviewed; this never fetches a site. Use Portal Brand kit for asset uploads.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				expectedVersion: { type: "integer", minimum: 0 },
				primaryColor: {
					type: ["string", "null"],
					pattern: "^#[0-9a-fA-F]{6}$",
				},
				accentColors: {
					type: "array",
					maxItems: 3,
					items: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
				},
				guidance: { type: ["string", "null"], maxLength: 2000 },
				website: { type: ["string", "null"], maxLength: 2048 },
			},
			required: ["expectedVersion"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
		},
		scope: "orgs:write",
		confirm: "always",
	},
	{
		name: "fabric_update_client_brand",
		description:
			"Save the reviewed name, website, colors, catalog fonts and cover style of this project's client for reusable branded proposals. Requires expectedVersion from fabric_get_artifact_brand (clientVersion is zero before first save). Preserves existing logo. Changes shared project branding; always review first. Use the Portal client-brand form to upload or confirm a logo.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
				expectedVersion: { type: "integer", minimum: 0 },
				name: { type: ["string", "null"], maxLength: 200 },
				website: { type: ["string", "null"], maxLength: 2048 },
				displayFontFamily: {
					type: ["string", "null"],
					enum: ["Inter", "Poppins", "JetBrains Mono", null],
				},
				bodyFontFamily: {
					type: ["string", "null"],
					enum: ["Inter", "Poppins", "JetBrains Mono", null],
				},
				coverStyle: {
					type: "string",
					enum: ["DARK", "LIGHT", "MINIMAL"],
				},
				colors: {
					type: "array",
					maxItems: 3,
					items: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
				},
			},
			required: [
				"projectId",
				"expectedVersion",
				"name",
				"website",
				"colors",
			],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
		},
		scope: "projects:write",
		confirm: "always",
	},
	{
		name: "fabric_get_proposal_style",
		description:
			"Read a Proposal's saved visual identity, cover treatment and presentation fields before editing them. Returns updatedAt for the reviewed save; null means no saved Style. Organization members with project access only.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
				documentId: { type: "string", minLength: 1, maxLength: 200 },
			},
			required: ["projectId", "documentId"],
		},
		annotations: { readOnlyHint: true },
		scope: "projects:read",
	},
	{
		name: "fabric_update_proposal_style",
		description:
			"Save reviewed visual branding and presentation for a Proposal. CLIENT uses the project's saved client fonts/colors/cover, COMPANY uses the company brand; author remains prepared-by. Null cover inherits the selected brand. Requires expectedUpdatedAt from fabric_get_proposal_style (null before first save). Omitted fields are preserved. Always review changes first; this does not export a PDF.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: { type: "string", minLength: 1, maxLength: 200 },
				documentId: { type: "string", minLength: 1, maxLength: 200 },
				expectedUpdatedAt: {
					type: ["string", "null"],
					format: "date-time",
				},
				brandSource: { type: "string", enum: ["COMPANY", "CLIENT"] },
				coverStyle: {
					type: ["string", "null"],
					enum: ["DARK", "LIGHT", "MINIMAL", null],
				},
				styleDirection: { type: ["string", "null"], maxLength: 500 },
				primaryColor: {
					type: ["string", "null"],
					pattern: "^#[0-9a-fA-F]{6}$",
				},
				accentColors: {
					type: "array",
					maxItems: 3,
					items: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
				},
				autoVisuals: { type: "boolean" },
			},
			required: ["projectId", "documentId", "expectedUpdatedAt"],
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
		},
		scope: "projects:write",
		confirm: "always",
	},
] as const satisfies readonly FabricToolDefinition[];
export type FabricBrandToolName =
	(typeof FABRIC_BRAND_TOOL_DEFINITIONS)[number]["name"];

export type FabricGatewayToolName =
	(typeof FABRIC_GATEWAY_TOOL_DEFINITIONS)[number]["name"];

export const FABRIC_GATEWAY_TOOL_DEFINITIONS = [
	...FABRIC_BRAND_TOOL_DEFINITIONS,
	...FABRIC_PROJECT_DELIVERY_TOOL_DEFINITIONS,
	...FABRIC_IMPLEMENTATION_TOOL_DEFINITIONS,
	...FABRIC_WORKSPACE_TOOL_DEFINITIONS,
	...FABRIC_PROJECT_READ_TOOL_DEFINITIONS,
	...FABRIC_PROJECT_PM_TOOL_DEFINITIONS,
	...FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS,
	...FABRIC_WORKFLOW_TOOL_DEFINITIONS,
	...FABRIC_FRAME_TOOL_DEFINITIONS,
	...FABRIC_PAGE_TOOL_DEFINITIONS,
	...FABRIC_FRAME_VERSION_TOOL_DEFINITIONS,
];

/** The names only a page's script has a use for, as a type. */
type PageOnlyToolName = Extract<
	(typeof FABRIC_GATEWAY_TOOL_DEFINITIONS)[number],
	{ pageOnly: true }
>["name"];

/** External clients carry explicit agent scopes. Native chat acting grants do not. */
type ExternalImplementationToolName =
	(typeof FABRIC_IMPLEMENTATION_TOOL_DEFINITIONS)[number]["name"];
const EXTERNAL_IMPLEMENTATION_TOOLS: ReadonlySet<string> = new Set(
	FABRIC_IMPLEMENTATION_TOOL_DEFINITIONS.map((tool) => tool.name),
);
export type FabricChatToolName = Exclude<
	FabricGatewayToolName,
	PageOnlyToolName | ExternalImplementationToolName
>;

/** Offer only tools the native acting grant can actually use. Execution controls
 * require a separately reviewed project-scoped approval grant before native exposure. */
export const FABRIC_CHAT_TOOL_DEFINITIONS =
	FABRIC_GATEWAY_TOOL_DEFINITIONS.filter(
		(tool): tool is typeof tool & { name: FabricChatToolName } =>
			!("pageOnly" in tool) &&
			!EXTERNAL_IMPLEMENTATION_TOOLS.has(tool.name),
	);

const BY_NAME: ReadonlyMap<string, FabricToolDefinition> = new Map(
	FABRIC_GATEWAY_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

const CHAT_TOOL_NAMES: ReadonlySet<string> = new Set(
	FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name),
);

/** The definition of a tool the gateway serves, or undefined for any other name. */
export function fabricGatewayTool(
	name: string,
): FabricToolDefinition | undefined {
	return BY_NAME.get(name);
}

export function isFabricGatewayTool(name: string): boolean {
	return BY_NAME.has(name);
}

/** Whether the chat engines offer this tool to their model. */
export function isFabricChatTool(name: string): boolean {
	return CHAT_TOOL_NAMES.has(name);
}

/** What a call to a gateway tool asks of the person, from the tool's own definition. */
export function gatewayCallNeedsConfirmation(
	name: string,
	args: Record<string, unknown>,
): boolean {
	const tool = BY_NAME.get(name);
	return tool !== undefined && callNeedsConfirmation(tool, args);
}

/** READ or WRITE, from the tool's own definition; WRITE for a name that is no gateway tool. */
export function gatewayToolAccess(name: string): "READ" | "WRITE" {
	const tool = BY_NAME.get(name);
	return tool ? toolAccess(tool) : "WRITE";
}

export {
	FABRIC_TRIAGE_TOOL_DEFINITIONS,
	TRIAGE_TOOL_NAMES,
} from "./fabric-triage-tool-definitions";
