/**
 * MCP Mutations Hook
 *
 * React Query mutation hooks for MCP server and configuration management.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
	ApiKeyMethod,
	AuthType,
	McpServer,
	McpSettingsScope,
	Transport,
} from "../types";
import {
	generateKeyFromName,
	isApiKeyPlaceholder,
	mcpQueryKeys,
} from "../types";

export interface UseMcpMutationsOptions {
	scope: McpSettingsScope;
	organizationId?: string;
	onConfigSaved?: () => void;
	onServerSaved?: (server: McpServer, mode: "create" | "update") => void;
}

export interface UpsertConfigParams {
	mcpServerId: string;
	displayName?: string;
	baseUrl: string;
	authType: AuthType;
	apiKeyMethod?: ApiKeyMethod;
	apiKey?: string;
	oauthClientId?: string;
	oauthClientSecret?: string;
	scopes?: string[];
	enabled: boolean;
}

export interface CreateServerParams {
	name: string;
	description: string | null;
	defaultUrl: string;
	docsUrl: string | null;
	transport: Transport;
	authMethods: AuthType[];
	apiKeyMethod?: ApiKeyMethod | null;
	oauthDiscoveryUrl?: string | null;
	dcrRegistrationEndpoint?: string | null;
}

export interface UpdateServerParams extends CreateServerParams {
	id: string;
}

export function useMcpMutations(options: UseMcpMutationsOptions) {
	const { scope, organizationId, onConfigSaved, onServerSaved } = options;
	const qc = useQueryClient();
	const isOrgScope = scope === "org";

	// Invalidate queries after mutations
	const invalidateQueries = () => {
		qc.invalidateQueries({
			queryKey: mcpQueryKeys.configs(scope, organizationId),
		});
	};

	const invalidateServerQueries = () => {
		qc.invalidateQueries({
			queryKey: mcpQueryKeys.servers(organizationId),
		});
	};

	// Upsert configuration
	const upsertConfig = useMutation({
		mutationFn: async (params: UpsertConfigParams) => {
			if (!params.baseUrl) {
				throw new Error("Base URL is required");
			}

			// Only send API key if it's not the placeholder
			const shouldSendApiKey =
				params.authType === "API_KEY" &&
				params.apiKey &&
				!isApiKeyPlaceholder(params.apiKey);
			const shouldSendOAuthSecret =
				params.authType === "OAUTH2" &&
				params.oauthClientSecret &&
				!isApiKeyPlaceholder(params.oauthClientSecret);

			// Replace {YOUR_API_KEY} placeholder in base URL with actual API key
			let finalBaseUrl = params.baseUrl;
			if (
				params.authType === "API_KEY" &&
				shouldSendApiKey &&
				params.baseUrl.includes("{YOUR_API_KEY}")
			) {
				finalBaseUrl = params.baseUrl.replace(
					"{YOUR_API_KEY}",
					// biome-ignore lint/style/noNonNullAssertion: apiKey is guaranteed when baseUrl contains {YOUR_API_KEY}
					params.apiKey!,
				);
			}

			const payload: Record<string, unknown> = {
				mcpServerId: params.mcpServerId,
				displayName: params.displayName?.trim() || undefined,
				baseUrl: finalBaseUrl,
				authType: params.authType,
				apiKeyMethod:
					params.authType === "API_KEY"
						? params.apiKeyMethod
						: undefined,
				apiKey: shouldSendApiKey ? params.apiKey : undefined,
				oauthClientId:
					params.authType === "OAUTH2"
						? params.oauthClientId
						: undefined,
				oauthClientSecret: shouldSendOAuthSecret
					? params.oauthClientSecret
					: undefined,
				scopes: params.authType === "OAUTH2" ? params.scopes : [],
				enabled: params.enabled,
			};

			if (isOrgScope && organizationId) {
				payload.organizationId = organizationId;
			}

			return await orpcClient.mcp.configs.upsert(payload as any);
		},
		onSuccess: () => {
			toast.success("Saved configuration");
			invalidateQueries();
			onConfigSaved?.();
		},
		onError: (error: Error) => {
			toast.error("Failed to save configuration", {
				description: error.message,
			});
		},
	});

	// Delete configuration
	const deleteConfig = useMutation({
		mutationFn: async (id: string) => {
			if (isOrgScope && !organizationId) {
				throw new Error(
					"Organization ID is required to delete an org config",
				);
			}
			const payload: Record<string, unknown> = { id };
			if (isOrgScope && organizationId) {
				payload.organizationId = organizationId;
			}
			return await orpcClient.mcp.configs.delete(payload as any);
		},
		onSuccess: () => {
			toast.success("Deleted configuration");
			invalidateQueries();
		},
		onError: () => {
			toast.error("Failed to delete configuration");
		},
	});

	// Create custom server
	const createServer = useMutation({
		mutationFn: async (params: CreateServerParams) => {
			const key = generateKeyFromName(params.name);
			if (!key) {
				throw new Error("Could not generate a valid key from the name");
			}

			const payload: Record<string, unknown> = {
				key,
				name: params.name.trim(),
				description: params.description?.trim() || null,
				defaultUrl: params.defaultUrl,
				docsUrl: params.docsUrl?.trim() || null,
				transport: params.transport,
				authMethods: params.authMethods,
				apiKeyMethod: params.apiKeyMethod || null,
				oauthDiscoveryUrl: params.oauthDiscoveryUrl || null,
				dcrRegistrationEndpoint: params.dcrRegistrationEndpoint || null,
			};

			if (isOrgScope && organizationId) {
				payload.organizationId = organizationId;
			}

			return await orpcClient.mcp.registry.create(payload as any);
		},
		onSuccess: (data) => {
			toast.success("Custom MCP server added");
			invalidateServerQueries();
			// Move directly into per-account configuration after the server exists.
			onServerSaved?.(data as McpServer, "create");
		},
		onError: (error: Error) => {
			toast.error("Failed to add server", {
				description: error.message,
			});
		},
	});

	// Update custom server
	const updateServer = useMutation({
		mutationFn: async (params: UpdateServerParams) => {
			const payload: Record<string, unknown> = {
				id: params.id,
				name: params.name.trim(),
				description: params.description?.trim() || null,
				defaultUrl: params.defaultUrl,
				docsUrl: params.docsUrl?.trim() || null,
				transport: params.transport,
				authMethods: params.authMethods,
				apiKeyMethod: params.apiKeyMethod || null,
				oauthDiscoveryUrl: params.oauthDiscoveryUrl || null,
				dcrRegistrationEndpoint: params.dcrRegistrationEndpoint || null,
			};

			if (isOrgScope && organizationId) {
				payload.organizationId = organizationId;
			}

			return await orpcClient.mcp.registry.update(payload as any);
		},
		onSuccess: (data) => {
			toast.success("Custom MCP server updated");
			invalidateServerQueries();
			onServerSaved?.(data as McpServer, "update");
		},
		onError: (error: Error) => {
			toast.error("Failed to update server", {
				description: error.message,
			});
		},
	});

	// Delete custom server
	const deleteServer = useMutation({
		mutationFn: async (id: string) => {
			const payload: Record<string, unknown> = { id };
			if (isOrgScope && organizationId) {
				payload.organizationId = organizationId;
			}
			return await orpcClient.mcp.registry.delete(payload as any);
		},
		onSuccess: () => {
			toast.success("Custom MCP server deleted");
			invalidateServerQueries();
		},
		onError: (error: Error) => {
			toast.error("Failed to delete server", {
				description: error.message,
			});
		},
	});

	// DCR Registration
	const registerDcr = useMutation({
		mutationFn: async (params: {
			configId: string;
			redirectUri: string;
			scopes: string[];
		}) => {
			return await orpcClient.mcp.dcr.register(params);
		},
		onSuccess: () => {
			toast.success("Client registered successfully");
		},
		onError: (error: Error) => {
			toast.error("Failed to register client", {
				description: error.message,
			});
		},
	});

	// DCR Unregistration
	const unregisterDcr = useMutation({
		mutationFn: async (configId: string) => {
			return await orpcClient.mcp.dcr.unregister({ configId });
		},
		onSuccess: () => {
			toast.success("Cleared client registration");
		},
		onError: (error: Error) => {
			toast.error("Failed to clear registration", {
				description: error.message,
			});
		},
	});

	// Toggle enabled state
	const toggleEnabled = useMutation({
		mutationFn: async (params: {
			mcpServerId: string;
			authType: AuthType;
			baseUrl: string;
			enabled: boolean;
		}) => {
			const payload: Record<string, unknown> = {
				mcpServerId: params.mcpServerId,
				authType: params.authType,
				baseUrl: params.baseUrl,
				enabled: params.enabled,
			};
			if (isOrgScope && organizationId) {
				payload.organizationId = organizationId;
			}
			return await orpcClient.mcp.configs.upsert(payload as any);
		},
		onSuccess: () => {
			invalidateQueries();
		},
	});

	return {
		upsertConfig,
		deleteConfig,
		createServer,
		updateServer,
		deleteServer,
		registerDcr,
		unregisterDcr,
		toggleEnabled,
	};
}
