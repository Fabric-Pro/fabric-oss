/**
 * Confluence MCP config detection.
 *
 * Detects a Confluence-capable MCP config from a `mcp.configs.list()` entry via
 * the STABLE linked-catalog signal — the catalog server's `tags`/`key` — rather
 * than the user-editable config name.
 *
 * The seeded Atlassian catalog server is `key: "atlassian"` with
 * `tags: ["jira", "confluence", ...]` (see `seed-enterprise-mcp.ts`). A naive
 * `key.includes("confluence")` check fails because the key is `"atlassian"`, and
 * matching on the user's `displayName` is brittle (they may rename it "My Wiki").
 * So we match the catalog tag `"confluence"` (or `key === "atlassian"`).
 */

export type McpConfigLike = {
	id?: string;
	mcpServer?: {
		key?: string | null;
		tags?: string[] | null;
	} | null;
};

/** True when the config's linked catalog server exposes Confluence. */
export function isConfluenceMcpConfig(config: McpConfigLike): boolean {
	const server = config.mcpServer;
	if (!server) {
		return false;
	}

	const tags = Array.isArray(server.tags) ? server.tags : [];
	const hasConfluenceTag = tags.some(
		(tag) => typeof tag === "string" && tag.toLowerCase() === "confluence",
	);
	const isAtlassian = (server.key ?? "").toLowerCase() === "atlassian";

	return hasConfluenceTag || isAtlassian;
}

/**
 * Pick the first Confluence MCP config from a list (D4: pick-first, no picker).
 * Returns `undefined` when none match.
 */
export function findConfluenceMcpConfig<T extends McpConfigLike>(
	configs: T[] | undefined | null,
): T | undefined {
	if (!configs) {
		return undefined;
	}
	return configs.find(isConfluenceMcpConfig);
}
