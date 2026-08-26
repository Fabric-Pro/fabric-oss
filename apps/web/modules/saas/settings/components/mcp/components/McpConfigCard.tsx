/**
 * MCP Config Card
 *
 * Displays a single MCP configuration with actions.
 */

import { AlwaysOnPill } from "@saas/mcp/components/AlwaysOnPill";
import { McpServerIcon } from "@saas/mcp/components/McpServerIcon";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Edit2Icon, LoaderIcon, TestTube2Icon, TrashIcon } from "lucide-react";
import type { McpConfig, OAuthStatus } from "../types";
import { AtlassianCloudAttachmentBanner } from "./AtlassianCloudAttachmentBanner";
import { McpStatusBadge } from "./McpStatusBadge";

export interface McpConfigCardProps {
	config: McpConfig;
	oauthStatus?: OAuthStatus;
	disabled?: boolean;
	isTesting?: boolean;
	/** Whether the current user can change workspace-level OAuth setup. */
	isAdmin?: boolean;
	onEdit: (config: McpConfig) => void;
	onDelete: (config: McpConfig) => void;
	onTest: (config: McpConfig) => void;
	onToggleEnabled: (config: McpConfig, enabled: boolean) => void;
}

export function McpConfigCard({
	config,
	oauthStatus,
	disabled = false,
	isTesting = false,
	isAdmin = false,
	onEdit,
	onDelete,
	onTest,
	onToggleEnabled,
}: McpConfigCardProps) {
	// Treat the config as connected when the OAuth status says so, or the
	// stored health is HEALTHY (covers freshly-loaded configs before the
	// per-card oauth status probe resolves).
	const isConnected =
		oauthStatus?.authenticated === true || config.status === "HEALTHY";
	return (
		<Card className="p-3">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0 flex-1 flex items-start gap-2">
					<McpServerIcon
						name={config.mcpServer?.name || config.mcpServer?.key}
						iconUrl={config.mcpServer?.iconUrl}
						docsUrl={config.mcpServer?.docsUrl}
						repositoryUrl={config.mcpServer?.repositoryUrl}
						defaultUrl={
							config.baseUrl || config.mcpServer?.defaultUrl
						}
						size={24}
						className="mt-0.5 h-6 w-6 shrink-0 rounded-md"
					/>
					<div className="min-w-0 flex-1">
						<div className="font-medium line-clamp-1">
							{config.mcpServer?.name || config.mcpServer?.key}
						</div>
						<div className="text-xs text-muted-foreground truncate">
							{config.baseUrl ||
								config.mcpServer?.defaultUrl ||
								"<no base url>"}
						</div>
					</div>
				</div>
				<TooltipProvider>
					<div className="flex items-center gap-2">
						<McpStatusBadge
							status={config.status}
							authType={config.authType}
							oauthStatus={oauthStatus}
						/>
						{config.isManagedDefault ? (
							<AlwaysOnPill />
						) : (
							<Switch
								disabled={disabled}
								checked={!!config.enabled}
								onCheckedChange={(v) =>
									onToggleEnabled(config, v)
								}
							/>
						)}
						{!config.isManagedDefault && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="sm"
										variant="outline"
										disabled={disabled}
										onClick={() => onEdit(config)}
									>
										<Edit2Icon className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									Edit configuration
								</TooltipContent>
							</Tooltip>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="sm"
									variant="outline"
									onClick={() => onTest(config)}
									disabled={isTesting}
								>
									{isTesting ? (
										<LoaderIcon className="size-4 animate-spin" />
									) : (
										<TestTube2Icon className="size-4" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{isTesting ? "Testing..." : "Test connection"}
							</TooltipContent>
						</Tooltip>
						{!config.isManagedDefault && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="sm"
										variant="destructive"
										disabled={disabled}
										onClick={() => onDelete(config)}
									>
										<TrashIcon className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									Delete configuration
								</TooltipContent>
							</Tooltip>
						)}
					</div>
				</TooltipProvider>
			</div>
			<AtlassianCloudAttachmentBanner
				config={config}
				isConnected={isConnected}
				isAdmin={isAdmin}
			/>
		</Card>
	);
}
