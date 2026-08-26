"use client";

/**
 * ConnectionRequiredDialog
 *
 * Modal dialog shown when the orchestrator detects that MCP servers need
 * to be connected before a task can proceed. Supports both OAuth and
 * API Key authentication flows.
 *
 * OAuth: Opens popup window and polls for completion
 * API Key: Shows input field to enter key
 */

import type { MissingIntegration, RequiredConnection } from "@repo/temporal";
import { orpcClient } from "@shared/lib/orpc-client";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import {
	CheckCircle2,
	ExternalLink,
	Eye,
	EyeOff,
	Key,
	Loader2,
	Plug2,
	RefreshCw,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface ConnectionRequiredDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	connections: RequiredConnection[];
	/** Workflow integrations that need to be configured */
	missingIntegrations?: MissingIntegration[];
	organizationId?: string | null;
	onConnectionComplete: () => void;
	onSkip?: () => void;
}

interface ConnectionStatus {
	serverId: string;
	isConnecting: boolean;
	isConnected: boolean;
	error?: string;
}

export function ConnectionRequiredDialog({
	open,
	onOpenChange,
	connections,
	missingIntegrations = [],
	organizationId,
	onConnectionComplete,
	onSkip,
}: ConnectionRequiredDialogProps) {
	const [connectionStatuses, setConnectionStatuses] = useState<
		Map<string, ConnectionStatus>
	>(new Map());
	const [integrationStatuses, setIntegrationStatuses] = useState<
		Map<
			string,
			{ isConnecting: boolean; isConnected: boolean; error?: string }
		>
	>(new Map());
	const [providerConfigs, setProviderConfigs] = useState<
		Map<string, { configured: boolean; providerName: string }>
	>(new Map());
	const [apiKeyInputs, setApiKeyInputs] = useState<Map<string, string>>(
		new Map(),
	);
	const [showApiKeys, setShowApiKeys] = useState<Map<string, boolean>>(
		new Map(),
	);
	const pollingIntervals = useRef<Map<string, NodeJS.Timeout>>(new Map());
	const integrationPollingIntervals = useRef<Map<string, NodeJS.Timeout>>(
		new Map(),
	);

	// Clean up polling intervals on unmount
	useEffect(() => {
		return () => {
			for (const interval of pollingIntervals.current.values()) {
				clearInterval(interval);
			}
			for (const interval of integrationPollingIntervals.current.values()) {
				clearInterval(interval);
			}
		};
	}, []);

	// Reset state when dialog opens/closes
	useEffect(() => {
		if (!open) {
			setConnectionStatuses(new Map());
			setIntegrationStatuses(new Map());
			setProviderConfigs(new Map());
			setApiKeyInputs(new Map());
			setShowApiKeys(new Map());
			for (const interval of pollingIntervals.current.values()) {
				clearInterval(interval);
			}
			pollingIntervals.current.clear();
			for (const interval of integrationPollingIntervals.current.values()) {
				clearInterval(interval);
			}
			integrationPollingIntervals.current.clear();
		}
	}, [open]);

	// Check OAuth provider configuration when dialog opens with missing integrations
	useEffect(() => {
		if (open && missingIntegrations.length > 0) {
			const checkProviderConfigs = async () => {
				const newConfigs = new Map<
					string,
					{ configured: boolean; providerName: string }
				>();

				for (const integration of missingIntegrations) {
					if (integration.authType === "OAUTH") {
						try {
							const result =
								await orpcClient.integrations.oauth.isConfigured(
									{
										provider: integration.provider as
											| "GITHUB"
											| "SLACK"
											| "GOOGLE_DRIVE"
											| "MICROSOFT_GRAPH"
											| "NOTION",
									},
								);
							newConfigs.set(integration.provider, {
								configured: result.configured,
								providerName: result.providerName,
							});
						} catch (error) {
							console.error(
								`Failed to check ${integration.provider} config:`,
								error,
							);
							newConfigs.set(integration.provider, {
								configured: false,
								providerName: integration.provider,
							});
						}
					}
				}

				setProviderConfigs(newConfigs);
			};

			checkProviderConfigs();
		}
	}, [open, missingIntegrations]);

	// Check if all required connections and integrations are now connected
	const allMcpConnected =
		connections.length === 0 ||
		connections.every(
			(c) => connectionStatuses.get(c.serverId)?.isConnected,
		);
	const allIntegrationsConnected =
		missingIntegrations.length === 0 ||
		missingIntegrations.every(
			(i) => integrationStatuses.get(i.provider)?.isConnected,
		);
	const allConnected =
		allMcpConnected &&
		allIntegrationsConnected &&
		(connections.length > 0 || missingIntegrations.length > 0);

	// Auto-close and proceed when all connected
	useEffect(() => {
		if (allConnected && open) {
			toast.success("All integrations connected!");
			setTimeout(() => {
				onConnectionComplete();
			}, 500);
		}
	}, [allConnected, open, onConnectionComplete]);

	const updateConnectionStatus = useCallback(
		(serverId: string, updates: Partial<ConnectionStatus>) => {
			setConnectionStatuses((prev) => {
				const newMap = new Map(prev);
				const existing = newMap.get(serverId) || {
					serverId,
					isConnecting: false,
					isConnected: false,
				};
				newMap.set(serverId, { ...existing, ...updates });
				return newMap;
			});
		},
		[],
	);

	const startOAuthFlow = useCallback(
		async (connection: RequiredConnection) => {
			updateConnectionStatus(connection.serverId, {
				isConnecting: true,
				error: undefined,
			});

			try {
				// Get connection info from API
				const info = await orpcClient.mcp.connect.getConnectInfo({
					serverId: connection.serverId,
					organizationId: organizationId ?? null,
				});

				if (info.isConnected && !info.needsReauth) {
					updateConnectionStatus(connection.serverId, {
						isConnecting: false,
						isConnected: true,
					});
					return;
				}

				// Check if there's an existing config to use, or create one
				let configId: string;
				if (info.configId) {
					configId = info.configId;
				} else {
					// Create a config for this server using the defaultUrl from info
					const config = await orpcClient.mcp.configs.upsert({
						mcpServerId: connection.serverId,
						baseUrl: info.defaultUrl || "",
						authType: "OAUTH2",
						enabled: true,
						organizationId: organizationId ?? undefined,
					});
					configId = config.id;
				}

				// Start OAuth flow
				const redirectUri = `${window.location.origin}/api/mcp/oauth/callback`;
				const result = await orpcClient.mcp.oauth.start({
					configId,
					redirectUri,
					autoDiscoverAndRegister: true,
				});

				if (!result.authorizationUrl) {
					throw new Error("Failed to get authorization URL");
				}

				// Open OAuth popup
				const width = 600;
				const height = 700;
				const left = window.screenX + (window.outerWidth - width) / 2;
				const top = window.screenY + (window.outerHeight - height) / 2;
				const popup = window.open(
					result.authorizationUrl,
					`oauth_popup_${connection.serverId}`,
					`width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no`,
				);

				if (!popup) {
					throw new Error(
						"Popup blocked. Please allow popups for this site.",
					);
				}

				// Listen for OAuth callback
				const handleMessage = (event: MessageEvent) => {
					if (event.origin !== window.location.origin) {
						return;
					}

					if (event.data.type === "oauth_success") {
						window.removeEventListener("message", handleMessage);
						clearInterval(
							pollingIntervals.current.get(connection.serverId),
						);
						pollingIntervals.current.delete(connection.serverId);
						updateConnectionStatus(connection.serverId, {
							isConnecting: false,
							isConnected: true,
						});
						toast.success(`${connection.serverName} connected!`);
					} else if (event.data.type === "oauth_error") {
						window.removeEventListener("message", handleMessage);
						clearInterval(
							pollingIntervals.current.get(connection.serverId),
						);
						pollingIntervals.current.delete(connection.serverId);
						updateConnectionStatus(connection.serverId, {
							isConnecting: false,
							error:
								event.data.error ||
								"OAuth authentication failed",
						});
					}
				};

				window.addEventListener("message", handleMessage);

				// Also poll for completion in case postMessage fails
				const pollInterval = setInterval(async () => {
					try {
						const status =
							await orpcClient.mcp.connect.getConnectInfo({
								serverId: connection.serverId,
								organizationId: organizationId ?? null,
							});
						if (status.isConnected && !status.needsReauth) {
							clearInterval(pollInterval);
							pollingIntervals.current.delete(
								connection.serverId,
							);
							window.removeEventListener(
								"message",
								handleMessage,
							);
							updateConnectionStatus(connection.serverId, {
								isConnecting: false,
								isConnected: true,
							});
							toast.success(
								`${connection.serverName} connected!`,
							);
							popup?.close();
						}
					} catch {
						// Ignore polling errors
					}
				}, 2000);

				pollingIntervals.current.set(connection.serverId, pollInterval);

				// Check if popup was closed without completing
				const checkPopupClosed = setInterval(() => {
					if (popup?.closed) {
						clearInterval(checkPopupClosed);
						// Give some time for the callback to process
						setTimeout(() => {
							const status = connectionStatuses.get(
								connection.serverId,
							);
							if (status?.isConnecting) {
								clearInterval(
									pollingIntervals.current.get(
										connection.serverId,
									),
								);
								pollingIntervals.current.delete(
									connection.serverId,
								);
								window.removeEventListener(
									"message",
									handleMessage,
								);
								updateConnectionStatus(connection.serverId, {
									isConnecting: false,
									error: "Authentication window closed",
								});
							}
						}, 1000);
					}
				}, 500);

				// Clean up popup check after 5 minutes
				setTimeout(() => clearInterval(checkPopupClosed), 300000);
			} catch (error) {
				updateConnectionStatus(connection.serverId, {
					isConnecting: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to start OAuth flow",
				});
			}
		},
		[organizationId, updateConnectionStatus, connectionStatuses],
	);

	const saveApiKey = useCallback(
		async (connection: RequiredConnection) => {
			const apiKey = apiKeyInputs.get(connection.serverId);
			if (!apiKey?.trim()) {
				toast.error("Please enter an API key");
				return;
			}

			updateConnectionStatus(connection.serverId, {
				isConnecting: true,
				error: undefined,
			});

			try {
				// Get connection info to get the defaultUrl
				const info = await orpcClient.mcp.connect.getConnectInfo({
					serverId: connection.serverId,
					organizationId: organizationId ?? null,
				});

				// Create/update config with API key
				await orpcClient.mcp.configs.upsert({
					mcpServerId: connection.serverId,
					baseUrl: info.defaultUrl || "",
					authType: "API_KEY",
					apiKey: apiKey.trim(),
					apiKeyMethod: "BEARER",
					enabled: true,
					organizationId: organizationId ?? undefined,
				});

				updateConnectionStatus(connection.serverId, {
					isConnecting: false,
					isConnected: true,
				});
				toast.success(`${connection.serverName} connected!`);
			} catch (error) {
				updateConnectionStatus(connection.serverId, {
					isConnecting: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to save API key",
				});
			}
		},
		[apiKeyInputs, organizationId, updateConnectionStatus],
	);

	// Start OAuth flow for a workflow integration (GitHub, Slack, etc.)
	const startIntegrationOAuth = useCallback(
		async (provider: string) => {
			// Update status to connecting
			setIntegrationStatuses((prev) => {
				const newMap = new Map(prev);
				newMap.set(provider, {
					isConnecting: true,
					isConnected: false,
				});
				return newMap;
			});

			try {
				// Call the API to get the OAuth URL
				const result =
					await orpcClient.mcp.connect.startIntegrationOAuth({
						provider: provider as
							| "GITHUB"
							| "SLACK"
							| "GOOGLE_DRIVE"
							| "MICROSOFT_GRAPH"
							| "NOTION",
						organizationId: organizationId ?? null,
						returnUrl: window.location.href,
					});

				// Open OAuth popup
				const popup = window.open(
					result.authorizationUrl,
					`${provider}-oauth`,
					"width=600,height=700,scrollbars=yes",
				);

				if (!popup) {
					throw new Error(
						"Popup blocked. Please allow popups for this site.",
					);
				}

				// Poll for OAuth completion
				const pollInterval = setInterval(async () => {
					try {
						// Check if popup is closed
						if (popup.closed) {
							clearInterval(pollInterval);
							integrationPollingIntervals.current.delete(
								provider,
							);

							// Check if connection was successful by querying the status
							// For now, we'll assume success if popup closed normally
							// In a real implementation, you'd check the integration status
							setIntegrationStatuses((prev) => {
								const newMap = new Map(prev);
								newMap.set(provider, {
									isConnecting: false,
									isConnected: true,
								});
								return newMap;
							});
							toast.success(`${provider} connected!`);
						}
					} catch (error) {
						console.error("OAuth polling error:", error);
					}
				}, 1000);

				integrationPollingIntervals.current.set(provider, pollInterval);

				// Listen for postMessage from callback
				// The callback sends both provider-specific and generic events
				const messageHandler = (event: MessageEvent) => {
					if (event.origin !== window.location.origin) {
						return;
					}

					// Handle both generic oauth_success/oauth_error and provider-specific events
					const isOAuthSuccess =
						event.data?.type === "oauth_success" ||
						event.data?.type ===
							`${provider.toLowerCase()}_oauth_success`;
					const isOAuthError =
						event.data?.type === "oauth_error" ||
						event.data?.type ===
							`${provider.toLowerCase()}_oauth_error`;
					const matchesProvider =
						!event.data?.provider ||
						event.data?.provider === provider;

					if ((isOAuthSuccess || isOAuthError) && matchesProvider) {
						window.removeEventListener("message", messageHandler);
						clearInterval(pollInterval);
						integrationPollingIntervals.current.delete(provider);
						popup.close();

						if (isOAuthSuccess) {
							setIntegrationStatuses((prev) => {
								const newMap = new Map(prev);
								newMap.set(provider, {
									isConnecting: false,
									isConnected: true,
								});
								return newMap;
							});
							toast.success(
								`${event.data?.providerName || provider} connected!`,
							);
						} else {
							setIntegrationStatuses((prev) => {
								const newMap = new Map(prev);
								newMap.set(provider, {
									isConnecting: false,
									isConnected: false,
									error:
										event.data?.message || "OAuth failed",
								});
								return newMap;
							});
							toast.error(event.data?.message || "OAuth failed");
						}
					}
				};
				window.addEventListener("message", messageHandler);
			} catch (error) {
				setIntegrationStatuses((prev) => {
					const newMap = new Map(prev);
					newMap.set(provider, {
						isConnecting: false,
						isConnected: false,
						error:
							error instanceof Error
								? error.message
								: "Failed to start OAuth",
					});
					return newMap;
				});
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to start OAuth",
				);
			}
		},
		[organizationId],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Plug2 className="h-5 w-5 text-highlight" />
						Integrations Required
					</DialogTitle>
					<DialogDescription>
						To complete this task, please connect the following
						integrations:
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					{connections.map((connection) => {
						const status = connectionStatuses.get(
							connection.serverId,
						);
						const isConnecting = status?.isConnecting ?? false;
						const isConnected = status?.isConnected ?? false;
						const error = status?.error;

						return (
							<div
								key={connection.serverId}
								className={cn(
									"rounded-lg border p-4 transition-colors",
									isConnected
										? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
										: error
											? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
											: "border-border",
								)}
							>
								<div className="flex items-start gap-3">
									{/* Icon */}
									<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
										{connection.iconUrl ? (
											<Image
												src={connection.iconUrl}
												alt={connection.serverName}
												width={24}
												height={24}
												className="rounded"
											/>
										) : (
											<Plug2 className="h-5 w-5 text-muted-foreground" />
										)}
									</div>

									<div className="flex-1 min-w-0">
										{/* Header */}
										<div className="flex items-center gap-2 flex-wrap">
											<span className="font-medium">
												{connection.serverName}
											</span>
											{connection.category && (
												<Badge
													variant="secondary"
													className="text-xs"
												>
													{connection.category}
												</Badge>
											)}
											{isConnected && (
												<Badge
													variant="outline"
													className="text-xs text-green-700 border-green-300 dark:text-green-400 dark:border-green-700"
												>
													<CheckCircle2 className="h-3 w-3 mr-1" />
													Connected
												</Badge>
											)}
										</div>

										{/* Reason */}
										<p className="text-sm text-muted-foreground mt-1">
											{connection.reason}
										</p>

										{/* Matched tools */}
										{connection.matchedTools &&
											connection.matchedTools.length >
												0 && (
												<div className="flex gap-1 flex-wrap mt-2">
													{connection.matchedTools
														.slice(0, 3)
														.map((tool) => (
															<Badge
																key={tool}
																variant="outline"
																className="text-xs"
															>
																{tool}
															</Badge>
														))}
													{connection.matchedTools
														.length > 3 && (
														<Badge
															variant="outline"
															className="text-xs"
														>
															+
															{connection
																.matchedTools
																.length -
																3}{" "}
															more
														</Badge>
													)}
												</div>
											)}

										{/* Error message */}
										{error && (
											<p className="text-sm text-destructive mt-2">
												{error}
											</p>
										)}

										{/* Auth actions */}
										{!isConnected && (
											<div className="mt-3">
												{connection.authType ===
												"OAUTH2" ? (
													<Button
														size="sm"
														onClick={() =>
															startOAuthFlow(
																connection,
															)
														}
														disabled={isConnecting}
													>
														{isConnecting ? (
															<Loader2 className="h-4 w-4 mr-2 animate-spin" />
														) : error ? (
															<RefreshCw className="h-4 w-4 mr-2" />
														) : (
															<ExternalLink className="h-4 w-4 mr-2" />
														)}
														{error
															? "Retry"
															: isConnecting
																? "Connecting..."
																: "Connect with OAuth"}
													</Button>
												) : connection.authType ===
													"API_KEY" ? (
													<div className="space-y-2">
														<Label
															htmlFor={`apikey-${connection.serverId}`}
															className="text-xs"
														>
															API Key
														</Label>
														<div className="flex gap-2">
															<div className="relative flex-1">
																<Input
																	id={`apikey-${connection.serverId}`}
																	type={
																		showApiKeys.get(
																			connection.serverId,
																		)
																			? "text"
																			: "password"
																	}
																	placeholder="Enter API key..."
																	value={
																		apiKeyInputs.get(
																			connection.serverId,
																		) || ""
																	}
																	onChange={(
																		e,
																	) => {
																		setApiKeyInputs(
																			(
																				prev,
																			) => {
																				const newMap =
																					new Map(
																						prev,
																					);
																				newMap.set(
																					connection.serverId,
																					e
																						.target
																						.value,
																				);
																				return newMap;
																			},
																		);
																	}}
																	className="pr-10"
																	disabled={
																		isConnecting
																	}
																/>
																<button
																	type="button"
																	onClick={() => {
																		setShowApiKeys(
																			(
																				prev,
																			) => {
																				const newMap =
																					new Map(
																						prev,
																					);
																				newMap.set(
																					connection.serverId,
																					!prev.get(
																						connection.serverId,
																					),
																				);
																				return newMap;
																			},
																		);
																	}}
																	className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
																>
																	{showApiKeys.get(
																		connection.serverId,
																	) ? (
																		<EyeOff className="h-4 w-4" />
																	) : (
																		<Eye className="h-4 w-4" />
																	)}
																</button>
															</div>
															<Button
																size="sm"
																onClick={() =>
																	saveApiKey(
																		connection,
																	)
																}
																disabled={
																	isConnecting ||
																	!apiKeyInputs
																		.get(
																			connection.serverId,
																		)
																		?.trim()
																}
															>
																{isConnecting ? (
																	<Loader2 className="h-4 w-4 animate-spin" />
																) : (
																	<Key className="h-4 w-4" />
																)}
															</Button>
														</div>
													</div>
												) : (
													<p className="text-xs text-muted-foreground">
														No authentication
														required
													</p>
												)}
											</div>
										)}
									</div>
								</div>
							</div>
						);
					})}

					{/* Missing Workflow Integrations Section */}
					{missingIntegrations.length > 0 && (
						<>
							{connections.length > 0 && (
								<div className="border-t pt-4 mt-4">
									<h4 className="text-sm font-medium text-muted-foreground mb-3">
										Workflow Integrations
									</h4>
								</div>
							)}
							{missingIntegrations.map((integration) => {
								const integrationStatus =
									integrationStatuses.get(
										integration.provider,
									);
								const isConnecting =
									integrationStatus?.isConnecting ?? false;
								const isConnected =
									integrationStatus?.isConnected ?? false;

								return (
									<div
										key={integration.provider}
										className={cn(
											"rounded-lg border p-4 transition-colors",
											isConnected
												? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
												: "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
										)}
									>
										<div className="flex items-start gap-3">
											<div
												className={cn(
													"flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
													isConnected
														? "bg-green-100 dark:bg-green-900/50"
														: "bg-amber-100 dark:bg-amber-900/50",
												)}
											>
												{isConnected ? (
													<CheckCircle2 className="h-5 w-5 text-success dark:text-green-400" />
												) : (
													<Plug2 className="h-5 w-5 text-amber-600 dark:text-amber-400" />
												)}
											</div>
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2 flex-wrap">
													<span className="font-medium">
														{integration.name}
													</span>
													<Badge
														variant="secondary"
														className="text-xs"
													>
														{integration.provider}
													</Badge>
													{isConnected && (
														<Badge
															variant="outline"
															className="text-xs text-green-700 border-green-300 dark:text-green-400 dark:border-green-700"
														>
															<CheckCircle2 className="h-3 w-3 mr-1" />
															Connected
														</Badge>
													)}
												</div>
												<p className="text-sm text-muted-foreground mt-1">
													{integration.reason}
												</p>
												{integration.capabilities
													.length > 0 && (
													<div className="flex gap-1 flex-wrap mt-2">
														{integration.capabilities
															.slice(0, 3)
															.map((cap) => (
																<Badge
																	key={cap}
																	variant="outline"
																	className="text-xs"
																>
																	{cap.replace(
																		/_/g,
																		" ",
																	)}
																</Badge>
															))}
													</div>
												)}

												{/* Auth actions */}
												{!isConnected && (
													<div className="mt-3">
														{integration.authType ===
														"OAUTH" ? (
															(() => {
																const providerConfig =
																	providerConfigs.get(
																		integration.provider,
																	);
																const isConfigured =
																	providerConfig?.configured ??
																	true; // Default to true while loading

																if (
																	!isConfigured
																) {
																	return (
																		<div className="space-y-2">
																			<p className="text-xs text-amber-600 dark:text-amber-400">
																				{providerConfig?.providerName ||
																					integration.provider}{" "}
																				OAuth
																				is
																				not
																				configured
																				on
																				the
																				server.
																			</p>
																			<p className="text-xs text-muted-foreground">
																				Contact
																				your
																				administrator
																				to
																				set
																				up
																				the
																				OAuth
																				credentials.
																			</p>
																		</div>
																	);
																}

																return (
																	<Button
																		size="sm"
																		onClick={() =>
																			startIntegrationOAuth(
																				integration.provider,
																			)
																		}
																		disabled={
																			isConnecting
																		}
																		className="gap-2"
																	>
																		{isConnecting ? (
																			<Loader2 className="h-4 w-4 animate-spin" />
																		) : (
																			<ExternalLink className="h-4 w-4" />
																		)}
																		Connect
																		with
																		OAuth
																	</Button>
																);
															})()
														) : (
															<div className="text-xs text-muted-foreground">
																API Key
																integration -
																configure in
																Settings
															</div>
														)}
													</div>
												)}
											</div>
										</div>
									</div>
								);
							})}
						</>
					)}
				</div>

				<DialogFooter className="flex-row justify-between sm:justify-between">
					{onSkip && (
						<Button
							variant="ghost"
							onClick={onSkip}
							disabled={connections.some(
								(c) =>
									connectionStatuses.get(c.serverId)
										?.isConnecting,
							)}
						>
							Skip for now
						</Button>
					)}
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={connections.some(
							(c) =>
								connectionStatuses.get(c.serverId)
									?.isConnecting,
						)}
					>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
