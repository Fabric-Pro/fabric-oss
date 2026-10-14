/**
 * The instance an MCP config's PM items live on, for the legacy-link guard
 * (`detectExternalLinkMismatch`'s `currentInstanceOrigin`).
 *
 * Only a personal GitLab config names one: its own `baseUrl`, else the
 * server's default URL, else gitlab.com (`mcpRowOrigin`, the same reading
 * the GitLab instance checks use). Every other tool's config may point at a
 * proxy or a shared endpoint rather than the host its item URLs carry
 * (a Fizzy proxy, Atlassian's remote MCP), so it names no instance here.
 */

import {
	isGitLabPersonalMcpServerKey,
	mcpRowOrigin,
} from "@repo/integrations/gitlab";

/**
 * The config's GitLab instance origin; `null` when it is a personal GitLab
 * config whose address is refused (no instance it may reach); `undefined`
 * for any other config, which leaves the guard on its host heuristics.
 */
export function mcpConfigPmInstanceOrigin(
	config:
		| {
				baseUrl?: string | null;
				mcpServer?: {
					key?: string | null;
					defaultUrl?: string | null;
				} | null;
		  }
		| null
		| undefined,
): string | null | undefined {
	if (!config || !isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
		return undefined;
	}
	return mcpRowOrigin({
		baseUrl: config.baseUrl ?? null,
		mcpServer: config.mcpServer ?? null,
	});
}
