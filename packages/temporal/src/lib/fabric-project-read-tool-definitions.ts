/** Shared project and instruction reads offered by Fabric Agent and the MCP gateway. */
import { defineFabricTools } from "./fabric-tool-definition";

export const FABRIC_PROJECT_READ_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_projects",
		description:
			"Lists active-organization projects with id/name/description/status. id is projectId.",
		inputSchema: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: ["ACTIVE", "ARCHIVED", "COMPLETED"],
				},
				search: {
					type: "string",
					description: "Match on project name",
				},
				limit: {
					type: "number",
					description: "Max 50",
					default: 20,
				},
				offset: {
					type: "number",
					default: 0,
				},
			},
		},
		annotations: { readOnlyHint: true },
		scope: "projects:read",
	},
	{
		name: "fabric_get_project",
		description:
			"Reads project name/description/status, heroEmojis and timestamps.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		scope: "projects:read",
	},
	{
		name: "fabric_list_project_instructions",
		description:
			"Lists instruction files/metadata; read paths with fabric_get_project_instruction. Repository reads return pinned commitSha/generation; uploaded projects use the published snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				kind: {
					type: "string",
					enum: [
						"SKILL",
						"AGENT",
						"RULE",
						"INSTRUCTIONS",
						"SETTINGS",
						"SCRIPT",
						"KNOWLEDGE",
						"OTHER",
					],
				},
				query: {
					type: "string",
					description:
						"Case-insensitive match on path, name or description",
				},
				prefix: {
					type: "string",
					description:
						"Repository projects: only files under this folder, e.g. '.claude/skills'",
					maxLength: 512,
				},
				limit: {
					type: "integer",
					description:
						"Repository projects: files per page (default 200)",
					minimum: 1,
					maximum: 500,
				},
				cursor: {
					type: "string",
					description:
						"Repository projects: page.nextCursor, sent with that response's generation and commitSha",
					maxLength: 2048,
				},
				sinceDigest: {
					type: "string",
					description:
						"Uploaded projects: the digest you last saw; unchanged answers without the file list",
					minLength: 1,
					maxLength: 128,
				},
				generation: {
					type: "integer",
					description:
						"From an earlier repository response; send with commitSha to pin the read",
					minimum: 0,
				},
				commitSha: {
					type: "string",
					description:
						"From an earlier repository response; send with generation",
					pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		scope: "instructions:read",
	},
	{
		name: "fabric_get_project_instruction",
		description:
			"Reads a listed path; bundle tool reads the tree. For truncated text pass offset=nextOffset and repository generation/commitSha. Uploaded binaries return a temporary URL; use Git for repository binaries. Scripts/settings are text only, never executed.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				path: {
					type: "string",
					description: "Exactly as listed",
				},
				offset: {
					type: "integer",
					default: 0,
					minimum: 0,
					maximum: 2_147_483_646,
				},
				maxLength: {
					type: "integer",
					default: 50000,
					minimum: 1,
					maximum: 200_000,
				},
				generation: {
					type: "integer",
					description:
						"Repository projects: from the first page; required for later pages",
					minimum: 0,
				},
				commitSha: {
					type: "string",
					description:
						"Repository projects: from the first page; required for later pages",
					pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
				},
			},
			required: ["projectId", "path"],
		},
		annotations: { readOnlyHint: true },
		scope: "instructions:read",
	},
	{
		name: "fabric_get_project_instruction_bundle",
		description:
			"Uploaded: published manifest (snapshot/version/digest, path/sha256/mode) and temporary zip URL; sinceDigest skips unchanged. Repository: pinned Git checkout, no zip.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				sinceDigest: {
					type: "string",
					description:
						"The digest you last installed; unchanged answers without a zip URL",
					minLength: 1,
					maxLength: 128,
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		scope: "instructions:read",
	},
	{
		name: "fabric_list_connected_servers",
		description:
			"Lists active-org MCP connection names, serverKey/status/toolCount. serverKey is connected:<provider>/<tool>'s provider; discover read schemas separately.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
	},
]);

export type FabricProjectReadToolName =
	(typeof FABRIC_PROJECT_READ_TOOL_DEFINITIONS)[number]["name"];
