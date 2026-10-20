/**
 * Maps user-facing built-in tool keys (stored in
 * AgentTemplateInstance.toolConnections) to the Fabric AI tool IDs that
 * back them at runtime. Consumed by both template-mention search and any
 * agent runtime that needs to translate enabled built-in tools into the
 * concrete tool IDs to expose to the LLM.
 *
 * Lives apart from the agent-template queries, with no imports, so code that
 * only needs the keys (the workflow tool schemas the workflow sandbox reads)
 * can name them without loading Prisma. `agent-templates` re-exports it.
 */
export const BUILT_IN_TO_FABRIC_TOOLS: Record<string, string[]> = {
	"agent-memory": [],
	"create-frames": [
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_get_frame",
		"fabric_list_frames",
		"fabric_share_frame",
		"fabric_create_slideshow",
	],
	"create-images": ["fabric_generate_image"],
	"run-agent": [],
	"speech-generator": ["fabric_text_to_speech"],
	"web-search-browse": [
		"fabric_web_search",
		"fabric_search_and_analyze",
		"fabric_scrape_url",
		"fabric_scrape_and_analyze",
	],
	"web-search": [
		"fabric_web_search",
		"fabric_search_and_analyze",
		"fabric_scrape_url",
		"fabric_scrape_and_analyze",
	],
	search: ["workspace_rag_query", "workspace_rag_summarize"],
	"code-interpreter": ["fabric_code_interpreter"],
	"image-generation": ["fabric_generate_image"],
	// These ship under one capability on purpose: project_rag_query has no date
	// or status dimension, so an agent that can search project context but
	// cannot list meetings by date answers "was there a meeting on the 10th?"
	// from whatever the similarity sample happened to contain (Fizzy #2473),
	// and one without the live roadmap reads answers "what is In Review?" the
	// same way (Fizzy #2309) — as does one without the document and source
	// listings for "which documents does this project have?" (Fizzy #2578).
	"project-context": [
		"project_rag_query",
		"fabric_list_meeting_transcripts",
		"fabric_list_project_features",
		"fabric_get_project_feature",
		"fabric_list_project_documents",
		"fabric_get_project_document",
		"fabric_list_project_sources",
		"fabric_get_project_source",
	],
	"create-story": ["fabric_create_story"],
};
