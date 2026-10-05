/**
 * Project repository read tool schemas (`code_tree`, `code_file_get`,
 * `code_search`) — pure data, imported by the activity-side Fabric catalog
 * and the workflow-side pre-registration in the iterative loop, so the two
 * cannot describe different arguments. Workflow-sandbox safe.
 */

export const CODE_SEARCH_DESCRIPTION =
	"Search the project's connected repositories for code matching a query. Returns file paths and matched snippets. " +
	"If the project has multiple repositories connected, searches across all of them. " +
	"Use this to find specific functions, classes, patterns, or implementations in the codebase.";

export const CODE_SEARCH_INPUT_SCHEMA = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description:
				"Search query — use specific terms, function names, or patterns",
		},
		path: {
			type: "string",
			description:
				"Filter results to a specific directory path (e.g., 'src/auth')",
		},
		language: {
			type: "string",
			description:
				"Filter by programming language (e.g., 'typescript', 'python')",
		},
		repo: {
			type: "string",
			description:
				"Filter to one of the project's indexed repositories by name, owner/name (e.g., 'acme/backend') or URL. When the conversation names the repository the user is viewing (a 'Repository URL' line), pass it here unless the user asks about another repository. Omit to search all connected repos.",
		},
	},
	required: ["query"],
} as const satisfies Record<string, unknown>;

export const CODE_FILE_GET_DESCRIPTION =
	"Fetch the full content of a specific file from the project's connected repositories by its path. " +
	"Use after code_search to read the full source of a relevant file. " +
	"If multiple repos are connected and no repo is specified, tries each repo until the file is found.";

export const CODE_FILE_GET_INPUT_SCHEMA = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description:
				"File path relative to repository root (e.g., 'src/auth/middleware.ts')",
		},
		repo: {
			type: "string",
			description:
				"Target repository in owner/name format (e.g., 'acme/backend'). Omit to search all connected repos.",
		},
	},
	required: ["path"],
} as const satisfies Record<string, unknown>;

export const CODE_TREE_DESCRIPTION =
	"List the directory tree of the project's connected repositories — paths only, not file contents. Useful for understanding the project structure. " +
	"Large trees come in pages: the result says which entries it shows and how to fetch the next ones. " +
	"For an overview, pass depth: 1 to list only the top-level files and folders (or a directory's own), with a count of the entries below each folder that has any. " +
	"If multiple repos are connected, lists structure from all repos unless a specific one is specified.";

export const CODE_TREE_INPUT_SCHEMA = {
	type: "object",
	properties: {
		directory: {
			type: "string",
			description:
				"Filter to a specific directory (e.g., 'src/components'). Omit for full tree.",
		},
		repo: {
			type: "string",
			description:
				"Target repository in owner/name format (e.g., 'acme/backend'). Omit to list all connected repos.",
		},
		depth: {
			type: "number",
			description:
				"How many levels below the directory (or the repository root) to list: 1 lists only its own files and folders. Omit to list every level.",
		},
		offset: {
			type: "number",
			description:
				"Number of entries to skip (default 0). A listing larger than one page says which entries it shows and gives the offset for the next page; pass it here to continue.",
		},
	},
	required: [],
} as const satisfies Record<string, unknown>;

/** The repository reads the loop pre-registers for a project chat. */
export const PROJECT_REPOSITORY_TOOLS = [
	{
		name: "code_tree",
		description: CODE_TREE_DESCRIPTION,
		inputSchema: CODE_TREE_INPUT_SCHEMA,
	},
	{
		name: "code_file_get",
		description: CODE_FILE_GET_DESCRIPTION,
		inputSchema: CODE_FILE_GET_INPUT_SCHEMA,
	},
	{
		name: "code_search",
		description: CODE_SEARCH_DESCRIPTION,
		inputSchema: CODE_SEARCH_INPUT_SCHEMA,
	},
] as const;
