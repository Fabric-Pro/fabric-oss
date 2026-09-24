/**
 * Project roadmap read tool schemas — pure data, imported by both the
 * activity-side Fabric catalog and the workflow-side pre-registration in the
 * iterative loop, so the two cannot describe different arguments.
 * Workflow-sandbox safe.
 */

export const PROJECT_FEATURE_LIST_INPUT_SCHEMA = {
	type: "object",
	properties: {
		status: {
			type: "string",
			description:
				"Status column name, case-insensitive (e.g. 'Backlog', 'In Progress', 'In Review', 'Done'). Omit for all statuses.",
		},
		priority: {
			type: "string",
			enum: ["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"],
			description: "Filter by priority (P0_CRITICAL highest).",
		},
		kind: {
			type: "string",
			enum: ["FEATURE", "BUG"],
			description: "Filter by work-item type. Omit to return both.",
		},
		search: {
			type: "string",
			description:
				"Text to match in title, description or identifier (e.g. 'F-040').",
		},
		includeHidden: {
			type: "boolean",
			description:
				"Include closed items, which the roadmap hides until 'Show hidden' is on (default false). Declined items are never listed.",
		},
		limit: {
			type: "number",
			description: "Maximum items to return (1-100, default 25).",
		},
		offset: {
			type: "number",
			description: "Items to skip, for paging (default 0).",
		},
	},
	required: [],
} as const satisfies Record<string, unknown>;

export const PROJECT_FEATURE_GET_INPUT_SCHEMA = {
	type: "object",
	properties: {
		feature: {
			type: "string",
			description:
				"Identifier exactly as the user wrote it (e.g. 'F-040', 'B-002', '40') or an id from fabric_list_project_features.",
		},
	},
	required: ["feature"],
} as const satisfies Record<string, unknown>;

/** Short descriptions for the iterative loop's pre-registered copies. */
export const PROJECT_FEATURE_LIST_DESCRIPTION =
	"List the attached project's roadmap items (features and bugs) LIVE from Fabric — identifier (e.g. F-040), title, status, priority, drafting stage, task progress and a short description. Use this — never project_rag_query — for what is on the roadmap, a feature's current status, or which features are in a status or priority. Filter by status name, priority, kind or search text; page with offset when hasMore is true. Lists what the roadmap shows — features AND bugs, declined items never, closed items only with includeHidden — ordered by identifier number (F-094 before F-100). total counts that set; hiddenCount counts the closed items left out.";

export const PROJECT_FEATURE_GET_DESCRIPTION =
	"Read one feature (or bug) of the attached project LIVE from Fabric: full description, acceptance criteria, status, priority and every task with its completion. Pass the identifier the user mentions (e.g. 'F-040') or an id from fabric_list_project_features. A prefix is exact: 'F-001' never returns bug B-001 — when the item does not exist the tool says so.";
