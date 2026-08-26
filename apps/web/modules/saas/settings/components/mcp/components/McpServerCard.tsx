/**
 * MCP Server Card
 *
 * Displays a single MCP server from the registry with actions.
 */

import { AlwaysOnPill } from "@saas/mcp/components/AlwaysOnPill";
import { McpServerIcon } from "@saas/mcp/components/McpServerIcon";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	Edit2Icon,
	ExternalLinkIcon,
	PlusIcon,
	TerminalIcon,
	TrashIcon,
} from "lucide-react";
import type { McpServer } from "../types";
import {
	getAuthTypeLabel,
	getDefaultAuthTypeFromServer,
	getTransportInfo,
	isServerConfigurableViaWeb,
} from "../types";

export interface McpServerCardProps {
	server: McpServer;
	disabled?: boolean;
	onConfigure: (server: McpServer) => void;
	onEdit?: (server: McpServer) => void;
	onDelete?: (server: McpServer) => void;
}

export function McpServerCard({
	server,
	disabled = false,
	onConfigure,
	onEdit,
	onDelete,
}: McpServerCardProps) {
	const authType = getDefaultAuthTypeFromServer(server);
	const authTypeLabel = getAuthTypeLabel(authType);
	const isCustom = !server.isSystemProvided;
	const transportInfo = getTransportInfo(server.transport);
	const canConfigure = isServerConfigurableViaWeb(server);

	return (
		<Card className="p-4 flex items-center justify-between gap-4">
			<div className="flex-1 min-w-0 flex items-start gap-3">
				<McpServerIcon
					name={server.name || server.key}
					iconUrl={server.iconUrl}
					docsUrl={server.docsUrl}
					repositoryUrl={server.repositoryUrl}
					defaultUrl={server.defaultUrl}
					size={32}
					className="mt-0.5 h-8 w-8 rounded-lg"
				/>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-1">
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="font-medium truncate">
										{server.name || server.key}
									</div>
								</TooltipTrigger>
								<TooltipContent>
									{server.name || server.key}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
						{isCustom && (
							<span className="rounded-sm bg-secondary/10 px-1.5 py-0.5 text-xs text-secondary shrink-0">
								Custom
							</span>
						)}
						{/* Transport badge */}
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<span
										className={`rounded px-1.5 py-0.5 text-xs shrink-0 flex items-center gap-1 ${
											canConfigure
												? "bg-success/10 text-success"
												: "bg-highlight/10 text-highlight"
										}`}
									>
										{!canConfigure && (
											<TerminalIcon className="size-3" />
										)}
										{transportInfo.label}
									</span>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs">
									{transportInfo.description}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
					<div className="flex items-center gap-3 text-xs text-muted-foreground">
						{/* Show URL for HTTP/SSE servers, command for STDIO servers */}
						{canConfigure && server.defaultUrl && (
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<div className="truncate">
											{server.defaultUrl}
										</div>
									</TooltipTrigger>
									<TooltipContent>
										{server.defaultUrl}
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						)}
						{!canConfigure && server.command && (
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<code className="truncate bg-muted px-1 rounded font-mono text-[10px]">
											{server.command}
										</code>
									</TooltipTrigger>
									<TooltipContent className="max-w-md">
										<p className="font-medium mb-1">
											Run this command locally:
										</p>
										<code className="block bg-muted p-2 rounded text-xs">
											{server.command}
										</code>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						)}
						<div className="shrink-0">
							<span className="font-medium">Auth:</span>{" "}
							{authTypeLabel}
						</div>
					</div>
					{server.description && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="text-xs text-muted-foreground line-clamp-2 mt-1">
										{server.description}
									</div>
								</TooltipTrigger>
								<TooltipContent className="max-w-sm">
									{server.description}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
				</div>
			</div>
			<TooltipProvider>
				<div className="flex items-center gap-2">
					{server.defaultEnabled ? (
						<AlwaysOnPill />
					) : canConfigure ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="sm"
									disabled={disabled}
									onClick={() => onConfigure(server)}
								>
									<PlusIcon className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Configure</TooltipContent>
						</Tooltip>
					) : (
						<>
							{/* STDIO servers can't be configured via web - show docs link */}
							{server.docsUrl && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="sm"
											variant="outline"
											asChild
										>
											<a
												href={server.docsUrl}
												target="_blank"
												rel="noopener noreferrer"
											>
												<ExternalLinkIcon className="size-4" />
											</a>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										View setup docs (requires Claude
										Desktop)
									</TooltipContent>
								</Tooltip>
							)}
						</>
					)}
					{isCustom && onEdit && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="sm"
									variant="outline"
									disabled={disabled}
									onClick={() => onEdit(server)}
								>
									<Edit2Icon className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Edit server</TooltipContent>
						</Tooltip>
					)}
					{isCustom && onDelete && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="sm"
									variant="destructive"
									disabled={disabled}
									onClick={() => onDelete(server)}
								>
									<TrashIcon className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Delete server</TooltipContent>
						</Tooltip>
					)}
				</div>
			</TooltipProvider>
		</Card>
	);
}
