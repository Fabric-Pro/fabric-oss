/**
 * A gateway session that is bound to ONE project.
 *
 * A connection made from a project's URL reaches that project and nothing
 * else, however many organizations and projects the person it acts for can
 * open. Three things hold it there, and this file is where each is decided:
 *
 *   - which platform tools such a session has at all. Every tool is classified
 *     below, and a tool that is in neither list is refused and fails the
 *     coverage test, so a new tool is organization-wide until someone decides
 *     otherwise and never project-safe by default;
 *   - which project a call names. `projectId` is optional on a bound session and
 *     defaults to the project; naming another one is answered as a project that
 *     does not exist;
 *   - which project a tool reaches when it names a feature, a document or a
 *     context and not a project. Those handlers resolve the project from the
 *     row and ask the project-access helpers about it, and the helpers ask
 *     {@link sessionMayReachProject}.
 *
 * Connected third-party servers are not offered or called: they are the
 * person's and the organization's, with no tie to a project and no scope check.
 */

import { FABRIC_FRAME_TOOL_DEFINITIONS } from "@repo/temporal/fabric-frame-tool-definitions";
import { FABRIC_FRAME_VERSION_TOOL_DEFINITIONS } from "@repo/temporal/fabric-frame-version-tool-definitions";
import { isFabricChatTool } from "@repo/temporal/fabric-gateway-tools";
import { FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS } from "@repo/temporal/fabric-page-discovery-tool-definitions";
import { FABRIC_PAGE_TOOL_DEFINITIONS } from "@repo/temporal/fabric-page-tool-definitions";
import {
	foreignProjectId,
	isFabricPortalProjectTool,
	isFabricPortalTool,
} from "@repo/temporal/fabric-portal-tools";
import { FABRIC_WORKFLOW_TOOL_DEFINITIONS } from "@repo/temporal/fabric-workflow-tool-definitions";
import type { GatewaySession, GatewayToolDefinition } from "./types";

/**
 * The platform tools a project-bound session may call. Each reads or writes
 * through a helper that answers for one project at a time, apart from the two
 * that describe the connection itself and are made to answer for the bound
 * project alone.
 */
export const PROJECT_BOUND_TOOL_NAMES = [
	"fabric_list_projects",
	"fabric_get_project",
	"fabric_get_project_pm_connection",
	"fabric_list_project_pm_members",
	"fabric_list_project_pm_work_item_types",
	"fabric_get_project_work_item_counts",
	"fabric_list_project_pm_assigned_items",
	"fabric_get_project_pm_item_snapshots",
	"fabric_update_project",
	"fabric_get_project_statuses",
	"fabric_list_features",
	"fabric_get_feature",
	"fabric_get_feature_decisions",
	"fabric_get_feature_versions",
	"fabric_update_feature_status",
	"fabric_complete_task",
	"fabric_create_feature_task",
	"fabric_create_bug",
	"fabric_create_feature",
	"fabric_update_task",
	"fabric_search_project_knowledge",
	"fabric_list_documents",
	"fabric_get_document",
	"fabric_create_document",
	"fabric_update_document",
	"fabric_list_project_contexts",
	"fabric_get_project_context",
	"fabric_update_project_context",
	"fabric_upsert_project_context",
	"fabric_list_project_instructions",
	"fabric_get_project_instruction",
	"fabric_get_project_instruction_bundle",
	"fabric_instruction_checks",
	"fabric_propose_project_instruction_change",
	"fabric_add_instruction_lesson",
	"fabric_memory_targets",
	"fabric_memory_read",
	"fabric_memory_write",
	"fabric_memory_write_status",
] as const;

/**
 * The platform tools a project-bound session does not have, because each one
 * is about the organization, a workspace, a workflow, the person's connected
 * servers or the session's own authority, and reaches past one project.
 */
export const PROJECT_BOUND_HIDDEN_TOOL_NAMES: readonly string[] = [
	"fabric_get_identity",
	"fabric_list_organizations",
	"fabric_switch_organization",
	"fabric_create_project",
	"fabric_list_workspaces",
	"fabric_get_workspace",
	"fabric_query_workspace",
	// The workflow, frame, version and page families: every tool of a family is organization-wide.
	...FABRIC_WORKFLOW_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_FRAME_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_FRAME_VERSION_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_PAGE_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS.map((tool) => tool.name),
	"fabric_list_chats",
	"fabric_list_connected_servers",
	"fabric_request_authority",
	"fabric_revoke_authority",
	"fabric_check_authority",
];

const PROJECT_BOUND_TOOLS: ReadonlySet<string> = new Set(
	PROJECT_BOUND_TOOL_NAMES,
);

const OPTIONAL_PROJECT_NOTE =
	" On this connection projectId is optional and defaults to the connected project.";

/** The project a session is bound to, or null for an organization-wide one. */
export function boundProjectId(
	session: Pick<GatewaySession, "projectId">,
): string | null {
	return session.projectId ?? null;
}

/**
 * The project a service session's grant is limited to, or null. A pinned
 * session is not a project connection ({@link boundProjectId} stays null): it
 * keeps the workflow, frame and workspace tools the agent runtime has always
 * had, and holds every call that reaches a project to this one.
 */
export function pinnedProjectId(
	session: Pick<GatewaySession, "pinnedProjectId">,
): string | null {
	return session.pinnedProjectId ?? null;
}

