/**
 * MCP server keys whose OAuth credential is a person's GitLab connection.
 *
 * For these keys the credential lives on that person's GitLab
 * `WorkflowIntegration` and is owned by the GitLab connection service in
 * `@repo/integrations/gitlab/connection`; the token columns on the MCPConfig
 * row are a legacy copy that must be neither read as authoritative nor
 * refreshed. Dependency-free so both this package and `@repo/integrations`
 * can share the one list without importing a database client.
 */
export const GITLAB_PERSONAL_MCP_SERVER_KEYS = [
	"gitlab",
	"gitlab-official",
] as const;

export type GitLabPersonalMcpServerKey =
	(typeof GITLAB_PERSONAL_MCP_SERVER_KEYS)[number];

export function isGitLabPersonalMcpServerKey(
	key: string | null | undefined,
): key is GitLabPersonalMcpServerKey {
	return (
		!!key &&
		(GITLAB_PERSONAL_MCP_SERVER_KEYS as readonly string[]).includes(key)
	);
}

/**
 * The auth type a person connects an MCP server with: OAUTH2 for a GitLab
 * personal server whatever its registry entry advertises (its credential is
 * the person's GitLab connection, and `mcp.configs.upsert` refuses an API
 * key for it), otherwise OAUTH2 when offered, then API_KEY, then NONE.
 */
export function preferredMcpServerAuthType(server: {
	key?: string | null;
	authMethods?: readonly string[] | null;
}): "OAUTH2" | "API_KEY" | "NONE" {
	if (isGitLabPersonalMcpServerKey(server.key)) {
		return "OAUTH2";
	}
	const methods = server.authMethods ?? [];
	if (methods.includes("OAUTH2")) {
		return "OAUTH2";
	}
	if (methods.includes("API_KEY")) {
		return "API_KEY";
	}
	return "NONE";
}
