/**
 * MCP Queries Hook
 *
 * React Query hooks for fetching MCP servers and configurations.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import type {
	McpConfig,
	McpServer,
	McpSettingsScope,
	OAuthStatus,
} from "../types";
import { mcpQueryKeys } from "../types";

export interface UseMcpQueriesOptions {
	scope: McpSettingsScope;
	organizationId?: string;
}

export interface UseMcpQueriesReturn {
	// Servers query
	servers: McpServer[];
	isLoadingServers: boolean;
	serversError: Error | null;

	// Configs query
	configs: McpConfig[];
	isLoadingConfigs: boolean;
	configsError: Error | null;

	// Filtered servers
	filteredServers: McpServer[];
	filterServers: (query: string) => McpServer[];
}

export function useMcpQueries(
	options: UseMcpQueriesOptions,
): UseMcpQueriesReturn {
	const { scope, organizationId } = options;
	const isOrgScope = scope === "org";

	// Fetch servers from registry
	const {
		data: servers = [],
		isLoading: isLoadingServers,
		error: serversError,
	} = useQuery({
		queryKey: mcpQueryKeys.servers(organizationId),
		queryFn: async () => {
			if (isOrgScope && !organizationId) {
				return [];
			}
			if (isOrgScope) {
				return await orpcClient.mcp.registry.list({ organizationId });
			}
			return await orpcClient.mcp.registry.list();
		},
		enabled: !isOrgScope || !!organizationId,
	});

	// Fetch configurations
	const {
		data: configs = [],
		isLoading: isLoadingConfigs,
		error: configsError,
	} = useQuery({
		queryKey: mcpQueryKeys.configs(scope, organizationId),
		queryFn: async () => {
			if (isOrgScope && !organizationId) {
				return [];
			}
			if (isOrgScope) {
				return await orpcClient.mcp.configs.list({ organizationId });
			}
			return await orpcClient.mcp.configs.list();
		},
		enabled: !isOrgScope || !!organizationId,
	});

	// Filter servers by search query
	const filterServers = (query: string): McpServer[] => {
		if (!query.trim()) {
			return servers as McpServer[];
		}
		const lowerQuery = query.toLowerCase();
		return (servers as McpServer[]).filter((server) => {
			return (
				server.name?.toLowerCase().includes(lowerQuery) ||
				server.key?.toLowerCase().includes(lowerQuery) ||
				server.defaultUrl?.toLowerCase().includes(lowerQuery) ||
				server.description?.toLowerCase().includes(lowerQuery)
			);
		});
	};

	return {
		servers: servers as McpServer[],
		isLoadingServers,
		serversError: serversError as Error | null,

		configs: configs as McpConfig[],
		isLoadingConfigs,
		configsError: configsError as Error | null,

		filteredServers: servers as McpServer[],
		filterServers,
	};
}

// Utility to check OAuth statuses for multiple configs
export async function checkOAuthStatuses(
	configs: McpConfig[],
	organizationId?: string,
): Promise<Record<string, OAuthStatus>> {
	const oauthConfigs = configs.filter((c) => c.authType === "OAUTH2");
	const statuses: Record<string, OAuthStatus> = {};

	const orgParam = organizationId
		? `?organizationId=${organizationId}`
		: "?organizationId=";

	await Promise.all(
		oauthConfigs.map(async (config) => {
			try {
				const resp = await fetch(
					`/api/mcp/oauth/status/${config.id}${orgParam}`,
				);
				if (resp.ok) {
					const result = await resp.json();
					if (result.data) {
						statuses[config.id] = result.data;
					}
				}
			} catch (error) {
				console.error(
					`Failed to check OAuth status for config ${config.id}:`,
					error,
				);
			}
		}),
	);

	return statuses;
}
