/** Browser-safe capability map. Kept aligned with the database map by its drift test. */
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
	// Keep in step with BUILT_IN_TO_FABRIC_TOOLS in
	// packages/database/prisma/queries/agent-templates.ts. This copy is what
	// builds `enabledFabricToolIds` for the request, and an id missing here is
	// simply never requested — no error, the tool just never fires (Fizzy #2473).
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
