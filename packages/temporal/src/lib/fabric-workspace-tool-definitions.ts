/** Document Workspace reads shared by Portal MCP, Genie, Loom, and the omnipresent agent. */
import { defineFabricTools } from "./fabric-tool-definition";

export const FABRIC_WORKSPACE_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_workspaces",
		description:
			"Lists uploaded-document Workspaces. Generated Pages use fabric_list_frames.",
		inputSchema: {
			type: "object",
			properties: {
				search: {
					type: "string",
				},
				limit: {
					type: "number",
				},
				offset: {
					type: "number",
				},
			},
		},
		annotations: { readOnlyHint: true },
		scope: "workspaces:read",
	},
	{
		name: "fabric_get_workspace",
		description:
			"Pages document IDs/status; continue nextOffset (max 100). Live offsets, not a snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 100,
					default: 20,
				},
				offset: {
					type: "integer",
					minimum: 0,
					maximum: 2147483646,
					default: 0,
				},
				workspaceId: {
					type: "string",
				},
			},
			required: ["workspaceId"],
		},
		annotations: { readOnlyHint: true },
		scope: "workspaces:read",
	},
	{
		name: "fabric_get_workspace_document",
		description:
			"Direct text page, no AI/search; Offsets: Unicode code points. Continue nextOffset with first-page expectedRevision; changes require restart. No historical versions.",
		inputSchema: {
			type: "object",
			properties: {
				workspaceId: { type: "string" },
				documentId: { type: "string" },
				offset: {
					type: "integer",
					minimum: 0,
					maximum: 2147483646,
					default: 0,
				},
				expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 20000,
					default: 12000,
				},
			},
			required: ["workspaceId", "documentId"],
		},
		annotations: { readOnlyHint: true },
		scope: "workspaces:read",
	},
	{
		name: "fabric_query_workspace",
		description: "Searches document text; returns cited chunks and scores.",
		inputSchema: {
			type: "object",
			properties: {
				workspaceId: {
					type: "string",
				},
				query: {
					type: "string",
				},
				limit: {
					type: "number",
					default: 10,
				},
			},
			required: ["workspaceId", "query"],
		},
		annotations: { readOnlyHint: true },
		scope: "workspaces:read",
	},
]);

export type FabricWorkspaceToolName =
	(typeof FABRIC_WORKSPACE_TOOL_DEFINITIONS)[number]["name"];
