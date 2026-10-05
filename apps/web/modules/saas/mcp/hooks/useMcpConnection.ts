"use client";

import { isGitLabPersonalMcpServerKey } from "@repo/database/prisma/queries/lib/gitlab-personal-keys";
import { invalidateGitLabConnectionViews } from "@saas/data-connections/lib/gitlab-status-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { effectiveMcpAuthType } from "../lib/config-auth-type";

export interface OAuthStatus {
	authenticated: boolean;
	/** A grant exists but is dead: the person must reconnect. */
	needsReauth?: boolean;
	tokenExpired: boolean;
	refreshTokenExpired: boolean;
	hasRefreshToken: boolean;
	expiresAt?: Date;
}

/**
 * Shared hook for MCP connection functionality
 * Used by both McpServersView and Settings forms
 */
export function useMcpConnection() {
	const qc = useQueryClient();
	const [oauthStatuses, setOAuthStatuses] = useState<
		Record<string, OAuthStatus>
	>({});

	// Track loading states for each config and action type
	const [loadingStates, setLoadingStates] = useState<
		Record<
			string,
			{
				test?: boolean;
				refresh?: boolean;
				toggle?: boolean;
				revoke?: boolean;
				refreshTools?: boolean;
			}
		>
	>({});

	/**
	 * Check OAuth status for all OAuth configs
	 * Returns the status data in a consistent format
	 * Memoized to prevent unnecessary re-renders and infinite loops
	 */
	const checkOAuthStatuses = useCallback(async (configs: any[]) => {
		const oauthConfigs = configs.filter(
			(c) => effectiveMcpAuthType(c) === "OAUTH2",
		);
		const statuses: Record<string, OAuthStatus> = {};

		await Promise.all(
			oauthConfigs.map(async (config) => {
				try {
					const orgParam = config.organizationId
						? `?organizationId=${config.organizationId}`
						: "?organizationId=";
					const resp = await fetch(
						`/api/mcp/oauth/status/${config.id}${orgParam}`,
					);
					if (resp.ok) {
						const result = await resp.json();
						// API returns { data: { authenticated, tokenExpired, ... } }
						if (result.data) {
							statuses[config.id] = {
								authenticated: result.data.authenticated,
								needsReauth: result.data.needsReauth === true,
								tokenExpired: result.data.tokenExpired,
								refreshTokenExpired:
									result.data.refreshTokenExpired || false,
								hasRefreshToken: result.data.hasRefreshToken,
								expiresAt: result.data.tokenExpiresAt
									? new Date(result.data.tokenExpiresAt)
									: undefined,
							};
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

		// Merge: a check of some configs (one tile after a Revoke, say) must
		// not wipe the others' statuses. A config checked here whose status
		// could not be read loses its old entry rather than keep a stale one.
		setOAuthStatuses((previous) => {
			const next = { ...previous };
			for (const config of oauthConfigs) {
				if (statuses[config.id]) {
					next[config.id] = statuses[config.id];
				} else {
					delete next[config.id];
				}
			}
			return next;
		});
		return statuses;
	}, []);

	/**
	 * Test connection mutation
	 * Handles both OAuth and non-OAuth configurations
	 * Shows detailed server information in toast message
	 */
	const testMutation = useMutation({
		mutationFn: async (config: any) => {
			// Set loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], test: true },
			}));

			const res = await fetch("/api/mcp/test-connection", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					configId: config.id,
					baseUrl: config.baseUrl || config.mcpServer?.defaultUrl,
					transport:
						config.transport ||
						config.mcpServer?.transport ||
						"HTTP",
					authType: effectiveMcpAuthType(config),
				}),
			});
			if (!res.ok) {
				const error = await res.json();
				// Include more details in the error message
				const errorMsg =
					error.error?.message ||
					error.message ||
					"Connection test failed";
				const statusCode = error.error?.statusCode || res.status;
				throw new Error(`${errorMsg} (HTTP ${statusCode})`);
			}
			return { config, data: await res.json() };
		},
		onSuccess: ({ config, data }) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], test: false },
			}));

			if (data.success && data.details) {
				const details = data.details;
				const serverName = details?.serverInfo?.name || "MCP Server";
				const serverVersion = details?.serverInfo?.version;
				const parts: string[] = [
					`Server: ${serverName}${serverVersion ? ` v${serverVersion}` : ""}`,
				];
				if (details?.protocolVersion) {
					parts.push(`Protocol: ${details.protocolVersion}`);
				}
				if (typeof details?.responseTime === "number") {
					parts.push(`Response time: ${details.responseTime}ms`);
				}
				toast.success("Connection test successful!", {
					description: parts.join(" | "),
					duration: 5000,
				});
			} else {
				toast.success("Connection test successful", {
					description: data.message,
				});
			}
		},
		onError: (e: any, config: any) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], test: false },
			}));

			toast.error("Connection test failed", {
				description: e?.message || String(e),
				duration: 7000,
			});
		},
	});

	/**
	 * Start OAuth connection flow
	 * Opens OAuth authorization page in a popup window
	 *
	 * NOTE: This should only be called for OAUTH2 auth type configs.
	 * For API_KEY configs, use the API key input form instead.
	 */
	const handleConnect = useCallback(
		async (config: any) => {
			try {
				// Check auth type - only proceed with OAuth for OAUTH2 configs
				if (effectiveMcpAuthType(config) === "API_KEY") {
					toast.error("API Key authentication required", {
						description:
							"This server uses API key authentication. Please enter your API key in the configuration.",
					});
					return;
				}

				if (effectiveMcpAuthType(config) !== "OAUTH2") {
					toast.error("No authentication required", {
						description:
							"This server doesn't require authentication.",
					});
					return;
				}

				// MCP-provider OAuth clients (Notion, Linear, GitHub, etc.) are
				// registered with a single fixed redirect_uri. When the wizard
				// initiates OAuth from a deployment whose `window.location.origin`
				// doesn't match the registered URI exactly (preview/Vercel-alias
				// hostnames, dev tunnels, mismatched trailing-slash, etc.) the
				// provider rejects the callback with "Invalid redirect_uri".
				// Prefer the canonical site URL from `NEXT_PUBLIC_SITE_URL`
				// (set per environment) and fall back to the current origin so
				// existing single-origin setups (incl. local dev) keep working.
				const canonicalOrigin =
					process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
					window.location.origin;
				const redirectUri = `${canonicalOrigin}/api/mcp/oauth/callback`;

				// Start OAuth flow via oRPC
				const result = await orpcClient.mcp.oauth.start({
					configId: config.id,
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
				const handleMessage = async (event: MessageEvent) => {
					if (event.origin !== window.location.origin) {
						return;
					}

					if (event.data.type === "oauth_success") {
						window.removeEventListener("message", handleMessage);
						toast.success("OAuth connection successful!");
						// Re-check OAuth status for this config
						await checkOAuthStatuses([config]);
						// Invalidate queries to refresh the UI
						qc.invalidateQueries({ queryKey: ["mcp-configs"] });

						// Delayed retry: Temporal ingestion workflow needs time to
						// fetch and cache tools after OAuth tokens are stored.
						setTimeout(() => {
							qc.invalidateQueries({ queryKey: ["mcp-configs"] });
						}, 5000);
					} else if (event.data.type === "oauth_error") {
						window.removeEventListener("message", handleMessage);
						const errorMessage =
							event.data.error || "Unknown error occurred";
						toast.error("OAuth connection failed", {
							description: errorMessage,
						});
					}
				};

				window.addEventListener("message", handleMessage);

				// Poll to detect if popup was closed manually
				const pollTimer = setInterval(() => {
					if (popup.closed) {
						clearInterval(pollTimer);
						window.removeEventListener("message", handleMessage);
					}
				}, 500);
			} catch (e: any) {
				toast.error("Failed to start OAuth flow", {
					description: e?.message || String(e),
				});
			}
		},
		[checkOAuthStatuses, qc],
	);

	/**
	 * Refresh OAuth token
	 * Uses the refresh token to get a new access token
	 */
	const refreshMutation = useMutation({
		mutationFn: async (config: any) => {
			// Set loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], refresh: true },
			}));

			// Call oRPC endpoint with configId in body
			const result = await orpcClient.mcp.oauth.refresh({
				configId: config.id,
			});

			// A refused refresh still resolves as an HTTP success carrying
			// `{ success: false }`, so without this the user is told the token
			// was refreshed at the moment the server declined to refresh it.
			// Throwing routes it through `onError`, which clears the loading
			// state and shows the failure toast.
			if (!result.success) {
				throw new Error(
					"The provider did not issue a new token. Please re-authenticate this connection.",
				);
			}

			return { config, data: result };
		},
		onSuccess: async ({ config }) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], refresh: false },
			}));

			toast.success("Token refreshed successfully");
			// Re-check OAuth status for this config
			await checkOAuthStatuses([config]);
			// Invalidate queries to refresh the UI
			qc.invalidateQueries({ queryKey: ["mcp-configs"] });
		},
		onError: (e: any, config: any) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], refresh: false },
			}));

			toast.error("Failed to refresh token", {
				description: e?.message || String(e),
			});
		},
	});

	/**
	 * Toggle configuration enabled state
	 */
	const toggleMutation = useMutation({
		mutationFn: async ({
			config,
			enabled,
		}: {
			config: any;
			enabled: boolean;
		}) => {
			// Set loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], toggle: true },
			}));

			return await orpcClient.mcp.configs.toggle({
				id: config.id,
				enabled,
				organizationId: config.organizationId ?? null,
			});
		},
		onSuccess: (_, { config }) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], toggle: false },
			}));

			qc.invalidateQueries({ queryKey: ["mcp-configs"] });
		},
		onError: (e: any, { config }) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], toggle: false },
			}));

			toast.error("Failed to update configuration", {
				description: e?.message || String(e),
			});
		},
	});

	/**
	 * Revoke OAuth access. The server checks the config belongs to the caller
	 * in this organization. For a GitLab server this disconnects the person's
	 * GitLab; for any other server it clears the config's tokens. Both keep
	 * the row and its client registration, and both are audited.
	 */
	const revokeMutation = useMutation({
		mutationFn: async (config: any) => {
			// Set loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], revoke: true },
			}));

			const data = await orpcClient.mcp.oauth.revoke({
				configId: config.id,
				organizationId: config.organizationId ?? null,
			});

			return { config, data };
		},
		onSuccess: async ({ config, data }) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], revoke: false },
			}));

			toast.success("Access revoked", {
				description:
					data.revocationWarning ??
					"Fabric's access was revoked and the change was recorded in the audit log.",
			});

			if (isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
				// The person's GitLab is disconnected everywhere: refresh every
				// screen showing it, and both GitLab server tiles (`gitlab`
				// and `gitlab-official` report the one connection).
				await Promise.all([
					invalidateGitLabConnectionViews(qc),
					checkOAuthStatuses([
						config,
						...cachedGitLabConfigs(qc).filter(
							(each) => each.id !== config.id,
						),
					]),
				]);
				return;
			}

			// Re-check OAuth status for this config
			await checkOAuthStatuses([config]);
			// Invalidate queries to refresh the UI
			qc.invalidateQueries({ queryKey: ["mcp-configs"] });
		},
		onError: (e: any, config: any) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], revoke: false },
			}));

			toast.error("Failed to revoke access", {
				description: e?.message || String(e),
			});
		},
	});

	/**
	 * Refresh MCP tools - re-discover and re-ingest tools from MCP server
	 * This triggers the Temporal workflow to fetch fresh tool definitions
	 */
	const refreshToolsMutation = useMutation({
		mutationFn: async (config: any) => {
			// Set loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], refreshTools: true },
			}));

			const result = await orpcClient.mcp.tools.refresh({
				serverIds: [config.id],
				organizationId: config.organizationId ?? null,
			});

			return { config, data: result };
		},
		onSuccess: ({ config, data }) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], refreshTools: false },
			}));

			// Check results
			const result = data.results[0];
			if (result?.success) {
				toast.success("Tools refresh started", {
					description: `Re-discovering tools from ${result.serverName}`,
				});
			} else {
				toast.error("Failed to refresh tools", {
					description: result?.error || "Unknown error",
				});
			}

			// Invalidate queries to refresh the UI after a delay
			// (workflow needs time to complete)
			setTimeout(() => {
				qc.invalidateQueries({ queryKey: ["mcp-configs"] });
			}, 2000);
		},
		onError: (e: any, config: any) => {
			// Clear loading state
			setLoadingStates((prev) => ({
				...prev,
				[config.id]: { ...prev[config.id], refreshTools: false },
			}));

			toast.error("Failed to refresh tools", {
				description: e?.message || String(e),
			});
		},
	});

	return {
		oauthStatuses,
		checkOAuthStatuses,
		testMutation,
		handleConnect,
		refreshMutation,
		toggleMutation,
		revokeMutation,
		refreshToolsMutation,
		loadingStates,
	};
}

/**
 * The person's GitLab personal MCP configs (`gitlab`, `gitlab-official`)
 * from every cached MCP config list, deduplicated by id.
 */
function cachedGitLabConfigs(qc: {
	getQueriesData: (filters: {
		queryKey: readonly unknown[];
	}) => Array<[unknown, unknown]>;
}): Array<{ id: string; authType?: string; mcpServer?: { key?: string } }> {
	const found = new Map<
		string,
		{ id: string; authType?: string; mcpServer?: { key?: string } }
	>();
	for (const [, data] of qc.getQueriesData({ queryKey: ["mcp-configs"] })) {
		if (!Array.isArray(data)) {
			continue;
		}
		for (const each of data) {
			if (
				each &&
				typeof each.id === "string" &&
				isGitLabPersonalMcpServerKey(each.mcpServer?.key)
			) {
				found.set(each.id, each);
			}
		}
	}
	return [...found.values()];
}