/**
 * Whether this session may act on `projectId`. An organization-wide session may
 * as far as its other checks say; a bound or pinned one only on its own project.
 */
export function sessionMayReachProject(
	session: Pick<
		GatewaySession,
		"projectId" | "pinnedProjectId" | "pageProjectId"
	>,
	projectId: string | null | undefined,
): boolean {
	const bound = boundProjectId(session);
	const pinned = pinnedProjectId(session);
	return (
		(bound === null || bound === projectId) &&
		(pinned === null || pinned === projectId) &&
		(session.pageProjectId === undefined ||
			session.pageProjectId === projectId)
	);
}

/**
 * What a pinned service session may call: the 38 portal tools the runtime is
 * offered, and the families it always held, none of which a project's grant
 * takes away. Everything else, the authority tools, the memory tools and the
 * page-only tools included, is refused here whatever scopes the session holds.
 * The page-only tools are served to a page in the browser, never to the
 * runtime, and `fabric_page_read_connected` would turn the grant's `mcp:read`
 * into a read of the inviter's connected servers.
 */
const PINNED_RUNTIME_FAMILY_TOOLS: ReadonlySet<string> = new Set([
	...FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_WORKFLOW_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_FRAME_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_FRAME_VERSION_TOOL_DEFINITIONS.map((tool) => tool.name),
	...FABRIC_PAGE_TOOL_DEFINITIONS.filter((tool) => !("pageOnly" in tool)).map(
		(tool) => tool.name,
	),
]);

export function pinnedSessionHasTool(toolName: string): boolean {
	return (
		isFabricPortalTool(toolName) ||
		PINNED_RUNTIME_FAMILY_TOOLS.has(toolName)
	);
}

/** A service read scope is not authority to call the gateway's other portal reads. */
export function serviceSessionHasTool(
	session: Pick<GatewaySession, "pinnedProjectId">,
	toolName: string,
): boolean {
	return pinnedProjectId(session) !== null
		? pinnedSessionHasTool(toolName)
		: isFabricChatTool(toolName) || toolName === "fabric_page_ask";
}

function withOptionalProjectId(
	tool: GatewayToolDefinition,
): GatewayToolDefinition {
	const { required, ...schema } = tool.inputSchema;
	if (!Array.isArray(required) || !required.includes("projectId")) {
		return tool;
	}
	const remaining = required.filter((name) => name !== "projectId");
	return {
		...tool,
		description: `${tool.description}${OPTIONAL_PROJECT_NOTE}`,
		inputSchema: {
			...schema,
			...(remaining.length > 0 ? { required: remaining } : {}),
		},
	};
}

/**
 * The tools a project-bound session is offered: the classified ones, with
 * `projectId` no longer required.
 */
export function projectBoundTools(
	definitions: GatewayToolDefinition[],
): GatewayToolDefinition[] {
	return definitions
		.filter((tool) => PROJECT_BOUND_TOOLS.has(tool.name))
		.map(withOptionalProjectId);
}

/**
 * The tools a pinned service session is offered: its portal and runtime-family
 * tools only, with `projectId` no longer required of the portal tools that take
 * one.
 */
export function pinnedSessionTools(
	definitions: GatewayToolDefinition[],
): GatewayToolDefinition[] {
	return definitions
		.filter((tool) => pinnedSessionHasTool(tool.name))
		.map((tool) =>
			isFabricPortalProjectTool(tool.name)
				? withOptionalProjectId(tool)
				: tool,
		);
}

export type BoundToolCall =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; message: string };

function bindPinnedCall(
	toolName: string,
	args: Record<string, unknown>,
	pinned: string,
): BoundToolCall {
	if (!pinnedSessionHasTool(toolName)) {
		return {
			ok: false,
			message: `${toolName} is not available to the agent runtime on a meeting's project.`,
		};
	}
	if (foreignProjectId(args, pinned) !== null) {
		return { ok: false, message: "Project not found or access denied" };
	}
	return isFabricPortalProjectTool(toolName) &&
		(args.projectId === undefined ||
			args.projectId === null ||
			args.projectId === "")
		? { ok: true, args: { ...args, projectId: pinned } }
		: { ok: true, args };
}

/**
 * What a tool call on this session may be. An organization-wide session's call
 * is its own. A bound session's call is refused for a tool it does not have and
 * for any project but its own, and defaults `projectId` to its own.
 */
export function bindToolCall(
	toolName: string,
	args: Record<string, unknown>,
	session: Pick<GatewaySession, "projectId" | "pinnedProjectId">,
): BoundToolCall {
	const bound = boundProjectId(session);
	if (bound === null) {
		const pinned = pinnedProjectId(session);
		return pinned === null
			? { ok: true, args }
			: bindPinnedCall(toolName, args, pinned);
	}
	if (!PROJECT_BOUND_TOOLS.has(toolName)) {
		return {
			ok: false,
			message: `${toolName} is not available on a connection to one project.`,
		};
	}
	const requested = args.projectId;
	if (requested !== undefined && requested !== null && requested !== "") {
		return requested === bound
			? { ok: true, args }
			: { ok: false, message: "Project not found or access denied" };
	}
	return { ok: true, args: { ...args, projectId: bound } };
}
