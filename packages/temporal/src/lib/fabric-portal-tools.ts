/**
 * The Fabric portal tools Parlume's Fabric Agent may use in a meeting, and when
 * a turn needs their schemas.
 *
 * These are the gateway's platform tools: identity, organizations, projects,
 * features, tasks, bugs, documents, contexts, instructions, knowledge search,
 * workspaces, chats and connected servers, 38 in all. Fabric's agent runtime
 * reaches them only through an acting grant the web app mints for one
 * meeting's project, and the gateway holds that session to this list, to the
 * grant's organization and to that project. The worker offers the model the
 * same list, so each side checks the other. Pure and dependency-free, so the
 * web app, the worker and the workflow sandbox can all read it.
 *
 * The gateway test that reads its own platform tools fails when one is added
 * that is in none of these lists, so a new tool is either given to Parlume or
 * named in {@link FABRIC_PORTAL_EXCLUDED_TOOL_NAMES}, never silently left out.
 */

/**
 * The tools that act on a project and take a `projectId`, which the gateway
 * pins to the meeting's project (and fills in when the call leaves it out).
 */
export const FABRIC_PORTAL_PROJECT_TOOL_NAMES = [
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
 * The tools that have no project to pin: they answer for the person in the
 * grant's organization (who they are, which organizations, a new project, their
 * workspaces, chats and connected servers). The gateway holds them to that
 * user and organization, and refuses a switch to another organization.
 */
export const FABRIC_PORTAL_TENANT_TOOL_NAMES = [
	"fabric_get_identity",
	"fabric_list_organizations",
	"fabric_switch_organization",
	"fabric_create_project",
	"fabric_list_workspaces",
	"fabric_get_workspace",
	"fabric_query_workspace",
	"fabric_list_chats",
	"fabric_list_connected_servers",
] as const;

export const FABRIC_PORTAL_TOOL_NAMES: readonly string[] = [
	...FABRIC_PORTAL_PROJECT_TOOL_NAMES,
	...FABRIC_PORTAL_TENANT_TOOL_NAMES,
];

/**
 * The gateway's platform tools Parlume never gets, whatever its grant: the
 * three that manage delegated authority, and the memory and external project
 * connection reads, which have their own review path. Anything
 * the gateway adds belongs in this list or in the two above.
 */
export const FABRIC_PORTAL_EXCLUDED_TOOL_NAMES: readonly string[] = [
	"fabric_list_project_pm_assigned_items",
	"fabric_get_project_pm_item_snapshots",
	"fabric_list_project_pm_work_item_types",
	"fabric_get_project_pm_connection",
	"fabric_list_project_pm_members",
	"fabric_get_project_work_item_counts",
	"fabric_request_authority",
	"fabric_revoke_authority",
	"fabric_check_authority",
	"fabric_memory_targets",
	"fabric_memory_read",
	"fabric_memory_write",
	"fabric_memory_write_status",
];

const PORTAL_TOOLS: ReadonlySet<string> = new Set(FABRIC_PORTAL_TOOL_NAMES);
const PORTAL_PROJECT_TOOLS: ReadonlySet<string> = new Set(
	FABRIC_PORTAL_PROJECT_TOOL_NAMES,
);

/**
 * A `projectId` anywhere in a call's arguments, nested ones included (a
 * workflow preset names its project inside `preset`), that is not `projectId`,
 * or null. An empty one is "not named": the gateway fills in the meeting's own.
 */
export function foreignProjectId(
	value: unknown,
	projectId: string,
	depth = 0,
): string | null {
	if (depth > 8 || typeof value !== "object" || value === null) {
		return null;
	}
	for (const [key, entry] of Object.entries(value)) {
		if (key === "projectId" && typeof entry === "string") {
			if (entry !== "" && entry !== projectId) {
				return entry;
			}
			continue;
		}
		const found = foreignProjectId(entry, projectId, depth + 1);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

export function isFabricPortalTool(name: string): boolean {
	return PORTAL_TOOLS.has(name);
}

export function isFabricPortalProjectTool(name: string): boolean {
	return PORTAL_PROJECT_TOOLS.has(name);
}

/**
 * What a turn's words ask for that only the portal tools do: changing a
 * feature's status or a task, writing a document, a context or an
 * instruction, searching the project's knowledge, or reading a workspace. The
 * roadmap and document reads a plain question needs are already offered, so a
 * question such as "what's the status of F-12?" matches nothing here and does
 * not carry the portal schemas.
 */
const PORTAL_REQUEST_PATTERNS: readonly RegExp[] = [
	/\b(?:update|change|set|move|mark|close|reopen|complete|finish|assign|rename|edit|rewrite|add|create|write|draft|record|propose|file)\b[^.?!]{0,60}\b(?:status|task|subtask|to-?do|checklist|document|doc|docs|spec|context|instruction|instructions|lesson|decision|estimate|priority)\b/i,
	/\b(?:move|change|set|update|mark|put|flip)\b[^.?!]{0,60}\b(?:to|as)\s+(?:done|completed?|in progress|in review|ready(?: for dev)?|blocked|closed|open|backlog|published|declined)\b/i,
	/\b(?:mark|set)\b[^.?!]{0,40}\b(?:done|completed?|blocked|closed)\b/i,
	/\b(?:search|look up|find)\b[^.?!]{0,40}\b(?:knowledge|project knowledge|docs|documentation|documents|contexts?)\b/i,
	/\b(?:workspaces?|library|libraries)\b/i,
	/\b(?:coding )?instructions?\b|\blessons?\b/i,
	/\b(?:feature|task|subtask)\s+(?:history|versions?|decisions?)\b/i,
	/\b(?:which|what|list|show|open|archive|rename|update)\b[^.?!]{0,30}\bprojects\b|\b(?:create|start|set up)\b[^.?!]{0,30}\b(?:new )?project\b/i,
	/\b(?:organi[sz]ations?|who am i|which account|my (?:role|identity|account))\b/i,
	/\b(?:my|previous|recent|past|ai) chats?\b|\bchat history\b/i,
	/\b(?:connected|available) (?:servers?|integrations?|tools?)\b|\bmcp servers?\b/i,
];

export function needsFabricPortalTools(
	message: string,
	recentUserMessage?: string,
): boolean {
	return [message, recentUserMessage].some(
		(text) =>
			typeof text === "string" &&
			PORTAL_REQUEST_PATTERNS.some((pattern) => pattern.test(text)),
	);
}
