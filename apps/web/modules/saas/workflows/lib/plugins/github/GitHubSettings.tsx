"use client";

/**
 * GitHub Settings Component
 *
 * Supports both OAuth and Personal Access Token (PAT) authentication.
 * OAuth is recommended for better security and automatic token refresh.
 */

import { openOAuthPopup, POPUP_BLOCKED_MESSAGE } from "@shared/lib/oauth-popup";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	CheckCircle2Icon,
	ExternalLinkIcon,
	EyeIcon,
	EyeOffIcon,
	GithubIcon,
	Loader2Icon,
	LogOutIcon,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { IntegrationSettingsProps } from "../types";

export function GitHubSettings({
	apiKey,
	// hasKey is part of IntegrationSettingsProps but not used for OAuth flow
	onApiKeyChange,
	organizationId,
}: IntegrationSettingsProps) {
	const [showPat, setShowPat] = useState(false);
	const [usePatMode, setUsePatMode] = useState(false);
	const queryClient = useQueryClient();

	// Check GitHub OAuth connection status
	const { data: githubStatus, isLoading: isLoadingStatus } = useQuery({
		queryKey: ["github-oauth-status", organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.integrations.github.status({
					organizationId: organizationId ?? null,
				});
			} catch (error) {
				console.debug("[GitHubSettings] Status check failed:", error);
				return { connected: false };
			}
		},
		staleTime: 30000,
	});

	// Check if OAuth is configured on the server
	const { data: oauthConfigured } = useQuery({
		queryKey: ["github-oauth-configured"],
		queryFn: async () => {
			try {
				const result =
					await orpcClient.integrations.github.isConfigured({});
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
			return await orpcClient.integrations.github.disconnect({
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("GitHub disconnected");
			queryClient.invalidateQueries({
				queryKey: ["github-oauth-status"],
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
					: "Failed to disconnect GitHub",
			);
		},
	});

	// Listen for OAuth popup messages
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}

			if (event.data?.type === "github_oauth_success") {
				toast.success(
					event.data.message || "GitHub connected successfully!",
				);
				queryClient.invalidateQueries({
					queryKey: ["github-oauth-status"],
				});
				queryClient.invalidateQueries({
					queryKey: ["workflow-integrations"],
				});
				queryClient.invalidateQueries({
					queryKey: ["data-connections"],
				});
			} else if (event.data?.type === "github_oauth_error") {
				toast.error(event.data.message || "Failed to connect GitHub");
			}
		};

		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [queryClient]);

	const handleConnectGitHub = useCallback(async () => {
		try {
			const callbackUrl = `${window.location.origin}/api/integrations/github/oauth/callback`;
			// Relative on purpose: the callback page rejects absolute URLs, even
			// same-origin ones, and falls back to the settings page.
			const returnUrl =
				window.location.pathname +
				window.location.search +
				window.location.hash;

			const result = await orpcClient.integrations.github.start({
				redirectUri: callbackUrl,
				returnUrl,
				organizationId: organizationId ?? null,
			});

			const popup = openOAuthPopup({
				url: result.authorizationUrl,
				name: "github-oauth",
			});

			if (!popup) {
				toast.error(POPUP_BLOCKED_MESSAGE);
				return;
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start GitHub OAuth",
			);
		}
	}, [organizationId]);

	const handleDisconnect = useCallback(() => {
		disconnectMutation.mutate();
	}, [disconnectMutation]);

	// Show OAuth status if connected
	if (githubStatus?.connected) {
		return (
			<div className="space-y-6">
				{/* Connected Status */}
				<div className="p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
					<div className="flex items-start gap-4">
						{githubStatus.avatarUrl ? (
							<Image
								src={githubStatus.avatarUrl}
								alt={githubStatus.login || "GitHub avatar"}
								width={48}
								height={48}
								className="h-12 w-12 rounded-full"
								unoptimized
							/>
						) : (
							<div className="h-12 w-12 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
								<GithubIcon className="h-6 w-6" />
							</div>
						)}
						<div className="flex-1">
							<div className="flex items-center gap-2">
								<CheckCircle2Icon className="h-5 w-5 text-success dark:text-green-400" />
								<span className="font-medium text-success">
									GitHub Connected
								</span>
							</div>
							<p className="text-sm text-green-700 dark:text-green-300 mt-1">
								Signed in as{" "}
								<span className="font-semibold">
									@{githubStatus.login}
								</span>
								{githubStatus.name && ` (${githubStatus.name})`}
							</p>
							{githubStatus.connectedAt && (
								<p className="text-xs text-success dark:text-green-400 mt-1">
									Connected{" "}
									{new Date(
										githubStatus.connectedAt,
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

				<p className="text-sm text-muted-foreground">
					Your GitHub account is connected via OAuth. The task agent
					can access repositories, create issues, and submit pull
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
					<div className="p-4 rounded-lg border bg-muted/30">
						<div className="flex items-center gap-3 mb-3">
							<GithubIcon className="h-8 w-8" />
							<div>
								<h3 className="font-semibold">
									Connect with GitHub
								</h3>
								<p className="text-sm text-muted-foreground">
									Recommended: Sign in with your GitHub
									account for secure access
								</p>
							</div>
						</div>
						<Button
							onClick={handleConnectGitHub}
							disabled={isLoadingStatus}
							className="w-full"
						>
							{isLoadingStatus ? (
								<Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
							) : (
								<GithubIcon className="h-4 w-4 mr-2" />
							)}
							Connect GitHub Account
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
						<Label htmlFor="github-pat">GitHub Token</Label>
						<div className="relative">
							<Input
								id="github-pat"
								type={showPat ? "text" : "password"}
								value={apiKey}
								onChange={(e) => onApiKeyChange(e.target.value)}
								placeholder="ghp_xxxxxxxxxxxx"
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
							>
								{showPat ? (
									<EyeOffIcon className="h-4 w-4 text-muted-foreground" />
								) : (
									<EyeIcon className="h-4 w-4 text-muted-foreground" />
								)}
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							Create a personal access token with repo permissions
						</p>
						<a
							href="https://github.com/settings/tokens"
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs text-primary hover:underline inline-flex items-center gap-1"
						>
							github.com/settings/tokens
							<ExternalLinkIcon className="h-3 w-3" />
						</a>
					</div>
				</div>
			)}

			{/* Info Note */}
			{!githubStatus?.connected && (
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
