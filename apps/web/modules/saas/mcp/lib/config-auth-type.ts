import { isGitLabPersonalMcpServerKey } from "@repo/database/prisma/queries/lib/gitlab-personal-keys";

export type McpAuthType = "NONE" | "API_KEY" | "OAUTH2";

/**
 * The auth type a screen should treat an MCP config as having. A GitLab
 * personal server (`gitlab`, `gitlab-official`) is always OAuth: its
 * credential is the person's GitLab connection, so its status, its connect
 * and reconnect actions and its settings form follow that connection, never
 * a stored API key or the transport health. Every other config uses the auth
 * type it names.
 *
 * Rows saved before GitLab configs were normalised to OAUTH2 (by migration
 * `20261004120000_gitlab_mcp_config_drop_token_copies` and by
 * `mcp.configs.upsert`) can still name API_KEY or NONE in a cached response;
 * keying on the server here keeps every screen right for those too.
 */
export function effectiveMcpAuthType(config: {
	authType?: string | null;
	mcpServer?: { key?: string | null } | null;
}): McpAuthType {
	if (isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
		return "OAUTH2";
	}
	const authType = config.authType;
	return authType === "API_KEY" || authType === "OAUTH2" ? authType : "NONE";
}
