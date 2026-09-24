/**
 * Project document and Context-tab source read tool schemas — pure data,
 * imported by the activity-side Fabric catalog, the shared implementation
 * and the workflow-side pre-registration in the iterative loop, so the three
 * cannot describe different arguments. Workflow-sandbox safe.
 */

export const PROJECT_DOCUMENT_TYPES = [
	"GENERAL",
	"BUSINESS_CASE",
	"DESIGN_SYSTEM",
	"PRD",
	"PROPOSAL",
	"ARCHITECTURE",
	"TECHNICAL_SPEC",
	"USER_STORY",
	"API_SPEC",
	"QA_STRATEGY",
	"TEST_PLAN",
	"TEST_REPORT",
	"TRACEABILITY_MATRIX",
	"SRS",
	"INTEGRATION_CONTRACT",
] as const;

export const PROJECT_SOURCE_TYPES = [
	"FILE",
	"LINK",
	"TEXT",
	"DOCUMENT",
	"TECH_STACK",
	"FEATURES",
	"GOALS",
	"DESCRIPTION",
	"IMAGE",
	"SPREADSHEET",
	"INTEGRATION",
	"MEETING_TRANSCRIPT",
	"SLACK_HUDDLE_NOTES",
	"CODE_FILE",
	"CODE_FILE_SUMMARY",
	"ARCHITECTURE_DECISION",
	"TEST_CASE",
	"API_SPEC",
] as const;

const PAGING_PROPERTIES = {
	limit: {
		type: "number",
		description: "Maximum items to return (1-100, default 25).",
	},
	offset: {
		type: "number",
		description: "Items to skip, for paging (default 0).",
	},
} as const;

const BODY_PAGING_PROPERTIES = {
	offset: {
		type: "number",
		description:
			"Character offset to start reading from (default 0). When a response says truncated, pass its nextOffset to read the next part.",
	},
	maxLength: {
		type: "number",
		description:
			"Maximum characters of body text to return (1-40000, default 15000).",
	},
} as const;

export const PROJECT_DOCUMENT_LIST_INPUT_SCHEMA = {
	type: "object",
	properties: {
		type: {
			type: "string",
			enum: [...PROJECT_DOCUMENT_TYPES],
			description:
				"Filter by document type (e.g. 'PRD', 'TECHNICAL_SPEC', 'ARCHITECTURE'). Omit to list every type.",
		},
		search: {
			type: "string",
			description: "Case-insensitive text to match in the title.",
		},
		...PAGING_PROPERTIES,
	},
	required: [],
} as const satisfies Record<string, unknown>;

export const PROJECT_DOCUMENT_GET_INPUT_SCHEMA = {
	type: "object",
	properties: {
		document: {
			type: "string",
			description:
				"The document's id from fabric_list_project_documents, or its exact title.",
		},
		...BODY_PAGING_PROPERTIES,
	},
	required: ["document"],
} as const satisfies Record<string, unknown>;

export const PROJECT_SOURCE_LIST_INPUT_SCHEMA = {
	type: "object",
	properties: {
		type: {
			type: "string",
			enum: [...PROJECT_SOURCE_TYPES],
			description:
				"Filter to one source type: 'FILE'/'DOCUMENT'/'SPREADSHEET'/'IMAGE' for uploads, 'LINK' for web links, 'TEXT' for pasted notes, 'MEETING_TRANSCRIPT' for synced meetings, 'INTEGRATION' for connected sources. Omit to list every type except repository code-index entries.",
		},
		search: {
			type: "string",
			description:
				"Case-insensitive text to match in the title, file name or URL.",
		},
		includeCodeContexts: {
			type: "boolean",
			description:
				"Include repository code-index entries (CODE_FILE, CODE_FILE_SUMMARY) in an unfiltered listing (default false). There are usually thousands; prefer code_search for code.",
		},
		...PAGING_PROPERTIES,
	},
	required: [],
} as const satisfies Record<string, unknown>;

export const PROJECT_SOURCE_GET_INPUT_SCHEMA = {
	type: "object",
	properties: {
		source: {
			type: "string",
			description: "The source's id from fabric_list_project_sources.",
		},
		...BODY_PAGING_PROPERTIES,
	},
	required: ["source"],
} as const satisfies Record<string, unknown>;

export const PROJECT_DOCUMENT_LIST_DESCRIPTION =
	"List the attached project's documents (the Documents tab: PRDs, technical specs, architecture docs, proposals, test plans and more) LIVE from Fabric — id, title, type, status, version and dates. Use this — never project_rag_query — for which documents exist, how many there are, or to find the PRD before reading it; the list is exact, never a sample. Filter by type or title text; page with offset when hasMore is true. total counts every matching document across all pages; summary states it in words — report it as is. Read one with fabric_get_project_document.";

export const PROJECT_DOCUMENT_GET_DESCRIPTION =
	"Read one document of the attached project LIVE from Fabric: title, type, status, version and its full text. Pass an id from fabric_list_project_documents or the exact title. Long documents come in parts: when truncated is true, call again with offset set to nextOffset. contentAvailable=false means there is no text yet — unavailableReason says why (e.g. still generating).";

export const PROJECT_SOURCE_LIST_DESCRIPTION =
	"List the attached project's Context-tab sources LIVE from Fabric — uploaded files, web links, pasted notes, meeting transcripts and connected-integration sources — with id, title, kind, type, file name or URL, and dates. Use this — never project_rag_query — for which files, links or sources the project has, or how many; the list is exact, never a sample. Repository code-index entries are excluded by default (summary says how many). Filter by type or text; page with offset when hasMore is true. Read one with fabric_get_project_source.";

export const PROJECT_SOURCE_GET_DESCRIPTION =
	"Read one Context-tab source of the attached project LIVE from Fabric: the extracted text of an uploaded file, the crawled text of a link, a pasted note, a meeting transcript or a captured conversation. Pass an id from fabric_list_project_sources. Long sources come in parts: when truncated is true, call again with offset set to nextOffset. contentAvailable=false means there is no text to read — unavailableReason says why; do not report the source as empty.";

/**
 * Appended to project_rag_query's description wherever the list tools are
 * bound: semantic search returns a similarity sample, never an inventory.
 */
export const PROJECT_RAG_QUERY_LISTING_HINT =
	"It returns a similarity sample, never a complete list: for which documents, files, links or sources the project has — or how many — call fabric_list_project_documents or fabric_list_project_sources instead, and read one in full with fabric_get_project_document or fabric_get_project_source.";
