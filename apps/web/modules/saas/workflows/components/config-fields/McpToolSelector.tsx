"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	AlertCircleIcon,
	CheckIcon,
	ChevronsUpDownIcon,
	CopyIcon,
	InfoIcon,
	RefreshCwIcon,
	WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface ToolParameter {
	name: string;
	type: string;
	description?: string | null;
	required: boolean;
	enum?: string[] | null;
	default?: unknown;
}

interface McpTool {
	name: string;
	description?: string | null;
	inputSchema?: unknown;
	parameters?: ToolParameter[] | null;
	exampleJson?: string | null;
	serverId: string;
	serverName: string;
}

interface McpToolSelectorProps {
	/**
	 * Array of selected MCP server config IDs
	 */
	mcpServers: string[];
	/**
	 * Currently selected tool name
	 */
	value?: string;
	/**
	 * Callback when tool is selected
	 */
	onChange: (value: string) => void;
	/**
	 * Callback when selected tool changes (with full tool info)
	 */
	onToolSelect?: (tool: McpTool | null) => void;
	/**
	 * Placeholder text
	 */
	placeholder?: string;
	/**
	 * Whether the field is required
	 */
	required?: boolean;
}

export function McpToolSelector({
	mcpServers,
	value = "",
	onChange,
	onToolSelect,
	placeholder = "Select a tool...",
	required = false,
}: McpToolSelectorProps) {
	const [open, setOpen] = useState(false);
	const organizationId = useOrganizationId();

	// Fetch tools from selected MCP servers
	const {
		data: toolsData,
		isLoading,
		isFetching,
		refetch,
		error,
	} = useQuery({
		queryKey: ["mcpTools", mcpServers, organizationId],
		queryFn: async () => {
			if (!mcpServers || mcpServers.length === 0) {
				return { tools: [], errors: [] };
			}
			return await orpcClient.mcp.tools.list({
				serverIds: mcpServers,
				organizationId,
			});
		},
		enabled: mcpServers && mcpServers.length > 0,
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
		retry: 1,
	});

	const tools = (toolsData?.tools ?? []) as McpTool[];
	const fetchErrors = toolsData?.errors ?? [];

	// Group tools by server
	const toolsByServer = useMemo(() => {
		const grouped = new Map<string, McpTool[]>();
		for (const tool of tools) {
			const serverTools = grouped.get(tool.serverName) || [];
			serverTools.push(tool);
			grouped.set(tool.serverName, serverTools);
		}
		return grouped;
	}, [tools]);

	// Find currently selected tool
	const selectedTool = useMemo(
		() => tools.find((t) => t.name === value) || null,
		[tools, value],
	);

	// Notify parent when selected tool changes
	useEffect(() => {
		onToolSelect?.(selectedTool);
	}, [selectedTool, onToolSelect]);

	const handleSelect = useCallback(
		(toolName: string) => {
			onChange(toolName);
			setOpen(false);
		},
		[onChange],
	);

	const copyExampleJson = useCallback(() => {
		if (selectedTool?.exampleJson) {
			navigator.clipboard.writeText(selectedTool.exampleJson);
			toast.success("Example JSON copied to clipboard");
		}
	}, [selectedTool]);

	// No servers selected
	if (!mcpServers || mcpServers.length === 0) {
		return (
			<div className="space-y-2">
				<Label>
					Tool Name
					{required && (
						<span className="text-destructive ml-1">*</span>
					)}
				</Label>
				<div className="p-3 border border-dashed rounded-md text-sm text-muted-foreground">
					Please select MCP servers first to see available tools.
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<Label>
					Tool Name
					{required && (
						<span className="text-destructive ml-1">*</span>
					)}
				</Label>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => refetch()}
					disabled={isFetching}
					className="h-6 px-2 text-xs"
				>
					<RefreshCwIcon
						className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`}
					/>
					Refresh
				</Button>
			</div>

			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						role="combobox"
						aria-expanded={open}
						className="w-full justify-between font-normal"
						disabled={isLoading}
					>
						{isLoading ? (
							<Skeleton className="h-4 w-32" />
						) : selectedTool ? (
							<div className="flex items-center gap-2 truncate">
								<WrenchIcon className="h-4 w-4 text-muted-foreground shrink-0" />
								<span className="truncate">
									{selectedTool.name}
								</span>
								<span className="text-xs text-muted-foreground truncate">
									({selectedTool.serverName})
								</span>
							</div>
						) : value ? (
							<div className="flex items-center gap-2 truncate">
								<WrenchIcon className="h-4 w-4 text-muted-foreground shrink-0" />
								<span className="truncate">{value}</span>
								<span className="text-xs text-highlight">
									(custom)
								</span>
							</div>
						) : (
							<span className="text-muted-foreground">
								{placeholder}
							</span>
						)}
						<ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					className="w-[calc(100vw-1.5rem)] max-w-[450px] p-0"
					align="start"
				>
					<Command>
						<CommandInput placeholder="Search tools..." />
						<CommandList className="max-h-[350px]">
							<CommandEmpty>
								{isLoading ? (
									<div className="flex items-center justify-center py-4">
										<RefreshCwIcon className="h-4 w-4 animate-spin mr-2" />
										Loading tools...
									</div>
								) : error ? (
									<div className="flex items-center justify-center py-4 text-destructive">
										<AlertCircleIcon className="h-4 w-4 mr-2" />
										Failed to load tools
									</div>
								) : (
									"No tools found."
								)}
							</CommandEmpty>
							{Array.from(toolsByServer.entries()).map(
								([serverName, serverTools]) => (
									<CommandGroup
										key={serverName}
										heading={serverName}
									>
										{serverTools.map((tool) => (
											<CommandItem
												key={`${tool.serverId}-${tool.name}`}
												value={tool.name}
												onSelect={() =>
													handleSelect(tool.name)
												}
												className="flex items-start gap-2 py-2"
											>
												<CheckIcon
													className={`h-4 w-4 mt-0.5 shrink-0 ${
														value === tool.name
															? "opacity-100"
															: "opacity-0"
													}`}
												/>
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-2">
														<span className="font-medium">
															{tool.name}
														</span>
														{tool.parameters &&
															tool.parameters
																.length > 0 && (
																<span className="text-xs text-muted-foreground">
																	(
																	{
																		tool
																			.parameters
																			.length
																	}{" "}
																	param
																	{tool
																		.parameters
																		.length !==
																	1
																		? "s"
																		: ""}
																	)
																</span>
															)}
													</div>
													{tool.description && (
														<div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
															<span>
																{
																	tool.description
																}
															</span>
														</div>
													)}
												</div>
											</CommandItem>
										))}
									</CommandGroup>
								),
							)}
						</CommandList>
					</Command>

					{/* Custom tool name input */}
					<div className="border-t p-2">
						<p className="text-xs text-muted-foreground mb-2">
							Or enter a custom tool name:
						</p>
						<input
							type="text"
							value={value}
							onChange={(e) => onChange(e.target.value)}
							placeholder="Custom tool name..."
							className="w-full px-3 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>
				</PopoverContent>
			</Popover>

			{/* Show fetch errors */}
			{fetchErrors.length > 0 && (
				<div className="space-y-1">
					{fetchErrors.map((err, idx) => (
						<div
							key={idx}
							className="flex items-center gap-1 text-xs text-highlight"
						>
							<AlertCircleIcon className="h-3 w-3" />
							<span>
								{err.serverName || err.serverId}: {err.error}
							</span>
						</div>
					))}
				</div>
			)}

			{/* Show tool parameters when selected */}
			{selectedTool && (
				<ToolParametersDisplay
					tool={selectedTool}
					onCopyExample={copyExampleJson}
				/>
			)}
		</div>
	);
}

/**
 * Display tool parameters with their types, descriptions, and example
 */
function ToolParametersDisplay({
	tool,
	onCopyExample,
}: {
	tool: McpTool;
	onCopyExample: () => void;
}) {
	const hasParameters = tool.parameters && tool.parameters.length > 0;
	const hasExampleJson = tool.exampleJson && tool.exampleJson !== "{}";

	// Don't render anything if no useful info to show
	if (!hasParameters && !hasExampleJson) {
		return null;
	}

	return (
		<div className="space-y-2 border rounded-md p-3 bg-muted/30">
			{/* Parameters list */}
			{hasParameters && (
				<div className="space-y-2">
					<div className="flex items-center gap-1">
						<span className="text-xs font-medium">
							Expected Parameters:
						</span>
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger>
									<InfoIcon className="h-3 w-3 text-muted-foreground" />
								</TooltipTrigger>
								<TooltipContent>
									<p>
										Format your Tool Arguments JSON with
										these fields
									</p>
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
					<div className="space-y-1.5">
						{tool.parameters?.map((param) => (
							<div
								key={param.name}
								className="flex items-start gap-2 text-xs"
							>
								<code className="px-1.5 py-0.5 bg-background rounded border font-mono">
									{param.name}
								</code>
								<span className="text-muted-foreground">
									{param.type}
									{param.required && (
										<span className="text-destructive ml-1">
											*
										</span>
									)}
								</span>
								{param.description && (
									<span className="text-muted-foreground flex-1 truncate">
										- {param.description}
									</span>
								)}
								{param.enum && (
									<span className="text-muted-foreground">
										[{param.enum.join(", ")}]
									</span>
								)}
							</div>
						))}
					</div>
				</div>
			)}

			{/* Example JSON */}
			{hasExampleJson && (
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<span className="text-xs font-medium">
							Example JSON:
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={onCopyExample}
							className="h-5 px-1.5 text-xs"
						>
							<CopyIcon className="h-3 w-3 mr-1" />
							Copy
						</Button>
					</div>
					<pre className="text-xs bg-background p-2 rounded border overflow-x-auto font-mono">
						{tool.exampleJson}
					</pre>
				</div>
			)}
		</div>
	);
}

// Export the tool type for use in parent components
export type { McpTool };
