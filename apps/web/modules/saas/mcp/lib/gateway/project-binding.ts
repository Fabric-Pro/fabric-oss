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
] as const;

/**
 * The platform tools a project-bound session does not have, because each one
 * is about the organization, a workspace, a workflow, the person's connected
 * servers or the session's own authority, and reaches past one project.
 */
export const PROJECT_BOUND_HIDDEN_TOOL_NAMES = [
	"fabric_get_identity",
	"fabric_list_organizations",
	"fabric_switch_organization",
	"fabric_create_project",
	"fabric_list_workspaces",
	"fabric_get_workspace",
	"fabric_query_workspace",
	"fabric_list_workflows",
	"fabric_get_workflow",
	"fabric_execute_workflow",
	"fabric_get_workflow_execution",
	"fabric_list_chats",
	"fabric_create_frame",
	"fabric_update_frame",
	"fabric_get_frame",
	"fabric_list_frames",
	"fabric_share_frame",
	"fabric_create_slideshow",
	"fabric_list_connected_servers",
	"fabric_request_authority",
	"fabric_revoke_authority",
	"fabric_check_authority",
] as const;

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
 * Whether this session may act on `projectId`. An organization-wide session may
 * as far as its other checks say; a bound one only on its own project.
 */
export function sessionMayReachProject(
	session: Pick<GatewaySession, "projectId">,
	projectId: string,
): boolean {
	const bound = boundProjectId(session);
	return bound === null || bound === projectId;
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

export type BoundToolCall =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; message: string };

/**
 * What a tool call on this session may be. An organization-wide session's call
 * is its own. A bound session's call is refused for a tool it does not have and
 * for any project but its own, and defaults `projectId` to its own.
 */
export function bindToolCall(
	toolName: string,
	args: Record<string, unknown>,
	session: Pick<GatewaySession, "projectId">,
): BoundToolCall {
	const bound = boundProjectId(session);
	if (bound === null) {
		return { ok: true, args };
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
