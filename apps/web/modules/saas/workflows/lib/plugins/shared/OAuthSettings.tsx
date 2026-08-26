"use client";

/**
 * Reusable OAuth Settings Component
 *
 * Generic component for OAuth-based integrations.
 * Handles the OAuth flow, status display, and disconnect functionality.
 */

import { toFriendlyPermissionError } from "@saas/data-connections/lib/permission-error-copy";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	CheckCircle2Icon,
	ExternalLinkIcon,
	Loader2Icon,
	LogOutIcon,
	RefreshCwIcon,
} from "lucide-react";
import Image from "next/image";
import {
	type ComponentType,
	type ReactNode,
	useCallback,
	useEffect,
} from "react";
import { toast } from "sonner";

type OAuthProviderType =
	| "ASANA"
	| "GITHUB"
	| "GOOGLE_DRIVE"
	| "HUBSPOT"
	| "INTERCOM"
	| "LINEAR"
	| "MICROSOFT_GRAPH"
	| "SLACK"
	| "NOTION";

interface OAuthSettingsProps {
	provider: OAuthProviderType;
	providerName: string;
	providerIcon: ComponentType<{ className?: string }>;
	providerColor?: string;
	description: string;
	helpText?: string;
	helpLink?: { text: string; url: string };
	scopes?: string[];
	/** Scopes requested as user-level permissions (e.g. Slack user_scope) */
	userScopes?: string[];
	onConnectionChange?: (connected: boolean) => void;
	// Fallback content when OAuth is not configured (e.g., API key form)
	fallbackContent?: ReactNode;
	/** Organization ID - pass null for personal context, string for org context */
	organizationId?: string | null;
}

