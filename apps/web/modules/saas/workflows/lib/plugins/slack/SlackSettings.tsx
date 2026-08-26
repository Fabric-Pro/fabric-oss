"use client";

/**
 * Slack Settings Component
 *
 * Supports two connection methods:
 * 1. OAuth flow (when app credentials are configured via .env or UI)
 * 2. Direct bot token paste (simpler — user installs app and copies the token)
 *
 * The bot token approach is shown as fallback when OAuth app credentials
 * are not configured, or as an alternative tab.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	CheckCircle2Icon,
	ExternalLinkIcon,
	KeyIcon,
	Loader2Icon,
	LogOutIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { OAuthSettings } from "../shared/OAuthSettings";
import type { IntegrationSettingsProps } from "../types";
import { SlackIcon } from "./icon";

function SlackBotTokenForm({
	organizationId,
	onSaved,
}: {
	organizationId?: string | null;
	onSaved: () => void;
}) {
	const [botToken, setBotToken] = useState("");
	const queryClient = useQueryClient();

	// Check if already connected
	const { data: connectionStatus, isLoading } = useQuery({
		queryKey: ["oauth-status", "SLACK", organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.integrations.oauth.status({
					provider: "SLACK",
					organizationId,
				});
			} catch {
				return { connected: false, providerName: "Slack" };
			}
		},
		staleTime: 30000,
	});

	const saveMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.integrations.oauth.saveBotToken({
				provider: "SLACK",
				botToken,
				organizationId,
			});
		},
		onSuccess: (result) => {
			toast.success(result.message);
			queryClient.invalidateQueries({
				queryKey: ["oauth-status", "SLACK", organizationId],
			});
			onSaved();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to save token",
			);
		},
	});

	const disconnectMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.integrations.oauth.disconnect({
				provider: "SLACK",
				organizationId,
			});
		},
		onSuccess: () => {
			toast.success("Slack disconnected");
			queryClient.invalidateQueries({
				queryKey: ["oauth-status", "SLACK", organizationId],
			});
		},
	});

	const handleSave = useCallback(() => {
		if (!botToken.trim()) {
			toast.error("Bot token is required");
			return;
		}
		if (!botToken.startsWith("xoxb-")) {
			toast.error("Invalid token format. Bot tokens start with 'xoxb-'");
			return;
		}
		saveMutation.mutate();
	}, [botToken, saveMutation]);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	// Connected state
	if (connectionStatus?.connected) {
		return (
			<div className="space-y-4">
				<div className="p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
					<div className="flex items-start gap-4">
						<div className="h-12 w-12 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-purple-600">
							<SlackIcon className="h-6 w-6" />
						</div>
						<div className="flex-1">
							<div className="flex items-center gap-2">
								<CheckCircle2Icon className="h-5 w-5 text-success dark:text-green-400" />
								<span className="font-medium text-success">
									Slack Connected
								</span>
							</div>
							{connectionStatus.login && (
								<p className="text-sm text-green-700 dark:text-green-300 mt-1">
									Connected as{" "}
									<span className="font-semibold">
										{connectionStatus.login}
									</span>
									{connectionStatus.name &&
										` (${connectionStatus.name})`}
								</p>
							)}
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
							onClick={() => disconnectMutation.mutate()}
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
					Send messages and interact with Slack channels from your
					workflows.
				</p>
			</div>
		);
	}

	// Not connected — show bot token form
	return (
		<div className="space-y-4">
			<div className="p-4 rounded-lg border bg-muted/30">
				<div className="flex items-center gap-3 mb-3">
					<SlackIcon className="h-8 w-8 text-purple-600" />
					<div>
						<h3 className="font-semibold">Connect Slack</h3>
						<p className="text-sm text-muted-foreground">
							Paste your Slack Bot User OAuth Token to connect
						</p>
					</div>
				</div>

				<div className="space-y-3 mt-4">
					<div className="space-y-1.5">
						<Label htmlFor="slack-bot-token">
							Bot User OAuth Token
						</Label>
						<Input
							id="slack-bot-token"
							type="password"
							value={botToken}
							onChange={(e) => setBotToken(e.target.value)}
							placeholder="xoxb-..."
						/>
					</div>

					<Button
						onClick={handleSave}
						disabled={saveMutation.isPending || !botToken.trim()}
						className="w-full"
					>
						{saveMutation.isPending ? (
							<>
								<Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
								Connecting...
							</>
						) : (
							<>
								<KeyIcon className="h-4 w-4 mr-2" />
								Connect Slack
							</>
						)}
					</Button>
				</div>
			</div>

			<div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
				<p className="text-xs text-blue-700 dark:text-blue-300">
					<strong>How to get the token:</strong>
				</p>
				<ol className="text-xs text-blue-700 dark:text-blue-300 list-decimal ml-4 mt-1 space-y-0.5">
					<li>
						Go to{" "}
						<a
							href="https://api.slack.com/apps"
							target="_blank"
							rel="noopener noreferrer"
							className="underline inline-flex items-center gap-0.5"
						>
							api.slack.com/apps
							<ExternalLinkIcon className="h-3 w-3" />
						</a>{" "}
						and select your app (or create one)
					</li>
					<li>
						Go to <strong>OAuth & Permissions</strong> and add these
						Bot Token Scopes: channels:read, channels:history,
						groups:read, groups:history, users:read,
						users:read.email, search:read, chat:write,
						chat:write.public, channels:join
					</li>
					<li>
						Click <strong>Install to Workspace</strong>
					</li>
					<li>
						Copy the <strong>Bot User OAuth Token</strong> (starts
						with xoxb-)
					</li>
				</ol>
			</div>
		</div>
	);
}

export function SlackSettings({
	onApiKeyChange,
	organizationId,
}: IntegrationSettingsProps) {
	return (
		<OAuthSettings
			provider="SLACK"
			providerName="Slack"
			providerIcon={SlackIcon}
			providerColor="text-purple-600"
			description="Send messages and interact with Slack channels from your workflows."
			helpText="Connect your Slack workspace to send messages and access channels."
			helpLink={{
				text: "Learn about Slack permissions",
				url: "https://api.slack.com/scopes",
			}}
			scopes={[
				"channels:read",
				"channels:history",
				"groups:read",
				"groups:history",
				"users:read",
				"users:read.email",
				"chat:write",
				// Delivery to a channel the bot has not joined fails with
				// not_in_channel unless it can post to public channels
				// directly or join them (Fizzy #2013).
				"chat:write.public",
				"channels:join",
			]}
			userScopes={["search:read"]}
			organizationId={organizationId}
			onConnectionChange={(connected) => {
				if (connected) {
					onApiKeyChange("oauth_connected");
				} else {
					onApiKeyChange("");
				}
			}}
			fallbackContent={
				<SlackBotTokenForm
					organizationId={organizationId}
					onSaved={() => onApiKeyChange("oauth_connected")}
				/>
			}
		/>
	);
}
