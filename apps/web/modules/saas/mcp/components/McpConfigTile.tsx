"use client";

import { AlwaysOnPill } from "@saas/mcp/components/AlwaysOnPill";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	ChevronDownIcon,
	Edit2Icon,
	LoaderIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
	ShieldXIcon,
	TestTube2Icon,
	TrashIcon,
	WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { SparklesIcon } from "../../shared/components/icons/SparklesIcon";
import { McpServerIcon } from "./McpServerIcon";

const TRANSPORT_COLORS: Record<string, string> = {
	SSE: "bg-secondary/10 text-secondary",
	HTTP: "bg-primary/10 text-primary",
	STDIO: "bg-highlight/10 text-highlight",
};

const AUTH_CONFIG: Record<string, { label: string; color: string }> = {
	NONE: {
		label: "Public",
		color: "bg-success/10 text-success",
	},
	API_KEY: {
		label: "API Key",
		color: "bg-highlight/10 text-highlight",
	},
	OAUTH2: {
		label: "OAuth",
		color: "bg-primary/10 text-primary",
	},
};

interface McpConfigTileProps {
	config: any;
	oauthStatus?: {
		authenticated: boolean;
		tokenExpired: boolean;
		refreshTokenExpired: boolean;
		hasRefreshToken: boolean;
		expiresAt?: Date;
	};
	loadingState?: {
		test?: boolean;
		refresh?: boolean;
		toggle?: boolean;
		revoke?: boolean;
		refreshTools?: boolean;
	};
	toolCount?: number;
	toolError?: string;
	tools?: Array<{ name: string; description?: string }>;
	onEdit: (config: any) => void;
	onDelete: (config: any) => void;
	onToggle: (config: any, enabled: boolean) => void;
	onConnect?: (config: any) => void;
	onRefresh?: (config: any) => void;
	onRefreshTools?: (config: any) => void;
	onRevoke?: (config: any) => void;
	onTest: (config: any) => void;
	onChat?: (config: any) => void;
	disabled?: boolean;
}

