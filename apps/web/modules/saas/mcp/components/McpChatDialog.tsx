"use client";

/**
 * MCP Try Dialog
 *
 * A dialog that allows users to try an MCP server through the streaming
 * orchestrator, scoped to the selected MCP configuration.
 */

import { FabricTemporalOrchestratorChat } from "@saas/agents/components/FabricChat/FabricTemporalOrchestratorChat";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	Loader2Icon,
	Maximize2Icon,
	Minimize2Icon,
	WrenchIcon,
	X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { McpServerIcon } from "./McpServerIcon";

interface McpChatDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	config: {
		id: string;
		displayName?: string;
		baseUrl?: string;
		mcpServer?: {
			name?: string;
			description?: string;
			defaultUrl?: string;
			docsUrl?: string;
			iconUrl?: string;
			repositoryUrl?: string;
		};
		authType?: string;
	};
	organizationId?: string | null;
}

export function McpChatDialog({
	open,
	onOpenChange,
	config,
	organizationId,
}: McpChatDialogProps) {
	const tTooltips = useTranslations("tooltips.frames");
	const [tools, setTools] = useState<
		Array<{ name: string; description?: string }>
	>([]);
	const [isLoadingTools, setIsLoadingTools] = useState(false);
	const [isFullscreen, setIsFullscreen] = useState(false);

	const displayName =
		config.displayName || config.mcpServer?.name || "MCP Server";
	const serverUrl = config.baseUrl || config.mcpServer?.defaultUrl;
	const lockedMcpConfigIds = useMemo(
		() => (config.id ? [config.id] : []),
		[config.id],
	);

	// Load tools when dialog opens
	useEffect(() => {
		if (open && config.id) {
			setIsFullscreen(true);
			void loadTools();
		}
		if (!open) {
			setTools([]);
			setIsFullscreen(false);
		}
	}, [open, config.id]);

	const loadTools = async () => {
		if (!config.id) {
			return;
		}

		setIsLoadingTools(true);
		try {
			// Use the same oRPC procedure as the workflow editor
			const result = await orpcClient.mcp.tools.list({
				serverIds: [config.id],
				organizationId,
			});

			const formattedTools = (result.tools || []).map((t: any) => ({
				name: t.name,
				description: t.description || "",
			}));
			setTools(formattedTools);
		} catch (error) {
			console.error("Failed to load tools:", error);
		} finally {
			setIsLoadingTools(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				hideCloseButton
				className={`flex flex-col p-0 ${
					isFullscreen
						? "max-w-none w-screen h-screen rounded-none"
						: "max-w-2xl h-[80vh]"
				}`}
			>
				{/* Header */}
				<DialogHeader className="px-6 py-4 border-b shrink-0">
					<div className="flex items-center gap-3">
						<div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
							<McpServerIcon
								name={config.mcpServer?.name || displayName}
								iconUrl={config.mcpServer?.iconUrl}
								docsUrl={config.mcpServer?.docsUrl}
								repositoryUrl={config.mcpServer?.repositoryUrl}
								defaultUrl={serverUrl}
								size={24}
								className="h-6 w-6 rounded-md"
							/>
						</div>
						<div className="flex-1 min-w-0">
							<DialogTitle asChild>
								<h3 className="text-lg font-semibold">
									Try {displayName}
								</h3>
							</DialogTitle>
							<DialogDescription className="text-xs">
								{serverUrl ? (
									<span className="block truncate">
										{serverUrl}
									</span>
								) : null}
								<span className="block">
									Streaming through Fabric Loom, locked to
									this MCP server.
								</span>
							</DialogDescription>
						</div>
						{/* Right: fullscreen + close on same line, tools count below */}
						<div className="flex flex-col items-end gap-1 shrink-0 absolute right-4 top-4">
							<div className="flex items-center gap-0.5">
								<Button
									variant="ghost"
									size="icon"
									className="rounded-sm opacity-70 hover:opacity-100 h-8 w-8"
									onClick={() =>
										setIsFullscreen(!isFullscreen)
									}
									title={
										isFullscreen
											? "Exit fullscreen"
											: "Fullscreen"
									}
								>
									{isFullscreen ? (
										<Minimize2Icon className="size-4" />
									) : (
										<Maximize2Icon className="size-4" />
									)}
								</Button>
								<DialogClose asChild>
									<Button
										variant="ghost"
										size="icon"
										className="rounded-sm opacity-70 hover:opacity-100 h-8 w-8"
										title="Close"
										aria-label="Close"
									>
										<X className="size-4" />
										<span className="sr-only">Close</span>
									</Button>
								</DialogClose>
							</div>
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-muted/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground dark:bg-muted dark:text-foreground">
										<WrenchIcon className="size-3 shrink-0" />
										{isLoadingTools ? (
											<Loader2Icon className="size-3 shrink-0 animate-spin" />
										) : (
											<span>{tools.length} tools</span>
										)}
										{/* The chip is not focusable, so the portalled
											tooltip is pointer-only. `aria-label` would
											replace the visible "N tools" in the
											accessible name; an `sr-only` child adds the
											explanation alongside it instead. */}
										<span className="sr-only">
											{tTooltips("toolsAvailable", {
												count: tools.length,
											})}
										</span>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									{tTooltips("toolsAvailable", {
										count: tools.length,
									})}
								</TooltipContent>
							</Tooltip>
						</div>
					</div>
				</DialogHeader>

				<div className="flex-1 min-h-0 overflow-hidden">
					{open && config.id ? (
						<FabricTemporalOrchestratorChat
							key={`${config.id}-${open ? "open" : "closed"}`}
							organizationId={organizationId ?? undefined}
							reasoningMode="balanced"
							welcomeMode="focused-agent"
							lockConversationToolPicker
							enabledToolIds={lockedMcpConfigIds}
							enabledAgentIds={[]}
							enabledFabricToolIds={[]}
							enabledIntegrationIds={[]}
							prioritizedMcpConfigIds={lockedMcpConfigIds}
							agentName={displayName}
							agentDescription={`Fabric will keep this run focused on the selected MCP server and its ${tools.length || "available"} tools.`}
							systemPrompt={`Use ${displayName} MCP to answer this question. You are testing the "${displayName}" MCP server. Stay within this MCP server's capabilities, use its tools directly when helpful, and prefer MCP-backed answers over general knowledge whenever this server can provide the answer.`}
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
