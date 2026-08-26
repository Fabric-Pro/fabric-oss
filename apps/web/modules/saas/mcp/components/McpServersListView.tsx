"use client";

import { AlwaysOnPill } from "@saas/mcp/components/AlwaysOnPill";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	CheckCircleIcon,
	Edit2Icon,
	KeyIcon,
	LinkIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
	ShieldXIcon,
	TestTube2Icon,
	TrashIcon,
	WrenchIcon,
} from "lucide-react";
import { SparklesIcon } from "../../shared/components/icons/SparklesIcon";
import { McpServerIcon } from "./McpServerIcon";

interface McpServersListViewProps {
	configs: any[];
	oauthStatuses: Record<string, any>;
	loadingStates: Record<string, any>;
	onEdit: (config: any) => void;
	onDelete: (config: any) => void;
	onToggle: (config: any, enabled: boolean) => void;
	onConnect?: (config: any) => void;
	onRefresh?: (config: any) => void;
	onRefreshTools?: (config: any) => void;
	onRevoke?: (config: any) => void;
	onTest: (config: any) => void;
	onChat?: (config: any) => void;
}

export function McpServersListView({
	configs,
	oauthStatuses,
	loadingStates,
	onEdit,
	onDelete,
	onToggle,
	onConnect,
	onRefresh,
	onRefreshTools,
	onRevoke,
	onTest,
	onChat,
}: McpServersListViewProps) {
	return (
		<div className="space-y-3">
			{configs.map((config) => (
				<McpServerListItem
					key={config.id}
					config={config}
					oauthStatus={oauthStatuses[config.id]}
					loadingState={loadingStates[config.id]}
					onEdit={onEdit}
					onDelete={onDelete}
					onToggle={onToggle}
					onConnect={onConnect}
					onRefresh={onRefresh}
					onRefreshTools={onRefreshTools}
					onRevoke={onRevoke}
					onTest={onTest}
					onChat={onChat}
				/>
			))}
		</div>
	);
}