export function OAuthSettings({
	provider,
	providerName,
	providerIcon: ProviderIcon,
	providerColor = "text-foreground",
	description,
	helpText,
	helpLink,
	scopes,
	userScopes,
	onConnectionChange,
	fallbackContent,
	organizationId,
}: OAuthSettingsProps) {
	const queryClient = useQueryClient();
	const supportsToolRefresh =
		provider === "GITHUB" || provider === "MICROSOFT_GRAPH";

	// Check if OAuth is configured on the server (env vars or DB-stored app credentials)
	const { data: configStatus, isLoading: isLoadingConfig } = useQuery({
		queryKey: ["oauth-configured", provider, organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.integrations.oauth.isConfigured({
					provider,
					organizationId,
				});
			} catch {
				return { configured: false, providerName };
			}
		},
		staleTime: 60000,
	});

	// Check connection status - pass organizationId for proper tenant isolation
	const { data: connectionStatus, isLoading: isLoadingStatus } = useQuery({
		queryKey: ["oauth-status", provider, organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.integrations.oauth.status({
					provider,
					organizationId,
				});
			} catch {
				return { connected: false, providerName };
			}
		},
		staleTime: 30000,
	});

	// Disconnect mutation - pass organizationId for proper tenant isolation
	const disconnectMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.integrations.oauth.disconnect({
				provider,
				organizationId,
			});
		},
		onSuccess: () => {
			toast.success(`${providerName} disconnected`);
			queryClient.invalidateQueries({
				queryKey: ["oauth-status", provider, organizationId],
			});
			onConnectionChange?.(false);
		},
		onError: (error) => {
			toast.error(
				toFriendlyPermissionError(
					error,
					`Failed to disconnect ${providerName}`,
				),
			);
		},
	});

	// Refresh tools mutation - trigger re-ingestion into Qdrant
	const refreshToolsMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.integrations.oauth.refreshTools({
				provider,
				organizationId,
			});
		},
		onSuccess: (result) => {
			if (result.success) {
				toast.success(result.message);
			} else {
				toast.error(result.error || result.message);
			}
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: `Failed to refresh ${providerName} tools`,
			);
		},
	});

	// Listen for OAuth popup messages
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}

			if (
				event.data?.type === "oauth_success" &&
				event.data?.provider === providerName
			) {
				toast.success(
					event.data.message || `${providerName} connected!`,
				);
				queryClient.invalidateQueries({
					queryKey: ["oauth-status", provider, organizationId],
				});
				onConnectionChange?.(true);
			} else if (
				event.data?.type === "oauth_error" &&
				event.data?.provider === providerName
			) {
				toast.error(
					event.data.message || `Failed to connect ${providerName}`,
				);
			}
		};

		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [
		provider,
		providerName,
		queryClient,
		onConnectionChange,
		organizationId,
	]);

	const handleConnect = useCallback(async () => {
		try {
			const callbackUrl = `${window.location.origin}/api/integrations/oauth/callback`;
			const returnUrl = window.location.href;

			const result = await orpcClient.integrations.oauth.start({
				provider,
				redirectUri: callbackUrl,
				returnUrl,
				organizationId,
			});

			// Open OAuth popup
			const width = 600;
			const height = 700;
			const left = window.screenX + (window.outerWidth - width) / 2;
			const top = window.screenY + (window.outerHeight - height) / 2;

			window.open(
				result.authorizationUrl,
				`${provider.toLowerCase()}-oauth`,
				`width=${width},height=${height},left=${left},top=${top}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: `Failed to start ${providerName} OAuth`,
			);
		}
	}, [provider, providerName, organizationId]);

	const handleDisconnect = useCallback(() => {
		disconnectMutation.mutate();
	}, [disconnectMutation]);

	const handleRefreshTools = useCallback(() => {
		refreshToolsMutation.mutate();
	}, [refreshToolsMutation]);

	// Loading state
	if (isLoadingConfig || isLoadingStatus) {
		return (
			<div className="flex items-center justify-center p-8">
				<Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	// Connected state
	if (connectionStatus?.connected) {
		return (
			<div className="space-y-6">
				<div className="p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
					<div className="flex items-start gap-4">
						{connectionStatus.avatarUrl ? (
							<Image
								src={connectionStatus.avatarUrl}
								alt={connectionStatus.login || providerName}
								width={48}
								height={48}
								className="h-12 w-12 rounded-full"
								unoptimized
							/>
						) : (
							<div
								className={`h-12 w-12 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center ${providerColor}`}
							>
								<ProviderIcon className="h-6 w-6" />
							</div>
						)}
						<div className="flex-1">
							<div className="flex items-center gap-2">
								<CheckCircle2Icon className="h-5 w-5 text-success dark:text-green-400" />
								<span className="font-medium text-success">
									{providerName} Connected
								</span>
							</div>
							<p className="text-sm text-green-700 dark:text-green-300 mt-1">
								{connectionStatus.name ? (
									<>
										Signed in as{" "}
										<span className="font-semibold">
											{connectionStatus.login}
										</span>{" "}
										({connectionStatus.name})
									</>
								) : (
									<>
										Signed in as{" "}
										<span className="font-semibold">
											{connectionStatus.login}
										</span>
									</>
								)}
							</p>
							{connectionStatus.connectedAt && (
								<p className="text-xs text-success dark:text-green-400 mt-1">
									Connected{" "}
									{new Date(
										connectionStatus.connectedAt,
									).toLocaleDateString()}
								</p>
							)}
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={handleDisconnect}
							disabled={disconnectMutation.isPending}
							className="text-destructive hover:text-red-700 hover:bg-red-50"
						>
							{disconnectMutation.isPending ? (
								<Loader2Icon className="h-4 w-4 animate-spin" />
							) : (
								<>
									<LogOutIcon className="h-4 w-4 mr-1" />
									Disconnect
								</>
							)}
						</Button>
					</div>
				</div>

				{supportsToolRefresh ? (
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleRefreshTools}
							disabled={refreshToolsMutation.isPending}
							className="flex-1"
						>
							{refreshToolsMutation.isPending ? (
								<>
									<Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
									Refreshing Tools...
								</>
							) : (
								<>
									<RefreshCwIcon className="h-4 w-4 mr-2" />
									Refresh Tools
								</>
							)}
						</Button>
					</div>
				) : null}

				<p className="text-sm text-muted-foreground">{description}</p>

				{scopes?.length || userScopes?.length ? (
					<div className="text-xs text-muted-foreground space-y-0.5">
						{scopes && scopes.length > 0 && (
							<div>
								<span className="font-medium">
									Bot permissions:
								</span>{" "}
								{scopes.join(", ")}
							</div>
						)}
						{userScopes && userScopes.length > 0 && (
							<div>
								<span className="font-medium">
									User permissions:
								</span>{" "}
								{userScopes.join(", ")}
							</div>
						)}
					</div>
				) : null}
			</div>
		);
	}

	// Not configured - show fallback or message
	if (!configStatus?.configured) {
		if (fallbackContent) {
			return <>{fallbackContent}</>;
		}

		return (
			<div className="p-4 rounded-lg border bg-muted/30">
				<div className="flex items-center gap-3 mb-3">
					<ProviderIcon className={`h-8 w-8 ${providerColor}`} />
					<div>
						<h3 className="font-semibold">{providerName}</h3>
						<p className="text-sm text-muted-foreground">
							OAuth not configured on server
						</p>
					</div>
				</div>
				<p className="text-sm text-muted-foreground">
					Please contact your administrator to configure{" "}
					{providerName} OAuth credentials.
				</p>
			</div>
		);
	}

	// Not connected - show connect button
	return (
		<div className="space-y-6">
			<div className="p-4 rounded-lg border bg-muted/30">
				<div className="flex items-center gap-3 mb-3">
					<ProviderIcon className={`h-8 w-8 ${providerColor}`} />
					<div>
						<h3 className="font-semibold">
							Connect with {providerName}
						</h3>
						<p className="text-sm text-muted-foreground">
							{description}
						</p>
					</div>
				</div>
				<Button onClick={handleConnect} className="w-full">
					<ProviderIcon className="h-4 w-4 mr-2" />
					Connect {providerName}
				</Button>
			</div>

			{helpText && (
				<p className="text-sm text-muted-foreground">{helpText}</p>
			)}

			{helpLink && (
				<a
					href={helpLink.url}
					target="_blank"
					rel="noopener noreferrer"
					className="text-sm text-primary hover:underline inline-flex items-center gap-1"
				>
					{helpLink.text}
					<ExternalLinkIcon className="h-3 w-3" />
				</a>
			)}

			{scopes?.length || userScopes?.length ? (
				<div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
					{scopes && scopes.length > 0 && (
						<p className="text-xs text-blue-700 dark:text-blue-300">
							<strong>Bot permissions:</strong>{" "}
							{scopes.join(", ")}
						</p>
					)}
					{userScopes && userScopes.length > 0 && (
						<p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
							<strong>User permissions:</strong>{" "}
							{userScopes.join(", ")}
						</p>
					)}
				</div>
			) : null}
		</div>
	);
}
