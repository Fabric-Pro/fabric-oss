"use client";

import { AlwaysOnPill } from "@saas/mcp/components/AlwaysOnPill";
import { McpServerIcon } from "@saas/mcp/components/McpServerIcon";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowRightIcon,
	GithubIcon,
	MessageSquareIcon,
	PlusIcon,
	TerminalIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";

interface McpServerCardProps {
	server: {
		id: string;
		key: string;
		name: string;
		description?: string | null;
		heroEmojis?: string[];
		heroImageUrl?: string | null;
		docsUrl?: string | null;
		iconUrl?: string | null;
		author?: string | null;
		repositoryUrl?: string | null;
		category?: string | null;
		tags?: string[];
		authMethods?: string[];
		transport?: "SSE" | "HTTP" | "STDIO" | string | null;
		command?: string | null;
		/** Server is auto-enabled for every tenant — no setup required. */
		defaultEnabled?: boolean;
	};
	onInstall?: (server: any) => void;
	showInstallButton?: boolean;
	isPublic?: boolean;
}

function isWebConfigurable(
	transport: string | null | undefined,
	command: string | null | undefined,
): boolean {
	if (transport === "STDIO") {
		return !!command;
	}
	return true;
}

const TRANSPORT_COLORS: Record<string, string> = {
	SSE: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
	HTTP: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
	STDIO: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

const AUTH_CONFIG: Record<string, { label: string; color: string }> = {
	NONE: {
		label: "Public",
		color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
	},
	API_KEY: {
		label: "API Key",
		color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
	},
	OAUTH2: {
		label: "OAuth",
		color: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
	},
};

const TAG_COLORS: Record<string, string> = {
	"project-management":
		"bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
	"issue-tracking":
		"bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
	tasks: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
	kanban: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
	agile: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
	"code-repository":
		"bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
	"version-control":
		"bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
};

function getTagColor(tag: string): string {
	return (
		TAG_COLORS[tag] ??
		"bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
	);
}

export function McpServerCard({
	server,
	onInstall,
	showInstallButton = true,
	isPublic: _isPublic = false,
}: McpServerCardProps) {
	const router = useRouter();
	const canConfigure = isWebConfigurable(server.transport, server.command);

	const handlePrimaryClick = () => {
		// Default-enabled servers are already seeded for every tenant — the
		// install path would be a no-op (or a duplicate-write attempt). Route
		// straight to Nexus where the user can actually use the tool.
		if (server.defaultEnabled) {
			router.push("/app/nexus");
			return;
		}
		if (onInstall && showInstallButton) {
			onInstall(server);
		} else {
			router.push("/app/nexus");
		}
	};

	const handleViewDetails = () => {
		const url = server.docsUrl || server.repositoryUrl;
		if (url) {
			window.open(url, "_blank", "noopener,noreferrer");
		}
	};

	// Determine auth config
	const authMethod = server.authMethods?.[0] || "NONE";
	const noAuth =
		!server.authMethods?.length || server.authMethods.includes("NONE");
	const authConfig =
		AUTH_CONFIG[noAuth ? "NONE" : authMethod] ?? AUTH_CONFIG.NONE;

	const tags = server.tags ?? [];

	const isManagedDefault = !!server.defaultEnabled;

	return (
		<div
			data-managed-default={isManagedDefault ? "true" : undefined}
			className={cn(
				"group relative flex flex-col rounded-xl border bg-card transition-all",
				// Managed-default rows are informational, not actionable — drop
				// the hover-lift so the card doesn't invite clicks.
				isManagedDefault
					? "border-border/80"
					: "hover:border-primary/30 hover:shadow-md",
			)}
		>
			{/* Header */}
			<div className="flex gap-3 p-4 pb-3">
				{/* Icon — non-clickable on managed-default rows */}
				{isManagedDefault ? (
					<div className="shrink-0">
						<McpServerIcon
							name={server.name}
							iconUrl={server.iconUrl}
							docsUrl={server.docsUrl}
							repositoryUrl={server.repositoryUrl}
							size={36}
							className="h-9 w-9 rounded-lg"
							fallbackClassName="bg-violet-50 text-violet-600 dark:bg-violet-900/20 dark:text-violet-400"
						/>
					</div>
				) : (
					<button
						type="button"
						className="shrink-0 cursor-pointer"
						onClick={handlePrimaryClick}
					>
						<McpServerIcon
							name={server.name}
							iconUrl={server.iconUrl}
							docsUrl={server.docsUrl}
							repositoryUrl={server.repositoryUrl}
							size={36}
							className="h-9 w-9 rounded-lg"
							fallbackClassName="bg-violet-50 text-violet-600 dark:bg-violet-900/20 dark:text-violet-400"
						/>
					</button>
				)}

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-start justify-between gap-2">
						{isManagedDefault ? (
							<h3 className="font-semibold text-sm leading-snug flex-1 min-w-0">
								{server.name}
							</h3>
						) : (
							<button
								type="button"
								className="flex-1 min-w-0 text-left cursor-pointer"
								onClick={handlePrimaryClick}
							>
								<h3 className="font-semibold text-sm leading-snug group-hover:text-primary transition-colors">
									{server.name}
								</h3>
							</button>
						)}
					</div>

					<p className="mt-1 text-xs text-muted-foreground leading-relaxed">
						{server.description || "No description provided"}
					</p>
				</div>
			</div>

			{/* Transport + Auth + Category badges */}
			<div className="px-4 pb-3 flex flex-wrap gap-1.5">
				{server.transport && (
					<span
						className={cn(
							"text-[10px] px-1.5 py-0.5 rounded font-medium",
							TRANSPORT_COLORS[server.transport] ??
								TRANSPORT_COLORS.HTTP,
						)}
					>
						{server.transport}
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
				{server.category && (
					<Badge
						variant="secondary"
						className="text-[10px] px-1.5 py-0 font-normal h-4"
					>
						{server.category}
					</Badge>
				)}
			</div>

			{/* Tags */}
			{tags.length > 0 && (
				<div className="px-4 pb-3 flex flex-wrap gap-1">
					{tags.slice(0, 3).map((tag) => (
						<span
							key={tag}
							className={cn(
								"text-[10px] px-1.5 py-0.5 rounded font-medium",
								getTagColor(tag),
							)}
						>
							{tag}
						</span>
					))}
					{tags.length > 3 && (
						<span className="text-[10px] text-muted-foreground">
							+{tags.length - 3}
						</span>
					)}
				</div>
			)}

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5 gap-2">
				<div className="text-[11px] text-muted-foreground truncate">
					{server.author ? `By ${server.author}` : "MCP Server"}
				</div>

				<div className="flex items-center gap-1 shrink-0">
					{/* GitHub link */}
					{server.repositoryUrl && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-6 w-6"
										onClick={(e) => {
											e.stopPropagation();
											if (server.repositoryUrl) {
												window.open(
													server.repositoryUrl,
													"_blank",
													"noopener,noreferrer",
												);
											}
										}}
									>
										<GithubIcon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>View on GitHub</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}

					{/* Primary action */}
					{isManagedDefault ? (
						<TooltipProvider>
							<AlwaysOnPill className="h-6 text-[11px]" />
						</TooltipProvider>
					) : canConfigure ? (
						<Button
							size="sm"
							variant="outline"
							className="h-6 text-[11px] px-2 gap-1"
							onClick={(e) => {
								e.stopPropagation();
								handlePrimaryClick();
							}}
						>
							{onInstall && showInstallButton ? (
								<>
									<PlusIcon className="size-3" />
									Configure
								</>
							) : (
								<>
									<MessageSquareIcon className="size-3" />
									Chat
								</>
							)}
						</Button>
					) : (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										className="h-6 text-[11px] px-2 gap-1"
										onClick={(e) => {
											e.stopPropagation();
											handleViewDetails();
										}}
										disabled={
											!server.docsUrl &&
											!server.repositoryUrl
										}
									>
										<TerminalIcon className="size-3" />
										Local
									</Button>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs">
									<p className="font-medium">
										Requires Claude Desktop
									</p>
									<p className="text-xs text-muted-foreground mt-1">
										This server runs locally via command
										line and cannot be configured from the
										web UI.
									</p>
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}

					{!isManagedDefault && (
						<ArrowRightIcon className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
					)}
				</div>
			</div>
		</div>
	);
}
