/**
 * MCP configuration utilities for report templates
 */

import { isGitLabPersonalMcpServerKey } from "@repo/database/prisma/queries/lib/gitlab-personal-keys";

export interface McpConfigForDisplay {
	id: string;
	displayName?: string | null;
	commandArgs?: string[];
	mcpServer?: { key?: string | null; name?: string | null } | null;
}

/**
 * Get a human-readable display name for an MCP config
 * Extracts organization names from Azure DevOps URLs when available
 */
export function getMcpConfigDisplayName(
	config:
		| McpConfigForDisplay
		| {
				mcpServer?: {
					key?: string | null;
					name?: string | null;
				} | null;
				displayName?: string | null;
				commandArgs?: string[];
				id?: string;
		  },
): string {
	if (config.displayName) {
		return config.displayName;
	}

	if (
		config.mcpServer?.key?.toLowerCase().includes("azure") ||
		config.mcpServer?.name?.toLowerCase().includes("azure")
	) {
		const args = config.commandArgs || [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (
				(arg === "--org" || arg === "-o" || arg === "--organization") &&
				args[i + 1]
			) {
				return `${config.mcpServer?.name} (${args[i + 1]})`;
			}
			const urlMatch = arg.match(/https?:\/\/dev\.azure\.com\/([^/]+)/i);
			if (urlMatch) {
				return `${config.mcpServer?.name} (${urlMatch[1]})`;
			}
			const vsMatch = arg.match(/https?:\/\/([^.]+)\.visualstudio\.com/i);
			if (vsMatch) {
				return `${config.mcpServer?.name} (${vsMatch[1]})`;
			}
		}
	}

	return (
		config.mcpServer?.name ||
		(config as McpConfigForDisplay).id ||
		"Unknown"
	);
}

/**
 * Normalize a key for comparison (lowercase, no hyphens/underscores)
 */
export function normalizeKey(key: string): string {
	if (!key) {
		return "";
	}
	return key.toLowerCase().replace(/[-_]/g, "");
}

/**
 * Find MCP configs that match a provider key
 * Matches by normalized key (handles azure_devops vs azure-devops)
 * or by name containing the search key
 */
export function findMatchingMcpConfigs<
	T extends {
		id: string;
		mcpServer?: { key?: string | null; name?: string | null } | null;
	},
>(configs: T[], providerKey: string): T[] {
	const normalizedKey = normalizeKey(providerKey);
	return configs.filter((config) => {
		const serverKey = config.mcpServer?.key || "";
		const serverName = config.mcpServer?.name || "";
		return (
			normalizeKey(serverKey) === normalizedKey ||
			normalizeKey(serverName).includes(normalizedKey)
		);
	});
}

/** The fields `isReportMcpConfigAuthenticated` reads from an MCP config. */
export interface McpConfigForAuthentication {
	enabled: boolean;
	authType: string;
	encryptedApiKey?: string | null;
	encryptedAccessToken?: string | null;
	tokenExpiresAt?: string | Date | null;
	mcpServer?: { key?: string | null } | null;
}

/**
 * Whether a report can authenticate with an MCP config.
 *
 * A GitLab personal server (`gitlab`, `gitlab-official`) holds no token of
 * its own: it is authenticated exactly when the person's GitLab connection
 * is (`gitlabConnectionState`, the `state` from `gitlab.status`), whatever
 * its own token columns say. Every other config is judged from its own row.
 */
export function isReportMcpConfigAuthenticated(
	config: McpConfigForAuthentication,
	gitlabConnectionState: string | undefined,
	now: Date = new Date(),
): boolean {
	if (!config.enabled) {
		return false;
	}
	if (isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
		return gitlabConnectionState === "connected";
	}
	if (config.authType === "NONE") {
		return true;
	}
	if (config.authType === "API_KEY") {
		return !!config.encryptedApiKey;
	}
	if (config.authType === "OAUTH2") {
		if (!config.encryptedAccessToken) {
			return false;
		}
		if (config.tokenExpiresAt) {
			return new Date(config.tokenExpiresAt) > now;
		}
		return true;
	}
	return false;
}