function McpServerListItem({
	config,
	oauthStatus,
	loadingState,
	onEdit,
	onDelete,
	onToggle,
	onConnect,
	onRefresh,
	onRefreshTools,
	onRevoke: _onRevoke,
	onTest,
	onChat,
}: {
	config: any;
	oauthStatus?: any;
	loadingState?: any;
	onEdit: (config: any) => void;
	onDelete: (config: any) => void;
	onToggle: (config: any, enabled: boolean) => void;
	onConnect?: (config: any) => void;
	onRefresh?: (config: any) => void;
	onRefreshTools?: (config: any) => void;
	onRevoke?: (config: any) => void;
	onTest: (config: any) => void;
	onChat?: (config: any) => void;
}) {
	const displayName =
		config.displayName || config.mcpServer?.name || "Unnamed Server";
	const baseUrl = config.baseUrl || config.mcpServer?.defaultUrl;

	// Determine status badge
	const getStatusBadge = () => {
		// For OAuth2 configurations, always use OAuth status if available
		if (config.authType === "OAUTH2") {
			if (oauthStatus) {
				if (oauthStatus.authenticated && !oauthStatus.tokenExpired) {
					return (
						<Badge className="bg-green-500/10 text-green-700 dark:bg-green-500/20 dark:text-green-400 border-0">
							<CheckCircleIcon className="mr-1 size-3" />
							Connected
						</Badge>
					);
				}
				if (oauthStatus.tokenExpired) {
					return (
						<Badge className="bg-yellow-500/10 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400 border-0">
							<RefreshCwIcon className="mr-1 size-3" />
							Token Expired
						</Badge>
					);
				}
				return (
					<Badge className="bg-red-500/10 text-red-700 dark:bg-red-500/20 dark:text-red-400 border-0">
						Not Connected
					</Badge>
				);
			}
			// OAuth status not loaded yet
			return (
				<Badge className="bg-gray-500/10 text-gray-700 dark:bg-gray-500/20 dark:text-gray-400 border-0">
					Checking...
				</Badge>
			);
		}

		// For non-OAuth configurations, use health status
		const status = config.status;
		if (status === "HEALTHY") {
			return (
				<Badge className="bg-green-500/10 text-green-700 dark:bg-green-500/20 dark:text-green-400 border-0">
					<CheckCircleIcon className="mr-1 size-3" />
					Connected
				</Badge>
			);
		}
		if (status === "DEGRADED") {
			return (
				<Badge className="bg-yellow-500/10 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400 border-0">
					Degraded
				</Badge>
			);
		}
		return <Badge variant="secondary">Unknown</Badge>;
	};

	// Determine auth type badge
	const getAuthBadge = () => {
		if (config.authType === "OAUTH2") {
			return (
				<Badge variant="secondary" className="text-xs">
					<ShieldCheckIcon className="mr-1 size-3" />
					OAuth2
				</Badge>
			);
		}
		if (config.authType === "API_KEY") {
			return (
				<Badge variant="secondary" className="text-xs">
					<KeyIcon className="mr-1 size-3" />
					API Key
				</Badge>
			);
		}
		return (
			<Badge variant="secondary" className="text-xs">
				<ShieldXIcon className="mr-1 size-3" />
				No Auth
			</Badge>
		);
	};

	const isManagedDefault = !!config.isManagedDefault;

	return (
		<Card
			data-managed-default={isManagedDefault ? "true" : undefined}
			className={cn(
				"transition-all group",
				isManagedDefault ? "" : "hover:shadow-md",
			)}
		>
			<div className="w-full p-4">
				<div className="flex items-start justify-between gap-4">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-3 mb-2">
							<McpServerIcon
								name={config.mcpServer?.name || displayName}
								iconUrl={config.mcpServer?.iconUrl}
								docsUrl={config.mcpServer?.docsUrl}
								repositoryUrl={config.mcpServer?.repositoryUrl}
								defaultUrl={
									config.baseUrl ||
									config.mcpServer?.defaultUrl
								}
								size={20}
								className="h-5 w-5 rounded-md"
							/>
							<h3 className="font-semibold text-lg line-clamp-1">
								{displayName}
							</h3>
							{getStatusBadge()}
							{getAuthBadge()}
						</div>

						{/* Server Type (Provider) */}
						{config.mcpServer?.name &&
							config.displayName !== config.mcpServer.name && (
								<p className="text-sm text-muted-foreground line-clamp-1 mb-2">
									{config.mcpServer.name}
								</p>
							)}

						<div className="flex items-center gap-6 text-sm text-muted-foreground">
							{/* Base URL */}
							{baseUrl && (
								<div className="flex items-center gap-2">
									<LinkIcon className="size-4 shrink-0" />
									<span className="truncate max-w-md">
										{baseUrl}
									</span>
								</div>
							)}

							{/* Auth Type and Token Expiration */}
							{config.authType === "OAUTH2" &&
								oauthStatus?.authenticated &&
								oauthStatus.expiresAt && (
									<span className="text-xs text-muted-foreground">
										Expires{" "}
										{formatDistanceToNow(
											new Date(oauthStatus.expiresAt),
											{
												addSuffix: true,
											},
										)}
									</span>
								)}

							{/* Last Health Check */}
							{config.lastHealthCheckAt && (
								<div className="text-xs text-muted-foreground">
									Last checked{" "}
									{formatDistanceToNow(
										new Date(config.lastHealthCheckAt),
										{
											addSuffix: true,
										},
									)}
								</div>
							)}
						</div>
					</div>

					<div className="flex items-center gap-3 shrink-0">
						{isManagedDefault ? (
							<AlwaysOnPill />
						) : (
							<Switch
								checked={!!config.enabled}
								onCheckedChange={(v) => onToggle(config, v)}
							/>
						)}

						{/* Action Buttons - Icon Only with Tooltips */}
						<TooltipProvider>
							<div className="flex gap-1">
								{/* Try MCP */}
								{onChat &&
									config.enabled &&
									config.status === "HEALTHY" && (
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													size="icon"
													variant="outline"
													onClick={(e) => {
														e.stopPropagation();
														onChat(config);
													}}
												>
													<SparklesIcon className="size-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												Try MCP
											</TooltipContent>
										</Tooltip>
									)}

								{/* OAuth Connect - Only show if NOT authenticated */}
								{config.authType === "OAUTH2" &&
									onConnect &&
									!oauthStatus?.authenticated && (
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													size="icon"
													variant="outline"
													onClick={(e) => {
														e.stopPropagation();
														onConnect(config);
													}}
												>
													<LinkIcon className="size-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												Connect OAuth
											</TooltipContent>
										</Tooltip>
									)}

								{/* OAuth Refresh - Only show if authenticated and token expired */}
								{config.authType === "OAUTH2" &&
									onRefresh &&
									oauthStatus?.authenticated &&
									oauthStatus?.tokenExpired && (
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													size="icon"
													variant="outline"
													onClick={(e) => {
														e.stopPropagation();
														onRefresh(config);
													}}
													disabled={
														loadingState?.refresh
													}
												>
													<RefreshCwIcon
														className={`size-4 ${loadingState?.refresh ? "animate-spin" : ""}`}
													/>
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												{loadingState?.refresh
													? "Refreshing..."
													: "Refresh token"}
											</TooltipContent>
										</Tooltip>
									)}

								{/* Test Connection - disabled for STDIO servers (no URL to test) */}
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="icon"
											variant="outline"
											onClick={(e) => {
												e.stopPropagation();
												onTest(config);
											}}
											disabled={
												loadingState?.test ||
												config.mcpServer?.transport ===
													"STDIO"
											}
										>
											<TestTube2Icon
												className={`size-4 ${loadingState?.test ? "animate-pulse" : ""}`}
											/>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{config.mcpServer?.transport === "STDIO"
											? "Test not available for STDIO servers"
											: loadingState?.test
												? "Testing..."
												: "Test connection"}
									</TooltipContent>
								</Tooltip>

								{/* Refresh Tools */}
								{onRefreshTools && (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												size="icon"
												variant="outline"
												onClick={(e) => {
													e.stopPropagation();
													onRefreshTools(config);
												}}
												disabled={
													loadingState?.refreshTools
												}
											>
												<WrenchIcon
													className={`size-4 ${loadingState?.refreshTools ? "animate-spin" : ""}`}
												/>
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{loadingState?.refreshTools
												? "Refreshing tools..."
												: "Refresh tools from server"}
										</TooltipContent>
									</Tooltip>
								)}

								{/* Edit (hidden on managed-default rows) */}
								{!isManagedDefault && (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												size="icon"
												variant="outline"
												onClick={(e) => {
													e.stopPropagation();
													onEdit(config);
												}}
												disabled={
													config.mcpServer
														?.transport === "STDIO"
												}
											>
												<Edit2Icon className="size-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{config.mcpServer?.transport ===
											"STDIO"
												? "Delete and re-add to modify"
												: "Edit server"}
										</TooltipContent>
									</Tooltip>
								)}

								{/* Delete (hidden on managed-default rows) */}
								{!isManagedDefault && (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												size="icon"
												variant="destructive"
												onClick={(e) => {
													e.stopPropagation();
													onDelete(config);
												}}
											>
												<TrashIcon className="size-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											Delete server
										</TooltipContent>
									</Tooltip>
								)}
							</div>
						</TooltipProvider>
					</div>
				</div>
			</div>
		</Card>
	);
}
