/** Shared project and instruction reads offered by Fabric Agent and the MCP gateway. */
import { FABRIC_LINKED_CONTEXT_READ_TOOL_DEFINITIONS } from "./fabric-linked-context-tool-definitions";
import { defineFabricTools } from "./fabric-tool-definition";

export const FABRIC_PROJECT_READ_TOOL_DEFINITIONS = defineFabricTools([
	...FABRIC_LINKED_CONTEXT_READ_TOOL_DEFINITIONS,
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
			"Lists instruction files/metadata; read fabric_get_project_instruction. Repository: pinned commitSha/generation; upload: published snapshot.",
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
						"Repository folder prefix, e.g. .claude/skills",
					maxLength: 512,
				},
				limit: {
					type: "integer",
					description: "Repository page size; default 200",
					minimum: 1,
					maximum: 500,
				},
				cursor: {
					type: "string",
					description:
						"Repository page.nextCursor; include same generation/commitSha",
					maxLength: 2048,
				},
				sinceDigest: {
					type: "string",
					description: "Uploaded digest; unchanged omits file list",
					minLength: 1,
					maxLength: 128,
				},
				generation: {
					type: "integer",
					description:
						"Pinned repository generation; include commitSha",
					minimum: 0,
				},
				commitSha: {
					type: "string",
					description:
						"Pinned repository commitSha; include generation",
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
			"Reads listed path; bundle reads tree. Truncated: offset=nextOffset + repository generation/commitSha. Uploaded binaries: temporary URL; repository binaries: Git. Scripts/settings are text only, never executed.",
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
						"First-page repository pin; required on continuation",
					minimum: 0,
				},
				commitSha: {
					type: "string",
					description:
						"First-page repository pin; required on continuation",
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
			"Upload: published manifest (snapshot/version/digest/path/sha256/mode) + temporary zip URL; sinceDigest skips unchanged. Repository: pinned Git, no zip.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				sinceDigest: {
					type: "string",
					description: "Installed digest; unchanged omits zip URL",
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
			"Lists active-org MCP names/serverKey/status/toolCount. serverKey is connected:<provider>/<tool>'s provider; discover read schemas separately.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		scope: "mcp:read",
	},
]);

export type FabricProjectReadToolName =
	(typeof FABRIC_PROJECT_READ_TOOL_DEFINITIONS)[number]["name"];
