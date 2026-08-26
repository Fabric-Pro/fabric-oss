"use client";

import { McpLogo } from "@saas/mcp/components/McpLogo";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import type { ToolUIPart } from "ai";
import type { LucideIcon } from "lucide-react";
import {
	CheckCircleIcon,
	ChevronRightIcon,
	CircleIcon,
	ClockIcon,
	CodeIcon,
	CopyIcon,
	DownloadIcon,
	FileIcon,
	FileTextIcon,
	GlobeIcon,
	ListIcon,
	PlayIcon,
	SearchIcon,
	SettingsIcon,
	WrenchIcon,
	XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
	createContext,
	isValidElement,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { CodeBlock } from "./code-block";
import { McpAppFrame } from "./McpAppFrame";
import { Response } from "./response";
import {
	isWebSearchOutput,
	SearchLoadingState,
	SearchResultsDisplay,
} from "./search-results-display";

// Known internal (non-MCP) tools
const INTERNAL_TOOLS = new Set([
	"code_executor",
	"task_planner",
	"document_generator",
	"web_search",
	"webSearch",
	"file_read",
	"file_write",
	"list_workflows",
	"get_workflow_details",
	"execute_workflow",
]);

// Search-related tools that should show specialized loading/results
const SEARCH_TOOLS = new Set([
	"webSearch",
	"web_search",
	"contentRetrieve",
	"content_retrieve",
]);

// Tool-specific icon mapping for better visual identification
const TOOL_ICONS: Record<string, LucideIcon> = {
	// Search tools
	webSearch: SearchIcon,
	web_search: SearchIcon,
	contentRetrieve: GlobeIcon,
	content_retrieve: GlobeIcon,
	// Code/execution tools
	code_executor: CodeIcon,
	// Planning tools
	task_planner: ListIcon,
	// Document tools
	document_generator: FileTextIcon,
	// File tools
	file_read: FileIcon,
	file_write: FileIcon,
	// Workflow tools
	list_workflows: ListIcon,
	get_workflow_details: SettingsIcon,
	execute_workflow: PlayIcon,
};

/**
 * Get the appropriate icon for a tool
 */
function getToolIcon(toolName?: string): LucideIcon {
	if (!toolName) {
		return WrenchIcon;
	}

	// Check for exact match in icon mapping
	if (TOOL_ICONS[toolName]) {
		return TOOL_ICONS[toolName];
	}

	// Check for partial matches based on tool name patterns
	const lowerName = toolName.toLowerCase();
	if (lowerName.includes("search")) {
		return SearchIcon;
	}
	if (lowerName.includes("scrape") || lowerName.includes("crawl")) {
		return GlobeIcon;
	}
	if (lowerName.includes("code") || lowerName.includes("execute")) {
		return CodeIcon;
	}
	if (
		lowerName.includes("file") ||
		lowerName.includes("read") ||
		lowerName.includes("write")
	) {
		return FileIcon;
	}
	if (lowerName.includes("document") || lowerName.includes("generate")) {
		return FileTextIcon;
	}
	if (lowerName.includes("list")) {
		return ListIcon;
	}

	return WrenchIcon;
}

// Module-level Map to persist expanded state across component remounts during streaming
// This survives React re-renders because it's outside the component lifecycle
const expandedStateMap = new Map<string, boolean>();

/**
 * Check if a tool is an MCP tool based on its name
 */
function isMcpTool(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	// Internal tools are not MCP tools
	if (INTERNAL_TOOLS.has(toolName)) {
		return false;
	}
	// Delegate calls to internal agents are not MCP tools
	if (toolName.startsWith("delegate:")) {
		return false;
	}
	// MCP tools typically have underscores and are from external servers
	// e.g., firecrawl_search, firecrawl_scrape, slack_post_message
	return toolName.includes("_");
}

/**
 * Check if a tool result is a document artifact that should be rendered as markdown
 */
function isDocumentArtifact(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	// Document artifacts from agent delegation
	// e.g., project_document_generator:document, document_generator:prd
	return (
		toolName.includes(":document") ||
		toolName.includes(":prd") ||
		toolName.includes(":spec") ||
		toolName.includes(":proposal") ||
		toolName.includes(":report")
	);
}

/**
 * Check if a tool is an agent delegation call
 */
function isDelegateToolCall(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	return toolName.startsWith("delegate:");
}

/**
 * Extract the response content from a delegate tool call result
 */
function extractDelegateResponse(output: unknown): string | null {
	if (!output || typeof output !== "object") {
		return null;
	}
	const result = output as Record<string, unknown>;
	// Check for response field in successful delegation
	if (
		result.success === true &&
		typeof result.response === "string" &&
		result.response.length > 0
	) {
		return result.response;
	}
	return null;
}

/**
 * Get appropriate loading text based on tool name
 */
function getToolLoadingText(toolName?: string): string {
	if (!toolName) {
		return "Running tool...";
	}

	// Common tool patterns
	const lowerName = toolName.toLowerCase();

	if (lowerName.includes("search")) {
		return "Searching...";
	}
	if (lowerName.includes("scrape") || lowerName.includes("crawl")) {
		return "Scraping content...";
	}
	if (
		lowerName.includes("read") ||
		lowerName.includes("get") ||
		lowerName.includes("fetch")
	) {
		return "Fetching data...";
	}
	if (
		lowerName.includes("write") ||
		lowerName.includes("create") ||
		lowerName.includes("post")
	) {
		return "Creating...";
	}
	if (lowerName.includes("update") || lowerName.includes("edit")) {
		return "Updating...";
	}
	if (lowerName.includes("delete") || lowerName.includes("remove")) {
		return "Removing...";
	}
	if (lowerName.includes("list")) {
		return "Listing...";
	}
	if (lowerName.includes("analyze") || lowerName.includes("process")) {
		return "Processing...";
	}
	if (lowerName.includes("generate")) {
		return "Generating...";
	}
	if (lowerName.includes("execute") || lowerName.includes("run")) {
		return "Executing...";
	}
	if (lowerName.includes("send") || lowerName.includes("notify")) {
		return "Sending...";
	}
	if (lowerName.includes("delegate")) {
		return "Delegating to agent...";
	}

	// MCP tool - show a generic message with tool name
	if (isMcpTool(toolName)) {
		const serverName = toolName.split("_")[0];
		return `Running ${serverName}...`;
	}

	return "Running tool...";
}

/**
 * Generic loading state for tools (non-search)
 */
function ToolLoadingState({
	toolName,
	text,
	isMcp,
}: {
	toolName?: string;
	text: string;
	isMcp: boolean;
}) {
	return (
		<div className="relative w-full rounded-md border bg-muted/30 overflow-hidden">
			{/* Animated gradient border */}
			<div className="absolute inset-0 rounded-md">
				<div
					className="absolute inset-0 rounded-md bg-gradient-to-r from-transparent via-primary/20 to-transparent animate-shimmer"
					style={{ backgroundSize: "200% 100%" }}
				/>
			</div>

			<div className="relative p-4 flex items-center gap-3">
				{/* Icon with pulse animation */}
				<div className="relative flex items-center justify-center w-10 h-10 rounded-full bg-muted">
					<div className="absolute inset-0 rounded-full bg-primary/10 animate-ping" />
					{isMcp ? (
						<McpLogo size={20} className="relative z-10" />
					) : (
						<WrenchIcon className="relative z-10 w-5 h-5 text-muted-foreground" />
					)}
				</div>

				{/* Text with shimmer effect */}
				<div className="flex flex-col gap-1.5">
					<span className="text-sm font-medium animate-pulse">
						{text}
					</span>
					{toolName && (
						<span className="text-xs text-muted-foreground font-mono">
							{toolName}
						</span>
					)}
				</div>

				{/* Loading dots */}
				<div className="ml-auto flex gap-1">
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-bounce"
							style={{ animationDelay: `${i * 0.15}s` }}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * Check if a tool is a search tool
 */
function isSearchTool(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	return SEARCH_TOOLS.has(toolName);
}

// Context for passing tool name, state, and expand state to child components
interface ToolContextValue {
	toolName?: string;
	toolState?: string;
	expanded: boolean;
	setExpanded: (expanded: boolean) => void;
	/**
	 * Controls whether the header is interactive and the content can render.
	 * When false:
	 *   - ToolHeader renders as a static row (no button, no chevron, no click).
	 *   - ToolContent (including ToolInput/ToolOutput JSON dumps) renders nothing.
	 * Default is true to preserve backward compatibility with existing call
	 * sites (Orchestrator chat, agent runs, etc.) that rely on expansion.
	 * FabricDirectChat (Fabric Loom launcher) opts into the compact pill UX.
	 */
	expandable: boolean;
	/** MCP App: ui:// resource URI — present when tool has an interactive UI */
	mcpAppResourceUri?: string;
	/** MCP App: config ID for proxying tool calls from the iframe */
	mcpAppConfigId?: string;
	/** MCP App: organization ID for tenant isolation */
	mcpAppOrganizationId?: string | null;
	/** MCP App: tool call arguments sent via ui/notifications/tool-input */
	mcpAppToolArgs?: Record<string, unknown>;
}

const ToolContext = createContext<ToolContextValue>({
	expanded: false,
	setExpanded: () => {},
	expandable: true,
});

export type ToolProps = ComponentProps<"div"> & {
	toolName?: string;
	toolState?: string;
	defaultExpanded?: boolean;
	/**
	 * When false, render as a non-interactive pill — the header is a plain
	 * row (no button, no chevron, no click handler) and the JSON
	 * input/output content never appears. Use for surfaces that intentionally
	 * hide internals (e.g. Fabric Loom launcher chat). Default true.
	 */
	expandable?: boolean;
	/** Unique ID for this tool call - used to persist expanded state across remounts */
	toolId?: string;
	/** MCP App: ui:// resource URI — present when tool has an interactive UI */
	mcpAppResourceUri?: string;
	/** MCP App: config ID for proxying tool calls from the iframe */
	mcpAppConfigId?: string;
	/** MCP App: organization ID for tenant isolation */
	mcpAppOrganizationId?: string | null;
	/** MCP App: tool call arguments sent via ui/notifications/tool-input */
	mcpAppToolArgs?: Record<string, unknown>;
};

// Counter for generating unique IDs when toolId is not provided
let toolIdCounter = 0;

export const Tool = ({
	className,
	toolName,
	toolState,
	defaultExpanded = false,
	expandable = true,
	toolId,
	mcpAppResourceUri,
	mcpAppConfigId,
	mcpAppOrganizationId,
	mcpAppToolArgs,
	children,
	...props
}: ToolProps) => {
	// Generate a stable ID for this tool instance
	const [stableId] = useState(() => toolId || `tool-${toolIdCounter++}`);

	// Initialize expanded state from the persistent map, or use defaultExpanded
	const [expanded, setExpandedState] = useState(() => {
		const persistedExpanded = expandedStateMap.get(stableId);
		if (persistedExpanded !== undefined) {
			return persistedExpanded;
		}
		return defaultExpanded;
	});

	// Custom setter that updates both React state and the persistent map
	const setExpanded = useCallback(
		(value: boolean) => {
			expandedStateMap.set(stableId, value);
			setExpandedState(value);
		},
		[stableId],
	);

	// Sync with persistent map on mount (in case component remounted)
	useEffect(() => {
		const persistedValue = expandedStateMap.get(stableId);
		if (persistedValue !== undefined && persistedValue !== expanded) {
			setExpandedState(persistedValue);
		}
	}, [stableId, expanded]);

	// For tools that are still running, show loading state
	const isRunning =
		toolState === "input-streaming" || toolState === "input-available";

	if (isRunning) {
		// Search tools get specialized loading state
		if (isSearchTool(toolName)) {
			return (
				<div className={cn("mb-4", className)}>
					<SearchLoadingState
						text={
							toolName === "webSearch" ||
							toolName === "web_search"
								? "Searching the web..."
								: "Retrieving content..."
						}
					/>
				</div>
			);
		}

		// All other tools get a generic loading state
		const loadingText = getToolLoadingText(toolName);
		return (
			<div className={cn("mb-4", className)}>
				<ToolLoadingState
					toolName={toolName}
					text={loadingText}
					isMcp={isMcpTool(toolName)}
				/>
			</div>
		);
	}

	return (
		<ToolContext.Provider
			value={{
				toolName,
				toolState,
				expanded,
				setExpanded,
				expandable,
				mcpAppResourceUri,
				mcpAppConfigId,
				mcpAppOrganizationId,
				mcpAppToolArgs,
			}}
		>
			<div
				className={cn(
					"not-prose mb-4 w-full max-w-full min-w-0 rounded-lg border bg-card overflow-hidden",
					className,
				)}
				{...props}
			>
				{children}
			</div>
		</ToolContext.Provider>
	);
};

export type ToolHeaderProps = {
	title?: string;
	type: ToolUIPart["type"];
	state: ToolUIPart["state"];
	className?: string;
	/** Optional input summary to show in the header */
	inputSummary?: string;
};

const getStatusBadge = (status: ToolUIPart["state"]) => {
	let label: string;
	let icon: ReactNode;

	switch (status) {
		case "input-streaming":
			label = "Pending";
			icon = <CircleIcon className="size-4" />;
			break;
		case "input-available":
			label = "Running";
			icon = <ClockIcon className="size-4 animate-pulse" />;
			break;
		case "output-available":
			label = "Completed";
			icon = <CheckCircleIcon className="size-4 text-green-600" />;
			break;
		case "output-error":
			label = "Error";
			icon = <XCircleIcon className="size-4 text-red-600" />;
			break;
		default:
			label = "Updated";
			icon = <CheckCircleIcon className="size-4" />;
	}

	return (
		<Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
			{icon}
			{label}
		</Badge>
	);
};

export const ToolHeader = ({
	className,
	title,
	type,
	state,
	inputSummary,
}: ToolHeaderProps) => {
	const { expanded, setExpanded, toolName, expandable } =
		useContext(ToolContext);
	const isMcp = isMcpTool(title || toolName);
	const ToolIcon = getToolIcon(title || toolName);

	const body = (
		<div className="flex items-center gap-3 min-w-0 flex-1">
			{isMcp ? (
				<McpLogo size={18} />
			) : (
				<ToolIcon className="size-[18px] text-muted-foreground shrink-0" />
			)}
			<div className="flex flex-col items-start gap-0.5 min-w-0 flex-1">
				<div className="flex items-center gap-2 flex-wrap">
					<span className="font-medium text-sm">
						{title ?? type.split("-").slice(1).join("-")}
					</span>
					{getStatusBadge(state)}
				</div>
				{inputSummary && (
					<span className="text-xs text-muted-foreground line-clamp-1">
						{inputSummary}
					</span>
				)}
			</div>
		</div>
	);

	// Non-expandable variant: render as a static row. No button semantics, no
	// chevron, no hover affordance. Used by surfaces that intentionally hide
	// tool internals (Fabric Loom launcher chat — the user wants a clean pill
	// per tool/skill call without raw JSON dumps). No `text-left` here —
	// it was a button-only reset; on a flex <div> with no inline children
	// it does nothing (PR 1093 review #6).
	if (!expandable) {
		return (
			<div
				className={cn(
					"flex w-full items-center gap-4 px-4 py-3",
					className,
				)}
				data-testid="tool-header"
				data-expandable="false"
			>
				{body}
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setExpanded(!expanded)}
			className={cn(
				"flex w-full items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer text-left",
				className,
			)}
			data-testid="tool-header"
			data-expandable="true"
		>
			{body}
			<ChevronRightIcon
				className={cn(
					"size-4 text-muted-foreground transition-transform shrink-0",
					expanded && "rotate-90",
				)}
				data-testid="tool-chevron"
			/>
		</button>
	);
};

export type ToolContentProps = ComponentProps<"div">;

export const ToolContent = ({
	className,
	children,
	...props
}: ToolContentProps) => {
	const { expanded, expandable } = useContext(ToolContext);

	// When the surrounding Tool is rendered as non-expandable, the content
	// (Parameters / Result JSON, MCP iframe trigger, etc.) is suppressed
	// entirely — regardless of any persisted "expanded=true" flag in the
	// global expandedStateMap from a previous remount. Fabric Loom's pill UX
	// depends on this; without the guard, a user who'd previously expanded
	// the same tool would see the JSON reappear on the next visit.
	if (!expandable || !expanded) {
		return null;
	}

	return (
		<div
			className={cn(
				"border-t animate-in slide-in-from-top-2 fade-in-0 duration-200",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
};

export type ToolInputProps = ComponentProps<"div"> & {
	input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
	<div
		className={cn(
			"space-y-2 overflow-hidden max-w-full min-w-0 p-4",
			className,
		)}
		{...props}
	>
		<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
			Parameters
		</h4>
		<div className="rounded-md bg-muted/50 overflow-x-auto max-w-full min-w-0">
			<CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
		</div>
	</div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
	output: ToolUIPart["output"];
	errorText: ToolUIPart["errorText"];
};

export const ToolOutput = ({
	className,
	output,
	errorText,
	...props
}: ToolOutputProps) => {
	const {
		toolName,
		mcpAppResourceUri,
		mcpAppConfigId,
		mcpAppOrganizationId,
		mcpAppToolArgs,
	} = useContext(ToolContext);
	const [copied, setCopied] = useState(false);

	const isDocument = isDocumentArtifact(toolName);
	const documentContent =
		isDocument && typeof output === "string" ? output : null;

	const handleCopy = useCallback(() => {
		if (documentContent) {
			navigator.clipboard.writeText(documentContent);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [documentContent]);

	const handleDownload = useCallback(() => {
		if (documentContent) {
			const blob = new Blob([documentContent], { type: "text/markdown" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${toolName?.split(":")[1] || "document"}.md`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
	}, [documentContent, toolName]);

	if (!(output || errorText)) {
		return null;
	}

	// Render MCP App interactive UI (takes priority over raw JSON output)
	if (mcpAppResourceUri && mcpAppConfigId) {
		return (
			<div
				className={cn(
					"p-4 overflow-hidden max-w-full min-w-0",
					className,
				)}
				{...props}
			>
				<McpAppFrame
					resourceUri={mcpAppResourceUri}
					configId={mcpAppConfigId}
					organizationId={mcpAppOrganizationId}
					toolArgs={mcpAppToolArgs}
					toolResult={output}
				/>
			</div>
		);
	}

	// Render web search results with specialized component
	if (isWebSearchOutput(output)) {
		return (
			<div
				className={cn(
					"p-4 overflow-hidden max-w-full min-w-0",
					className,
				)}
				{...props}
			>
				<SearchResultsDisplay output={output} defaultExpanded={true} />
			</div>
		);
	}

	// Render document artifacts as markdown with copy/download
	if (documentContent) {
		return (
			<div
				className={cn(
					"space-y-2 p-4 overflow-hidden max-w-full min-w-0",
					className,
				)}
				{...props}
			>
				<div className="flex items-center justify-between">
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide flex items-center gap-2">
						<FileTextIcon className="size-4" />
						Generated Document
					</h4>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							onClick={handleCopy}
							className="h-7 px-2 text-xs"
						>
							<CopyIcon className="size-3 mr-1" />
							{copied ? "Copied!" : "Copy"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={handleDownload}
							className="h-7 px-2 text-xs"
						>
							<DownloadIcon className="size-3 mr-1" />
							Download
						</Button>
					</div>
				</div>
				<div className="rounded-md border bg-background p-4 max-h-[500px] overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
					<Response>{documentContent}</Response>
				</div>
			</div>
		);
	}

	// Render agent delegation responses as formatted markdown
	const isDelegation = isDelegateToolCall(toolName);
	const delegateResponse = isDelegation
		? extractDelegateResponse(output)
		: null;

	if (delegateResponse) {
		const agentName = toolName?.replace("delegate:", "") || "Agent";
		return (
			<div
				className={cn(
					"space-y-2 p-4 overflow-hidden max-w-full min-w-0",
					className,
				)}
				{...props}
			>
				<div className="flex items-center justify-between">
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide flex items-center gap-2">
						<FileTextIcon className="size-4" />
						{agentName} Output
					</h4>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								navigator.clipboard.writeText(delegateResponse);
								setCopied(true);
								setTimeout(() => setCopied(false), 2000);
							}}
							className="h-7 px-2 text-xs"
						>
							<CopyIcon className="size-3 mr-1" />
							{copied ? "Copied!" : "Copy"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								const blob = new Blob([delegateResponse], {
									type: "text/markdown",
								});
								const url = URL.createObjectURL(blob);
								const a = document.createElement("a");
								a.href = url;
								a.download = `${agentName.toLowerCase().replace(/\s+/g, "-")}-output.md`;
								document.body.appendChild(a);
								a.click();
								document.body.removeChild(a);
								URL.revokeObjectURL(url);
							}}
							className="h-7 px-2 text-xs"
						>
							<DownloadIcon className="size-3 mr-1" />
							Download
						</Button>
					</div>
				</div>
				<div className="rounded-md border bg-background p-4 max-h-[500px] overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
					<Response>{delegateResponse}</Response>
				</div>
			</div>
		);
	}

	let Output = <div className="wrap-break-word">{output as ReactNode}</div>;

	if (typeof output === "object" && !isValidElement(output)) {
		Output = (
			<CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
		);
	} else if (typeof output === "string") {
		Output = <CodeBlock code={output} language="json" />;
	}

	return (
		<div
			className={cn(
				"space-y-2 p-4 overflow-hidden max-w-full min-w-0",
				className,
			)}
			{...props}
		>
			<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{errorText ? "Error" : "Result"}
			</h4>
			<div
				className={cn(
					"overflow-x-auto max-w-full min-w-0 rounded-md text-xs [&_table]:w-full",
					errorText
						? "bg-destructive/10 text-destructive"
						: "bg-muted/50 text-foreground",
				)}
			>
				{errorText && (
					<div className="p-2 wrap-break-word">{errorText}</div>
				)}
				{Output}
			</div>
		</div>
	);
};
