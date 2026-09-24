/**
 * Which chat tools only read — pure data, workflow-sandbox safe.
 *
 * The Fabric catalog adapter (activity side) routes and authorizes catalog
 * tools by the access level declared here, and the iterative loop's risk
 * gate (workflow side) uses the same declaration to skip keyword scanning of
 * a read. One list: a tool cannot be a READ to the adapter and a possible
 * delete to the approval gate. The adapter itself cannot be imported by the
 * workflow — it lazily loads activity modules.
 */

type AccessLevel = "READ" | "WRITE";

/** Catalog tools the adapter runs through Direct chat's tool builders. */
export const FABRIC_CATALOG_DIRECT_BUILDER_ACCESS: Record<string, AccessLevel> =
	{
		code_search: "READ",
		fabric_create_story: "WRITE",
		fabric_list_meeting_transcripts: "READ",
		fabric_list_project_features: "READ",
		fabric_get_project_feature: "READ",
		fabric_list_project_documents: "READ",
		fabric_get_project_document: "READ",
		fabric_list_project_sources: "READ",
		fabric_get_project_source: "READ",
		fabric_text_to_speech: "READ",
	};

/** Catalog tools the adapter runs through a plan-mode step handler. */
export const FABRIC_CATALOG_STEP_HANDLER_ACCESS: Record<string, AccessLevel> = {
	weave_query: "READ",
	code_file_get: "READ",
	code_tree: "READ",
	code_search_semantic: "READ",
	fabric_list_architecture_decisions: "READ",
	fabric_list_feature_decisions: "READ",
	fabric_list_security_findings: "READ",
	fabric_youtube_transcript: "READ",
	fabric_analyze_youtube: "READ",
	fabric_youtube_metadata: "READ",
	fabric_youtube_comments: "READ",
	fabric_youtube_playlist: "READ",
	fabric_list_patterns: "READ",
	fabric_transcribe_audio: "READ",
	fabric_readability: "READ",
	fabric_template: "READ",
	fabric_list_strategies: "READ",
	fabric_get_strategy: "READ",
	fabric_list_contexts: "READ",
	fabric_get_context: "READ",
	fabric_asana_create_task: "WRITE",
	fabric_asana_list_tasks: "READ",
	fabric_attio_create_record: "WRITE",
	fabric_attio_search_records: "READ",
	fabric_front_create_conversation: "WRITE",
	fabric_front_list_conversations: "READ",
	fabric_canva_list_designs: "READ",
};

/** The virtual config id the loop records for a Fabric catalog tool. */
export const FABRIC_AI_SERVER_CONFIG_ID = "fabric-ai-server";

/**
 * Reads the iterative loop runs itself, dispatched by name before any MCP
 * lookup: semantic search, tool discovery, the date-ordered meeting listing
 * and the live Slack/Teams message searches. A same-named tool on a user's
 * MCP server never runs in place of these.
 */
const LOOP_BUILT_IN_READ_TOOLS = new Set([
	"project_rag_query",
	"workspace_rag_query",
	"workspace_rag_summarize",
	"search_tools",
	"search_slack_messages",
	"search_teams_messages",
	"fabric_list_meeting_transcripts",
]);

/** Whether the loop runs this tool itself rather than through MCP. */
export function isLoopBuiltInReadTool(name: string): boolean {
	return LOOP_BUILT_IN_READ_TOOLS.has(name);
}

/**
 * Whole-word verbs that make a name a write wherever they sit, so a pattern
 * below never exempts `fabric_get_or_create_page` or `search_and_replace`.
 */
const MUTATING_NAME_TOKENS = new Set([
	"create",
	"update",
	"delete",
	"remove",
	"upsert",
	"upload",
	"send",
	"write",
	"move",
	"insert",
	"replace",
	"publish",
	"push",
	"submit",
	"archive",
	"assign",
	"edit",
	"close",
	"cancel",
	"set",
	"add",
	"reset",
	"clear",
	"purge",
	"drop",
	"revoke",
	"share",
]);

/**
 * Name shapes that are reads by construction in Fabric's own catalog: every
 * `*_rag_query`, and `fabric_list_*` / `fabric_get_*`.
 */
const READ_NAME_PATTERNS = [/^[a-z0-9_]+_rag_query$/, /^fabric_(list|get)_/];

function nameTokens(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * Whether a call is a Fabric-owned read, so its arguments are never scanned
 * for "destructive" words: a search for "unclear risks" or "items removed
 * from scope" is still a search.
 *
 * `fabricRouted` is where the loop will send the call — one of its own
 * built-ins, or the Fabric catalog's virtual config — and the caller must
 * know it, not guess it from the name. A same-named tool on any other MCP
 * server is not Fabric's to vouch for and gets the normal scan.
 */
export function isFabricOwnedRead(
	name: string,
	fabricRouted: boolean,
): boolean {
	if (!fabricRouted) {
		return false;
	}
	if (
		FABRIC_CATALOG_DIRECT_BUILDER_ACCESS[name] === "READ" ||
		FABRIC_CATALOG_STEP_HANDLER_ACCESS[name] === "READ" ||
		LOOP_BUILT_IN_READ_TOOLS.has(name)
	) {
		return true;
	}
	if (!READ_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
		return false;
	}
	return !nameTokens(name).some((token) => MUTATING_NAME_TOKENS.has(token));
}