export function McpConfigTile({
	config,
	oauthStatus,
	loadingState,
	toolCount,
	toolError,
	tools,
	onEdit,
	onDelete,
	onToggle,
	onConnect,
	onRefresh,
	onRefreshTools,
	onRevoke,
	onTest,
	onChat,
	disabled = false,
}: McpConfigTileProps) {
	const [toolsExpanded, setToolsExpanded] = useState(false);

	const displayName =
		config.displayName || config.mcpServer?.name || "Unnamed Server";
	const description = config.mcpServer?.description;
	const author = config.mcpServer?.author;
	const transport = config.mcpServer?.transport;
	const category = config.mcpServer?.category;
	const tags: string[] = config.mcpServer?.tags ?? [];

	const isConnected =
		config.enabled &&
		(config.authType !== "OAUTH2"
			? config.status === "HEALTHY"
			: oauthStatus?.authenticated && !oauthStatus?.tokenExpired);

	const getStatusDot = () => {
		if (!config.enabled) {
			return "bg-muted-foreground/50";
		}
		if (config.authType === "OAUTH2") {
			if (oauthStatus?.authenticated && !oauthStatus?.tokenExpired) {
				return "bg-success";
			}
			if (oauthStatus?.tokenExpired) {
				return "bg-highlight";
			}
			return "bg-destructive";
		}
		if (config.status === "HEALTHY") {
			return "bg-success";
		}
		if (config.status === "DEGRADED") {
			return "bg-highlight";
		}
		return "bg-muted-foreground/50";
	};

	const getStatusLabel = () => {
		if (!config.enabled) {
			return "Disabled";
		}
		if (config.authType === "OAUTH2") {
			if (oauthStatus?.authenticated && !oauthStatus?.tokenExpired) {
				return "Connected";
			}
			if (oauthStatus?.tokenExpired) {
				return "Token Expired";
			}
			return "Not Connected";
		}
		if (config.status === "HEALTHY") {
			return "Healthy";
		}
		if (config.status === "DEGRADED") {
			return "Degraded";
		}
		return "Unknown";
	};

	const getStatusClassName = () => {
		if (!config.enabled) {
			return "bg-muted text-muted-foreground";
		}
		if (config.status === "HEALTHY" || isConnected) {
			return "bg-success/10 text-success";
		}
		if (config.status === "DEGRADED" || oauthStatus?.tokenExpired) {
			return "bg-highlight/10 text-highlight";
		}
		return "bg-muted text-muted-foreground";
	};

	const authConfig =
		AUTH_CONFIG[config.authType || "NONE"] ?? AUTH_CONFIG.NONE;
	const totalTools = toolCount ?? tools?.length ?? 0;
	const isManagedDefault = !!config.isManagedDefault;

	return (
		<div
			data-managed-default={isManagedDefault ? "true" : undefined}
			className={cn(
				"app-surface group relative flex flex-col overflow-hidden rounded-2xl transition-[border-color,box-shadow,background-color]",
				isManagedDefault
					? "border-border/80"
					: "hover:border-primary/25 hover:shadow-md hover:shadow-foreground/5",
			)}
		>
			{/* Header */}
			<div className="flex gap-3 p-4 pb-3">
				{/* Icon */}
				<McpServerIcon
					name={config.mcpServer?.name || displayName}
					iconUrl={config.mcpServer?.iconUrl}
					docsUrl={config.mcpServer?.docsUrl}
					repositoryUrl={config.mcpServer?.repositoryUrl}
					defaultUrl={config.baseUrl || config.mcpServer?.defaultUrl}
					size={36}
					className="h-9 w-9 rounded-xl ring-1 ring-border/60"
					fallbackClassName="bg-violet-50 text-violet-600 dark:bg-violet-900/20 dark:text-violet-400"
				/>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-start justify-between gap-2">
						<h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground/90 transition-colors group-hover:text-primary">
							{displayName}
						</h3>

						{/* Status badge */}
						<span
							className={cn(
								"text-[10px] px-1.5 py-0.5 rounded font-medium leading-tight flex items-center gap-1 shrink-0",
								getStatusClassName(),
							)}
						>
							<span
								className={cn(
									"h-1.5 w-1.5 rounded-full",
									getStatusDot(),
									config.enabled &&
										config.status === "HEALTHY" &&
										"",
								)}
							/>
							{getStatusLabel()}
						</span>
					</div>

					<p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
						{description || "No description provided"}
					</p>
				</div>
			</div>

			{/* Badges row */}
			<div className="flex flex-wrap gap-1.5 px-4 pb-3">
				{transport && (
					<span
						className={cn(
							"text-[10px] px-1.5 py-0.5 rounded font-medium",
							TRANSPORT_COLORS[transport] ??
								TRANSPORT_COLORS.HTTP,
						)}
					>
						{transport}
					</span>
				)}
				<span
					className={cn(
						"text-[10px] px-1.5 py-0.5 rounded font-medium",
						authConfig.color,
					)}
				>
					{authConfig.label}
				</span>
				{category && (
					<Badge
						variant="secondary"
						className="text-[10px] px-1.5 py-0 font-normal h-4"
					>
						{category}
					</Badge>
				)}
				{tags.slice(0, 2).map((tag) => (
					<Badge
						key={tag}
						variant="secondary"
						className="text-[10px] px-1.5 py-0 font-normal h-4"
					>
						{tag}
					</Badge>
				))}
				{tags.length > 2 && (
					<span className="text-[10px] text-muted-foreground self-center">
						+{tags.length - 2}
					</span>
				)}
			</div>

			{/* Tools collapsible */}
			<div className="px-4 pb-3">
				<Collapsible
					open={toolsExpanded}
					onOpenChange={setToolsExpanded}
				>
					<CollapsibleTrigger asChild>
						<button
							type="button"
							className={cn(
								"flex items-center gap-1 text-[11px] hover:text-foreground transition-colors",
								toolError
									? "text-destructive"
									: "text-muted-foreground",
							)}
						>
							{toolError ? (
								<AlertTriangleIcon className="size-3" />
							) : (
								<WrenchIcon className="size-3" />
							)}
							{toolError
								? "Tool discovery failed"
								: `${totalTools} tools`}
							<ChevronDownIcon
								className={cn(
									"size-3 transition-transform",
									toolsExpanded && "rotate-180",
								)}
							/>
						</button>
					</CollapsibleTrigger>
					<CollapsibleContent className="mt-2">
						<div className="bg-muted/50 rounded-lg p-2.5 max-h-40 overflow-y-auto border border-border/50">
							{toolError ? (
								<div className="text-[11px] text-destructive space-y-1">
									<p className="font-medium">
										Error loading tools:
									</p>
									<p className="text-muted-foreground break-words">
										{toolError.length > 200
											? `${toolError.slice(0, 200)}...`
											: toolError}
									</p>
									<p className="text-muted-foreground mt-1">
										Try refreshing tools or check server
										logs.
									</p>
								</div>
							) : tools && tools.length > 0 ? (
								<div className="space-y-1.5">
									{tools.map((tool, idx) => (
										<div
											key={idx}
											className="text-[11px] border-b border-border/30 pb-1.5 last:border-b-0 last:pb-0"
										>
											<div className="font-mono text-primary font-medium">
												{tool.name}
											</div>
											{tool.description && (
												<p className="text-muted-foreground mt-0.5 leading-relaxed">
													{tool.description.length >
													80
														? `${tool.description.slice(0, 80)}...`
														: tool.description}
												</p>
											)}
										</div>
									))}
								</div>
							) : (
								<p className="text-[11px] text-muted-foreground">
									Test connection to discover tools
								</p>
							)}
						</div>
					</CollapsibleContent>
				</Collapsible>
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between gap-2 border-t border-border/70 bg-muted/20 px-4 py-2.5">
				{/* Left: Toggle + author */}
				<div className="flex items-center gap-2 min-w-0">
					{isManagedDefault ? (
						<AlwaysOnPill />
					) : (
						<Switch
							checked={!!config.enabled}
							onCheckedChange={(v) => onToggle(config, v)}
							disabled={disabled || loadingState?.toggle}
							className="data-[state=checked]:bg-success shrink-0 scale-75 origin-left"
						/>
					)}
					<span className="text-[11px] text-muted-foreground truncate">
						{author ? `By ${author}` : "MCP Server"}
					</span>
				</div>

				{/* Right: Action icons */}
				<TooltipProvider>
					<div className="flex shrink-0 items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
						{/* Try MCP */}
						{isConnected && onChat && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										className="h-6 w-6"
										onClick={() => onChat(config)}
									>
										<SparklesIcon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Try MCP</TooltipContent>
							</Tooltip>
						)}

						{/* OAuth Connect */}
						{config.authType === "OAUTH2" &&
							onConnect &&
							!oauthStatus?.authenticated && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="icon"
											variant="ghost"
											className="h-6 w-6"
											onClick={() => onConnect(config)}
											disabled={disabled}
										>
											<ShieldCheckIcon className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										Connect with OAuth
									</TooltipContent>
								</Tooltip>
							)}

						{/* Refresh Token */}
						{config.authType === "OAUTH2" &&
							oauthStatus?.tokenExpired &&
							!oauthStatus?.refreshTokenExpired &&
							oauthStatus?.hasRefreshToken &&
							onRefresh && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="icon"
											variant="ghost"
											className="h-6 w-6"
											onClick={() => onRefresh(config)}
											disabled={
												disabled ||
												loadingState?.refresh
											}
										>
											{loadingState?.refresh ? (
												<LoaderIcon className="size-3.5 animate-spin" />
											) : (
												<RefreshCwIcon className="size-3.5" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										Refresh token
									</TooltipContent>
								</Tooltip>
							)}

						{/* Revoke Access */}
						{config.authType === "OAUTH2" &&
							oauthStatus?.authenticated &&
							onRevoke && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="icon"
											variant="ghost"
											className="h-6 w-6 text-destructive hover:text-destructive"
											onClick={() => onRevoke(config)}
											disabled={
												disabled || loadingState?.revoke
											}
										>
											{loadingState?.revoke ? (
												<LoaderIcon className="size-3.5 animate-spin" />
											) : (
												<ShieldXIcon className="size-3.5" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										Revoke access
									</TooltipContent>
								</Tooltip>
							)}

						{/* Refresh Tools */}
						{onRefreshTools && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										className="h-6 w-6"
										onClick={() => onRefreshTools(config)}
										disabled={
											disabled ||
											loadingState?.refreshTools
										}
									>
										{loadingState?.refreshTools ? (
											<LoaderIcon className="size-3.5 animate-spin" />
										) : (
											<WrenchIcon className="size-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>Refresh tools</TooltipContent>
							</Tooltip>
						)}

						{/* Test Connection - disabled for STDIO servers (no URL to test) */}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									className="h-6 w-6"
									onClick={() => onTest(config)}
									disabled={
										disabled ||
										loadingState?.test ||
										config.mcpServer?.transport === "STDIO"
									}
								>
									{loadingState?.test ? (
										<LoaderIcon className="size-3.5 animate-spin" />
									) : (
										<TestTube2Icon className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{config.mcpServer?.transport === "STDIO"
									? "Test not available for STDIO servers"
									: "Test connection"}
							</TooltipContent>
						</Tooltip>

						{/* Edit (hidden for managed-default — can't be edited) */}
						{!isManagedDefault && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										className="h-6 w-6"
										onClick={() => onEdit(config)}
										disabled={
											disabled ||
											config.mcpServer?.transport ===
												"STDIO"
										}
									>
										<Edit2Icon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{config.mcpServer?.transport === "STDIO"
										? "Delete and re-add to modify STDIO servers"
										: "Edit"}
								</TooltipContent>
							</Tooltip>
						)}

						{/* Delete (hidden for managed-default — can't be deleted) */}
						{!isManagedDefault && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										className="h-6 w-6 text-destructive hover:text-destructive"
										onClick={() => onDelete(config)}
										disabled={disabled}
									>
										<TrashIcon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Delete</TooltipContent>
							</Tooltip>
						)}
					</div>
				</TooltipProvider>
			</div>
		</div>
	);
}
