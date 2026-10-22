import { FABRIC_AI_SERVER_CONFIG_ID } from "../../../workflows/orchestrator/fabric-catalog-access";

/** Tools whose orchestrator execution requires the run's attached project. */
export const PROJECT_TOOL_NAMES = [
	"weave_query",
	"fabric_create_story",
	"project_rag_query",
	"fabric_list_meeting_transcripts",
	"fabric_list_project_features",
	"fabric_get_project_feature",
	"fabric_list_project_documents",
	"fabric_get_project_document",
	"fabric_list_project_sources",
	"fabric_get_project_source",
	"fabric_list_architecture_decisions",
	"fabric_list_feature_decisions",
	"fabric_list_security_findings",
	"code_search",
	"code_file_get",
	"code_tree",
	"code_search_semantic",
	"search_slack_messages",
	"search_teams_messages",
] as const;

/** Names intercepted by the iterative loop before server routing. */
export const LOOP_DISPATCHED_PROJECT_TOOL_NAMES = [
	"project_rag_query",
	"fabric_list_meeting_transcripts",
	"search_slack_messages",
	"search_teams_messages",
] as const;

const loopDispatchedProjectToolNames = new Set<string>(
	LOOP_DISPATCHED_PROJECT_TOOL_NAMES,
);

const projectToolNames = new Set<string>(PROJECT_TOOL_NAMES);

/** Null means no attached project; omission preserves discovery without run context. */
export function isProjectToolHidden(
	toolName: string,
	projectId: string | null | undefined,
	configId?: string,
): boolean {
	return (
		projectId === null &&
		projectToolNames.has(toolName) &&
		(loopDispatchedProjectToolNames.has(toolName) ||
			!configId ||
			configId === FABRIC_AI_SERVER_CONFIG_ID)
	);
}
