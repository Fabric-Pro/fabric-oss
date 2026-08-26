"use client";

/**
 * GitLab Settings Component
 *
 * Supports both OAuth (recommended) and Personal Access Token (PAT) authentication.
 * OAuth is recommended for better security and automatic token refresh.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	ExternalLinkIcon,
	EyeIcon,
	EyeOffIcon,
	Loader2Icon,
	LogOutIcon,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { IntegrationSettingsProps } from "../types";
import { GitLabIcon } from "./icon";

export function GitLabSettings({
	apiKey,
	onApiKeyChange,
	organizationId,
}: IntegrationSettingsProps) {
	const [showPat, setShowPat] = useState(false);
	const [usePatMode, setUsePatMode] = useState(false);
	const queryClient = useQueryClient();

	// Check GitLab OAuth connection status
	const { data: gitlabStatus, isLoading: isLoadingStatus } = useQuery({
		queryKey: ["gitlab-oauth-status", organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.integrations.gitlab.status({
					organizationId: organizationId ?? null,
				});
			} catch (error) {
				console.debug("[GitLabSettings] Status check failed:", error);
				return { connected: false };
			}
		},
		staleTime: 30000,
	});

	// Check if OAuth is configured on the server
	const { data: oauthConfigured } = useQuery({
		queryKey: ["gitlab-oauth-configured"],
		queryFn: async () => {
			try {
				const result =
					await orpcClient.integrations.gitlab.isConfigured({});
				return result.configured;
			} catch (_error) {
				return false;
			}
		},
		staleTime: 60000,
	});

	// Disconnect mutation
	const disconnectMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.integrations.gitlab.disconnect({
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: (result) => {
			toast.success("GitLab disconnected");
			if (result.revocationWarning) {
				toast.warning(result.revocationWarning, { duration: 10000 });
			}
			queryClient.invalidateQueries({
				queryKey: ["gitlab-oauth-status"],
			});
			queryClient.invalidateQueries({
				queryKey: ["account-settings-integrations"],
			});
			queryClient.invalidateQueries({
				queryKey: ["workflow-integrations"],
			});
			queryClient.invalidateQueries({
				queryKey: ["data-connections"],
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to disconnect GitLab",
			);
		},
	});

	// Listen for OAuth popup messages
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}

			if (event.data?.type === "gitlab_oauth_success") {
				toast.success(
					event.data.message || "GitLab connected successfully!",
				);
				queryClient.invalidateQueries({
					queryKey: ["gitlab-oauth-status"],
				});
				queryClient.invalidateQueries({
					queryKey: ["account-settings-integrations"],
				});
				queryClient.invalidateQueries({
					queryKey: ["workflow-integrations"],
				});
				queryClient.invalidateQueries({
					queryKey: ["data-connections"],
				});
			} else if (event.data?.type === "gitlab_oauth_error") {
				toast.error(event.data.message || "Failed to connect GitLab");
			}
		};

		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [queryClient]);

	const handleConnectGitLab = useCallback(async () => {
		try {
			// Fast-path: user already has an MCPConfig (e.g., they connected
			// via MCP Registry) but no WorkflowIntegration. Reconcile to
			// populate the WI row from the existing token — no second OAuth
			// dance. See gitlab-oauth-unification spec §5.
			try {
				const state =
					await orpcClient.integrations.gitlab.connectionState({
						organizationId: organizationId ?? null,
					});
				if (state.hasMcpConfig && !state.hasWorkflowIntegration) {
					const result =
						await orpcClient.integrations.gitlab.reconcile({
							organizationId: organizationId ?? null,
						});
					if (result.status === "RECONCILED") {
						toast.success("GitLab PM connection restored", {
							description:
								"Reused your existing GitLab connection from the MCP Registry — no second OAuth needed.",
						});
						queryClient.invalidateQueries({
							queryKey: ["gitlab-oauth-status"],
						});
						queryClient.invalidateQueries({
							queryKey: ["workflow-integrations"],
						});
						return;
					}
					if (result.status === "NEEDS_REAUTH") {
						toast.error("GitLab token needs re-authorization", {
							description:
								"Your existing GitLab connection is no longer valid. Reconnect to continue.",
						});
						// fall through to full OAuth
					}
				}
			} catch (reconcileErr) {
				console.warn(
					"[GitLab reconcile] failed; falling through to OAuth",
					reconcileErr,
				);
			}

			const callbackUrl = `${window.location.origin}/api/integrations/gitlab/oauth/callback`;
			const returnUrl =
				window.location.pathname +
				window.location.search +
				window.location.hash;

			const result = await orpcClient.integrations.gitlab.start({
				redirectUri: callbackUrl,
				returnUrl,
				organizationId: organizationId ?? null,
			});

			// Open OAuth popup
			const width = 600;
			const height = 700;
			const left = window.screenX + (window.outerWidth - width) / 2;
			const top = window.screenY + (window.outerHeight - height) / 2;

			window.open(
				result.authorizationUrl,
				"gitlab-oauth",
				`width=${width},height=${height},left=${left},top=${top}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start GitLab OAuth",
			);
		}
	}, [organizationId, queryClient]);

	const handleDisconnect = useCallback(() => {
		disconnectMutation.mutate();
	}, [disconnectMutation]);

	const retryIngestionMutation = useMutation({
		mutationFn: async () =>
			orpcClient.integrations.gitlab.retryToolIngestion({
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			toast.success("Retrying tool ingestion...");
			queryClient.invalidateQueries({
				queryKey: ["gitlab-oauth-status"],
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to retry",
			);
		},
	});

	// Show OAuth status if connected
	if (gitlabStatus?.connected) {
		return (
			<div className="space-y-6">
				{/* Connected Status */}
				<div className="p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
					<div className="flex items-start gap-4">
						{gitlabStatus.avatarUrl ? (
							<Image
								src={gitlabStatus.avatarUrl}
								alt={gitlabStatus.username || "GitLab avatar"}
								width={48}
								height={48}
								className="h-12 w-12 rounded-full"
								unoptimized
							/>
						) : (
							<div className="h-12 w-12 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
								<GitLabIcon className="h-6 w-6" />
							</div>
						)}
						<div className="flex-1">
							<div className="flex items-center gap-2">
								<CheckCircle2Icon className="h-5 w-5 text-success dark:text-green-400" />
								<span className="font-medium text-success">
									GitLab Connected
								</span>
							</div>
							<p className="text-sm text-green-700 dark:text-green-300 mt-1">
								Signed in as{" "}
								<span className="font-semibold">
									@{gitlabStatus.username}
								</span>
								{gitlabStatus.name && ` (${gitlabStatus.name})`}
							</p>
							{gitlabStatus.connectedAt && (
								<p className="text-xs text-success dark:text-green-400 mt-1">
									Connected{" "}
									<time
										dateTime={new Date(
											gitlabStatus.connectedAt,
										).toISOString()}
									>
										{new Date(gitlabStatus.connectedAt)
											.toISOString()
											.slice(0, 10)}
									</time>
								</p>
							)}
						</div>
						<AlertDialog>
							<AlertDialogTrigger asChild>
								<Button
									variant="outline"
									size="sm"
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
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										Disconnect GitLab?
									</AlertDialogTitle>
									<AlertDialogDescription>
										This removes the OAuth credential for{" "}
										<span className="font-semibold">
											@{gitlabStatus.username}
										</span>
										. Workflows, agents, and PM-sync that
										use GitLab will fail until you
										reconnect. This action cannot be undone.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>
										Cancel
									</AlertDialogCancel>
									<AlertDialogAction
										onClick={handleDisconnect}
										variant="destructive"
									>
										Disconnect
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				</div>

				{gitlabStatus.settings?.lastToolIngestError && (
					<Alert variant="default" className="mt-2">
						<AlertTriangleIcon className="size-4" />
						<AlertTitle>Tools partially loaded</AlertTitle>
						<AlertDescription>
							Connected, but loading GitLab tools failed:{" "}
							{gitlabStatus.settings.lastToolIngestError.message}.{" "}
							<Button
								variant="link"
								size="sm"
								onClick={() => retryIngestionMutation.mutate()}
								disabled={retryIngestionMutation.isPending}
								className="h-auto p-0 text-sm"
							>
								{retryIngestionMutation.isPending
									? "Retrying..."
									: "Retry"}
							</Button>
						</AlertDescription>
					</Alert>
				)}

				<p className="text-sm text-muted-foreground">
					Your GitLab account is connected via OAuth. The task agent
					can access projects, create issues, and submit merge
					requests on your behalf.
				</p>
			</div>
		);
	}

	// Not connected - show OAuth button or PAT form
	return (
		<div className="space-y-6">
			{/* OAuth Section (if configured) */}
			{oauthConfigured && (
				<div className="space-y-4">
					{gitlabStatus?.needsReauth && (
						<Alert variant="error">
							<AlertTriangleIcon className="h-4 w-4" />
							<AlertTitle>
								GitLab token needs re-authorization
							</AlertTitle>
							<AlertDescription>
								Your GitLab refresh token is no longer valid —
								agents and PM features can&apos;t reach GitLab
								until you reconnect.
							</AlertDescription>
						</Alert>
					)}
					<div className="p-4 rounded-lg border bg-muted/30">
						<div className="flex items-center gap-3 mb-3">
							<GitLabIcon className="h-8 w-8" />
							<div>
								<h3 className="font-semibold">
									{gitlabStatus?.needsReauth
										? "Reconnect GitLab"
										: "Connect with GitLab"}
								</h3>
								<p className="text-sm text-muted-foreground">
									{gitlabStatus?.needsReauth
										? "Re-authorize to restore agent and PM access."
										: "Recommended: Sign in with your GitLab account for secure access"}
								</p>
							</div>
						</div>
						<Button
							onClick={handleConnectGitLab}
							disabled={isLoadingStatus}
							className="w-full"
							variant={
								gitlabStatus?.needsReauth
									? "destructive"
									: "default"
							}
						>
							{isLoadingStatus ? (
								<Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
							) : (
								<GitLabIcon className="h-4 w-4 mr-2" />
							)}
							{gitlabStatus?.needsReauth
								? "Reconnect GitLab"
								: "Connect GitLab Account"}
						</Button>
					</div>

					{!usePatMode && (
						<div className="text-center">
							<button
								type="button"
								onClick={() => setUsePatMode(true)}
								className="text-sm text-muted-foreground hover:text-foreground underline"
							>
								Or use a Personal Access Token instead
							</button>
						</div>
					)}
				</div>
			)}

			{/* PAT Section — only show after OAuth config check completes */}
			{(usePatMode || oauthConfigured === false) && (
				<div className="space-y-4">
					{oauthConfigured && usePatMode && (
						<div className="flex items-center justify-between">
							<h4 className="text-sm font-medium">
								Personal Access Token
							</h4>
							<button
								type="button"
								onClick={() => setUsePatMode(false)}
								className="text-sm text-primary hover:underline"
							>
								Use OAuth instead
							</button>
						</div>
					)}

					<div className="space-y-2">
						<Label htmlFor="gitlab-pat">GitLab Access Token</Label>
						<div className="relative">
							<Input
								id="gitlab-pat"
								type={showPat ? "text" : "password"}
								value={apiKey}
								onChange={(e) => onApiKeyChange(e.target.value)}
								placeholder="glpat-xxxxxxxxxxxx"
								className="pr-10"
								autoComplete="off"
								data-1p-ignore
								data-lpignore="true"
							/>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
								onClick={() => setShowPat(!showPat)}
								aria-label={
									showPat ? "Hide token" : "Show token"
								}
							>
								{showPat ? (
									<EyeOffIcon className="h-4 w-4 text-muted-foreground" />
								) : (
									<EyeIcon className="h-4 w-4 text-muted-foreground" />
								)}
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							Create a personal access token with api permissions
						</p>
						<a
							href="https://gitlab.com/-/user_settings/personal_access_tokens"
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs text-primary hover:underline inline-flex items-center gap-1"
						>
							GitLab Personal Access Tokens
							<ExternalLinkIcon className="h-3 w-3" />
						</a>
					</div>
				</div>
			)}

			{/* Info Note */}
			{!gitlabStatus?.connected && (
				<div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
					<p className="text-xs text-blue-700 dark:text-blue-300">
						<strong>Note:</strong> OAuth is recommended for better
						security. Personal Access Tokens are stored encrypted
						but may require manual rotation.
					</p>
				</div>
			)}
		</div>
	);
}
