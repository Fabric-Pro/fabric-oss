import { defineFabricTools } from "./fabric-tool-definition";

const projectId = { type: "string", minLength: 1, maxLength: 128 };
const requirementsAsOf = {
	type: "string",
	format: "date-time",
	maxLength: 512,
};

export const FABRIC_PROJECT_PM_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_project_pm_assigned_items",
		description:
			"Reads up to 50 directly assigned ADO item IDs, default User Story/current connection user. Reuse returned cursor with the same filters; complete=false is partial. requirementsAsOf pins snapshot reads. No hierarchy traversal.",
		inputSchema: {
			type: "object",
			properties: {
				projectId,
				assignee: {
					oneOf: [
						{
							type: "object",
							properties: { mode: { const: "current" } },
							required: ["mode"],
							additionalProperties: false,
						},
						{
							type: "object",
							properties: {
								mode: { const: "selected" },
								uniqueName: {
									type: "string",
									minLength: 1,
									maxLength: 512,
								},
							},
							required: ["mode", "uniqueName"],
							additionalProperties: false,
						},
					],
				},
				workItemTypes: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: { type: "string", minLength: 1, maxLength: 128 },
				},
				cursor: {
					type: "object",
					properties: {
						afterId: {
							type: "integer",
							minimum: 1,
							maximum: Number.MAX_SAFE_INTEGER,
						},
						requirementsAsOf,
					},
					required: ["afterId", "requirementsAsOf"],
					additionalProperties: false,
				},
			},
			required: ["projectId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
	},
	{
		name: "fabric_get_project_pm_item_snapshots",
		description:
			"Reads at most 10 ADO items: historical requirement fields plus separately captured current, versioned own comments. Use requirementsAsOf from assigned-items enumeration. Default fields include Description/AcceptanceCriteria; select Custom.BusinessRules when instructions require it. No parent/child comments. Incomplete/unreadIds and resultTruncated must be honored; result capped at 128 KiB, whole items omitted on overflow.",
		inputSchema: {
			type: "object",
			properties: {
				projectId,
				ids: {
					type: "array",
					minItems: 1,
					maxItems: 10,
					uniqueItems: true,
					items: {
						type: "integer",
						minimum: 1,
						maximum: Number.MAX_SAFE_INTEGER,
					},
				},
				requirementsAsOf,
				requirementFields: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: {
						type: "string",
						maxLength: 128,
						pattern:
							"^[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)+$",
					},
				},
			},
			required: ["projectId", "ids", "requirementsAsOf"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
	},
	{
		name: "fabric_list_project_pm_work_item_types",
		description:
			"Caller-connected ADO enabled type/reference names; complete=false:partial. Never inferred.",
		inputSchema: {
			type: "object",
			properties: { projectId },
			required: ["projectId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
		page: "asks-once",
	},
	{
		name: "fabric_get_project_pm_connection",
		description:
			"ADO target/caller connection; no network/credentials. Poll; Refresh only if status=ready.",
		inputSchema: {
			type: "object",
			properties: { projectId },
			required: ["projectId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
	},
	{
		name: "fabric_list_project_pm_members",
		description:
			"ADO team via caller connection, including zero assignments; assignee:uniqueName; complete=false:partial.",
		inputSchema: {
			type: "object",
			properties: { projectId },
			required: ["projectId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
		page: "asks-once",
	},
	{
		name: "fabric_get_project_work_item_counts",
		description:
			"Caller-connected ADO counts by exact state/optional assignee; incomplete:null, observed:lower bounds.",
		inputSchema: {
			type: "object",
			properties: {
				projectId,
				state: {
					type: "string",
					minLength: 1,
					maxLength: 128,
					default: "In Development",
				},
				assignee: {
					type: "string",
					minLength: 1,
					maxLength: 512,
					description: "uniqueName; omit for all assignees.",
				},
			},
			required: ["projectId"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
		page: "asks-once",
	},
]);

export type FabricProjectPmToolName =
	(typeof FABRIC_PROJECT_PM_TOOL_DEFINITIONS)[number]["name"];
