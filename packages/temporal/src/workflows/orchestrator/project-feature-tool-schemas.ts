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
		sort: {
			type: "string",
			enum: ["identifier", "updated"],
			default: "identifier",
			description:
				"identifier: numeric identifier order (default); updated: most recently updated first. Keep the same sort while paging.",
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

export const LEGACY_PROJECT_FEATURE_GET_INPUT_SCHEMA = {
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

/** Paged detail schema for new Advisor histories and activity-side tools. */
export const PROJECT_FEATURE_GET_INPUT_SCHEMA = {
	...LEGACY_PROJECT_FEATURE_GET_INPUT_SCHEMA,
	properties: {
		...LEGACY_PROJECT_FEATURE_GET_INPUT_SCHEMA.properties,
		section: {
			type: "string",
			enum: ["description", "acceptanceCriteria", "tasks"],
			description:
				"Omit for the fitted overview. Read a full section in pages by following truncations[].next.",
		},
		offset: {
			type: "integer",
			minimum: 0,
			description:
				"Character offset for description/acceptanceCriteria; task index for tasks. Requires section. Follow nextOffset.",
		},
	},
} as const satisfies Record<string, unknown>;

/** Short descriptions for the iterative loop's pre-registered copies. */
export const PROJECT_FEATURE_LIST_DESCRIPTION =
	"List the attached project's roadmap items (features and bugs) LIVE from Fabric — identifier (e.g. F-040), title, status, priority, drafting stage, task progress, updatedAt (ISO timestamp) and a short description. Use this instead of project_rag_query for what is on the roadmap, a feature's current status, or which features are in a status or priority. Filter by status name, priority, kind or search text; page with offset when hasMore is true. Lists what the roadmap shows — features AND bugs, excluding declined items, closed items only with includeHidden — ordered by identifier number by default (F-094 before F-100); sort=updated returns most recently updated first. Keep sort unchanged while paging. total counts that set and ALREADY excludes hidden items — report it as is, do not subtract hiddenCount (the closed items left out); summary states the counts in words. An item missing from this list may still exist (declined, or closed) — check with fabric_get_project_feature before saying it does not.";

// Retained byte-for-byte for histories without the paging marker.
export const LEGACY_PROJECT_FEATURE_GET_DESCRIPTION =
	"Read one feature (or bug) of the attached project LIVE from Fabric: full description, acceptance criteria, status, priority and every task with its completion. Pass the identifier the user mentions (e.g. 'F-040') or an id from fabric_list_project_features. A prefix is exact: 'F-001' never returns bug B-001 — when the item does not exist the tool says so. It also returns items the roadmap hides (declined, or closed); those exist, and onRoadmap=false with hiddenReason says why the roadmap does not show them.";

export const PROJECT_FEATURE_GET_DESCRIPTION =
	"Read one feature or bug of the attached project LIVE from Fabric: status, priority, drafting stage, description, acceptance criteria and task completion. The default call returns a fitted overview; long text and tasks arrive in pages. Follow truncations[].next by passing its section and offset with the same feature; section pages continue with nextOffset. Text offsets count Unicode characters and task offsets count tasks. Pass the user's identifier (for example F-040, B-002 or 40) or an id from fabric_list_project_features. A prefix is exact: 'F-001' matches F-001 or a feature numbered 1, never bug B-001; with no prefix a plain number is tried first, then F-, US-, B-. When nothing matches the tool returns an error — say the item does not exist rather than substituting another. Hidden or declined items can still be read; onRoadmap and hiddenReason explain their visibility.";
