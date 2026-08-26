/**
 * MCP Actions Hook
 *
 * Handles test connection and OAuth flow actions.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import type {
	ApiKeyMethod,
	AuthType,
	McpConfig,
	McpSettingsScope,
	OAuthStatus,
	Transport,
} from "../types";
import { mcpQueryKeys } from "../types";

export interface UseMcpActionsOptions {
	scope: McpSettingsScope;
	organizationId?: string;
}

export interface TestConnectionParams {
	baseUrl: string;
	transport?: Transport;
	authType?: AuthType;
	apiKeyMethod?: ApiKeyMethod;
	apiKey?: string;
	oauthClientSecret?: string;
	configId?: string;
}

export interface StartOAuthParams {
	mcpServerId: string;
	displayName?: string;
	baseUrl: string;
	authType: AuthType;
	scopes: string[];
	enabled: boolean;
	oauthClientId?: string;
	oauthClientSecret?: string;
}

export function useMcpActions(options: UseMcpActionsOptions) {
	const { scope, organizationId } = options;
	const qc = useQueryClient();
	const isOrgScope = scope === "org";

	// Test connection for a saved config
	const testHealthForConfig = useCallback(
		async (config: McpConfig): Promise<boolean> => {
			if (isOrgScope && !organizationId) {
				toast.error("No organization selected");
				return false;
			}

			try {
				const resp = await fetch("/api/mcp/test-connection", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						baseUrl: config.baseUrl,
						transport: config.mcpServer?.transport || "HTTP",
						authType: config.authType || "NONE",
						apiKeyMethod:
							config.authType === "API_KEY"
								? config.apiKeyMethod || "BEARER"
								: undefined,
						configId: config.id,
					}),
					signal: AbortSignal.timeout(35_000),
				});

				const result = await resp.json();

				if (result.success) {
					const details = result.details;
					// Only show version if available
					const serverName =
						details?.serverInfo?.name || "MCP Server";
					const serverVersion = details?.serverInfo?.version;
					const serverDisplay = serverVersion
						? `${serverName} v${serverVersion}`
						: serverName;
					setTimeout(
						() =>
							toast.success("Connection test successful!", {
								description: `Server: ${serverDisplay} | Protocol: ${details?.protocolVersion || "Unknown"} | Response time: ${details?.responseTime}ms`,
								duration: 5000,
							}),
						0,
					);
					return true;
				}

				const errMsg1 = result.message;
				const errDetail1 = result.error?.message || "Unknown error";
				setTimeout(
					() =>
						toast.error(`Connection test failed: ${errMsg1}`, {
							description: errDetail1,
							duration: 7000,
						}),
					0,
				);
				return false;
			} catch (e: unknown) {
				const error = e as Error;
				const msg1 = error?.message || String(e);
				setTimeout(
					() =>
						toast.error("Test failed", {
							description: msg1,
							duration: 5000,
						}),
					0,
				);
				return false;
			}
		},
		[isOrgScope, organizationId],
	);

	// Test connection with current form values (before saving)
	const testConnection = useCallback(
		async (params: TestConnectionParams): Promise<boolean> => {
			if (!params.baseUrl) {
				toast.error("Base URL is required", {
					description:
						"Please enter a base URL before testing the connection.",
				});
				return false;
			}

			try {
				const resp = await fetch("/api/mcp/test-connection", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						baseUrl: params.baseUrl,
						transport: params.transport || "HTTP",
						authType: params.authType || "NONE",
						apiKeyMethod:
							params.authType === "API_KEY"
								? params.apiKeyMethod || "BEARER"
								: undefined,
						apiKey:
							params.authType === "API_KEY" &&
							params.apiKey &&
							!params.apiKey.startsWith("••••")
								? params.apiKey
								: undefined,
						oauthClientSecret:
							params.authType === "OAUTH2" &&
							params.oauthClientSecret &&
							!params.oauthClientSecret.startsWith("••••")
								? params.oauthClientSecret
								: undefined,
					}),
					signal: AbortSignal.timeout(35_000),
				});

				const result = await resp.json();

				if (result.success) {
					const details = result.details;
					// Only show version if available
					const serverName =
						details?.serverInfo?.name || "MCP Server";
					const serverVersion = details?.serverInfo?.version;
					const serverDisplay = serverVersion
						? `${serverName} v${serverVersion}`
						: serverName;
					setTimeout(
						() =>
							toast.success("Connection test successful!", {
								description: `Server: ${serverDisplay} | Protocol: ${details?.protocolVersion || "Unknown"} | Response time: ${details?.responseTime}ms`,
								duration: 5000,
							}),
						0,
					);
					return true;
				}

				const errMsg2 = result.message;
				const errDetail2 = result.error?.message || "Unknown error";
				setTimeout(
					() =>
						toast.error(`Connection test failed: ${errMsg2}`, {
							description: errDetail2,
							duration: 7000,
						}),
					0,
				);
				return false;
			} catch (e: unknown) {
				const error = e as Error;
				const msg2 = error?.message || String(e);
				setTimeout(
					() =>
						toast.error("Test connection failed", {
							description: msg2,
							duration: 5000,
						}),
					0,
				);
				return false;
			}
		},
		[],
	);

	// Start OAuth flow
	const startOAuthFlow = useCallback(
		async (
			params: StartOAuthParams,
			callbacks: {
				onSuccess?: () => void;
				onError?: (error: string) => void;
				onPopupClosed?: () => void;
				editingConfigId?: string;
				setCurrentConfigOAuthStatus?: (
					status: OAuthStatus | null,
				) => void;
			} = {},
		): Promise<void> => {
			const {
				onSuccess,
				onError,
				onPopupClosed,
				editingConfigId,
				setCurrentConfigOAuthStatus,
			} = callbacks;

			if (isOrgScope && !organizationId) {
				toast.error("Missing organization/server context");
				return;
			}

			try {
				// Check if we have manual credentials
				const hasManualCredentials =
					params.oauthClientId &&
					params.oauthClientSecret &&
					!params.oauthClientSecret.startsWith("••••");

				// Create/update config
				const payload: Record<string, unknown> = {
					mcpServerId: params.mcpServerId,
					displayName: params.displayName?.trim() || undefined,
					baseUrl: params.baseUrl,
					authType: params.authType,
					scopes: params.scopes,
					enabled: params.enabled,
				};

				if (hasManualCredentials) {
					payload.oauthClientId = params.oauthClientId;
					payload.oauthClientSecret = params.oauthClientSecret;
				}

				if (isOrgScope && organizationId) {
					payload.organizationId = organizationId;
				}

				const record = await orpcClient.mcp.configs.upsert(
					payload as any,
				);

				const redirectUri = `${window.location.origin}/api/mcp/oauth/callback`;

				// Initiate OAuth connection with automatic discovery and DCR
				const result = await orpcClient.mcp.oauth.start({
					configId: record.id,
					redirectUri,
					autoDiscoverAndRegister: true,
				});

				if (!result.authorizationUrl) {
					toast.error("Failed to get authorization URL");
					return;
				}

				// Open OAuth flow in popup window
				const width = 600;
				const height = 700;
				const left = window.screenX + (window.outerWidth - width) / 2;
				const top = window.screenY + (window.outerHeight - height) / 2;
				const popup = window.open(
					result.authorizationUrl,
					"oauth_popup",
					`width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no`,
				);

				if (!popup) {
					toast.error("Popup blocked", {
						description:
							"Please allow popups for this site to complete OAuth authentication.",
					});
					return;
				}

				toast.success(
					"OAuth window opened. Please complete authentication.",
				);

				// Listen for OAuth callback message from popup
				const handleMessage = (event: MessageEvent) => {
					if (event.origin !== window.location.origin) {
						return;
					}

					if (event.data.type === "oauth_success") {
						window.removeEventListener("message", handleMessage);
						toast.success("OAuth connection successful!");
						qc.invalidateQueries({
							queryKey: mcpQueryKeys.configs(
								scope,
								organizationId,
							),
						});
						// Refresh OAuth status
						if (editingConfigId && setCurrentConfigOAuthStatus) {
							const orgParam = organizationId
								? `?organizationId=${organizationId}`
								: "?organizationId=";
							fetch(
								`/api/mcp/oauth/status/${editingConfigId}${orgParam}`,
							)
								.then((resp) => resp.json())
								.then((result) => {
									if (result.data) {
										setCurrentConfigOAuthStatus(
											result.data,
										);
									}
								})
								.catch((error) => {
									console.error(
										"Failed to fetch OAuth status:",
										error,
									);
								});
						}
						onSuccess?.();
					} else if (event.data.type === "oauth_error") {
						window.removeEventListener("message", handleMessage);
						const errorMessage =
							event.data.error || "Unknown error occurred";
						toast.error("OAuth connection failed", {
							description: errorMessage,
						});
						onError?.(errorMessage);
					}
				};

				window.addEventListener("message", handleMessage);

				// Poll to detect if popup was closed manually
				const pollTimer = setInterval(() => {
					if (popup.closed) {
						clearInterval(pollTimer);
						window.removeEventListener("message", handleMessage);
						onPopupClosed?.();
					}
				}, 500);
			} catch (e: unknown) {
				const error = e as Error;
				toast.error("Failed to start OAuth flow", {
					description: error?.message || String(e),
				});
			}
		},
		[scope, organizationId, isOrgScope, qc],
	);

	// Discover OAuth endpoints from discovery URL
	const discoverOAuthEndpoints = useCallback(
		async (
			discoveryUrl: string,
		): Promise<{ registrationEndpoint?: string } | null> => {
			if (!discoveryUrl) {
				return null;
			}

			try {
				const result =
					await orpcClient.mcp.discovery.fetchOpenIdConfiguration({
						discoveryUrl,
					});

				if (result.registrationEndpoint) {
					toast.success("Endpoints discovered successfully", {
						description:
							"DCR registration endpoint has been populated from discovery.",
					});
				} else {
					toast.success("Endpoints discovered successfully", {
						description:
							"Discovery succeeded, but the provider did not advertise a registration endpoint.",
					});
				}

				return result;
			} catch (e: unknown) {
				const error = e as Error;
				toast.error("Failed to discover endpoints", {
					description: error?.message || String(e),
				});
				return null;
			}
		},
		[],
	);

	return {
		testHealthForConfig,
		testConnection,
		startOAuthFlow,
		discoverOAuthEndpoints,
	};
}
