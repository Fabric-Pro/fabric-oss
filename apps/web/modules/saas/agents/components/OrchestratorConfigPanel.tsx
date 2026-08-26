"use client";

/**
 * OrchestratorConfigPanel
 *
 * Configuration panel for the Fabric AI Orchestrator that allows users to:
 * - Enable/disable which agents the orchestrator can delegate to
 * - Enable/disable which MCP servers/tools are available
 *
 * This gives users fine-grained control over what the orchestrator can use.
 */

import { McpLogo } from "@saas/mcp/components/McpLogo";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { SearchInput } from "@ui/components/search-input";
import { Skeleton } from "@ui/components/skeleton";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ChevronDown, ChevronRight, Plug2, Search, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	executeWithRetry,
	getFromLocalStorage,
	hasLocalStorageKey,
	STORAGE_KEYS,
	setToLocalStorage,
	showSyncError,
	showSyncSuccess,
} from "../hooks/useAgentConfigPersistence";

// Fabric AI tools available for semantic routing
const FABRIC_AI_TOOLS = [
	{
		id: "fabric_pattern",
		name: "Apply Pattern",
		description:
			"Apply Fabric AI patterns to text content for analysis, summarization, or transformation",
		category: "Patterns",
	},
	{
		id: "fabric_analyze_youtube",
		name: "Analyze YouTube Video",
		description:
			"Extract transcript and apply a pattern to summarize or analyze YouTube videos",
		category: "YouTube",
	},
	{
		id: "fabric_youtube_transcript",
		name: "YouTube Transcript",
		description:
			"Extract plain transcript from YouTube videos without pattern analysis",
		category: "YouTube",
	},
	{
		id: "fabric_youtube_metadata",
		name: "YouTube Metadata",
		description:
			"Get video title, channel, views, duration, and other metadata",
		category: "YouTube",
	},
	{
		id: "fabric_youtube_comments",
		name: "YouTube Comments",
		description: "Retrieve comments and discussions from YouTube videos",
		category: "YouTube",
	},
	{
		id: "fabric_youtube_playlist",
		name: "YouTube Playlist",
		description: "Get all video IDs and details from a YouTube playlist",
		category: "YouTube",
	},
	{
		id: "fabric_scrape_url",
		name: "Scrape URL",
		description: "Extract readable content from web pages using Jina AI",
		category: "Web",
	},
	{
		id: "fabric_readability",
		name: "HTML Readability",
		description: "Extract main readable content from raw HTML",
		category: "Web",
	},
	{
		id: "fabric_transcribe_audio",
		name: "Transcribe Audio",
		description: "Convert audio files to text using whisper transcription",
		category: "Audio",
	},
	{
		id: "fabric_list_patterns",
		name: "List Patterns",
		description: "List all available Fabric patterns for content analysis",
		category: "Discovery",
	},
	{
		id: "fabric_list_models",
		name: "List Models",
		description: "List available AI models configured in Fabric",
		category: "Discovery",
	},
	{
		id: "fabric_get_context",
		name: "Get Context",
		description: "Retrieve a context definition from Fabric",
		category: "Contexts",
	},
	{
		id: "fabric_list_contexts",
		name: "List Contexts",
		description: "List all available Fabric contexts",
		category: "Contexts",
	},
	{
		id: "fabric_get_strategy",
		name: "Get Strategy",
		description: "Retrieve a strategy definition from Fabric",
		category: "Strategies",
	},
	{
		id: "fabric_list_strategies",
		name: "List Strategies",
		description: "List all available Fabric strategies",
		category: "Strategies",
	},
	{
		id: "fabric_template_plugins",
		name: "Template Plugins",
		description:
			"List available template plugins for pattern customization",
		category: "Discovery",
	},
	// Web search and analysis tools
	{
		id: "fabric_web_search",
		name: "Web Search",
		description: "Search the web using Jina AI and return relevant results",
		category: "Web",
	},
	{
		id: "fabric_search_and_analyze",
		name: "Search & Analyze",
		description:
			"Search the web and analyze combined results using a Fabric pattern",
		category: "Web",
	},
	{
		id: "fabric_scrape_and_analyze",
		name: "Scrape & Analyze",
		description:
			"Scrape content from a web page and analyze it using a Fabric pattern",
		category: "Web",
	},
	// Workspace RAG tools
	{
		id: "workspace_rag_query",
		name: "Workspace Query",
		description:
			"Search and retrieve information from your workspace documents",
		category: "Workspace",
	},
	{
		id: "workspace_rag_summarize",
		name: "Workspace Summarize",
		description:
			"Summarize or get an overview of documents in your workspace",
		category: "Workspace",
	},
	// Image generation tools
	{
		id: "fabric_generate_image",
		name: "Image Generation",
		description: "Generate and edit images using AI with text prompts",
		category: "Image",
	},
	// First-class Frame tools
	{
		id: "fabric_create_frame",
		name: "Create Frame",
		description:
			"Generate an interactive frame with HTML, Mermaid, or Markdown content",
		category: "Frames",
	},
	{
		id: "fabric_create_slideshow",
		name: "Create Slideshow",
		description:
			"Generate a multi-slide interactive slideshow presentation",
		category: "Frames",
	},
	{
		id: "fabric_update_frame",
		name: "Update Frame",
		description: "Update the content or metadata of an existing frame",
		category: "Frames",
	},
	{
		id: "fabric_get_frame",
		name: "Get Frame",
		description: "Retrieve a frame by ID to view its content",
		category: "Frames",
	},
	{
		id: "fabric_list_frames",
		name: "List Frames",
		description: "List all frames created in the current context",
		category: "Frames",
	},
	{
		id: "fabric_share_frame",
		name: "Share Frame",
		description: "Publish a frame with a public share link",
		category: "Frames",
	},
];

// Integration provider display info
const INTEGRATION_PROVIDERS: Record<
	string,
	{ name: string; description: string; color: string }
> = {
	SLACK: {
		name: "Slack",
		description: "Send messages and manage channels",
		color: "bg-[#4A154B]",
	},
	GITHUB: {
		name: "GitHub",
		description: "Manage repositories, issues, and PRs",
		color: "bg-[#24292e]",
	},
	MICROSOFT_GRAPH: {
		name: "Microsoft Teams",
		description:
			"Search and access Teams messages, channels, and shared files",
		color: "bg-[#6264A7]",
	},
	LINEAR: {
		name: "Linear",
		description: "Create and manage issues and projects",
		color: "bg-[#5E6AD2]",
	},
	RESEND: {
		name: "Resend",
		description: "Send transactional emails",
		color: "bg-[#000000]",
	},
	PERPLEXITY: {
		name: "Perplexity",
		description: "AI-powered web search",
		color: "bg-[#1FB8CD]",
	},
	FIRECRAWL: {
		name: "Firecrawl",
		description: "Web scraping and data extraction",
		color: "bg-[#FF6B35]",
	},
	FAL: {
		name: "Fal.ai",
		description: "Run AI models and image generation",
		color: "bg-[#7C3AED]",
	},
	CUSTOM_WEBHOOK: {
		name: "Custom Webhook",
		description: "Send data to custom endpoints",
		color: "bg-gray-500",
	},
};

// System agents that are always available (from AGENT_REGISTRY in orchestrator-types.ts)
const SYSTEM_AGENTS = [
	{
		id: "project_document_generator",
		name: "Project Document Generator",
		description: "PRDs, technical specs, project documentation",
		scope: "SYSTEM" as const,
	},
	{
		id: "document_generator",
		name: "Document Generator",
		description: "General documents, articles, summaries",
		scope: "SYSTEM" as const,
	},
	{
		id: "task_planner",
		name: "Task Planner",
		description: "Task breakdown and planning",
		scope: "SYSTEM" as const,
	},
	{
		id: "story_breakdown",
		name: "Feature Breakdown",
		description: "Features and sprint planning",
		scope: "SYSTEM" as const,
	},
	{
		id: "code_executor",
		name: "Code Executor",
		description: "Execute and analyze code",
		scope: "SYSTEM" as const,
	},
	{
		id: "prompt_enhancer",
		name: "Prompt Enhancer",
		description: "Improve and optimize prompts",
		scope: "SYSTEM" as const,
	},
	{
		id: "api_agent",
		name: "API Agent",
		description: "Complex API workflows",
		scope: "SYSTEM" as const,
	},
	{
		id: "data_analyst",
		name: "Data Analyst",
		description:
			"Data analysis, visualization, charts, reports from MCP data sources",
		scope: "SYSTEM" as const,
	},
	{
		id: "cuga_generalist",
		name: "CUGA Generalist Agent",
		description:
			"Browser automation, API orchestration, code execution, task decomposition",
		scope: "SYSTEM" as const,
	},
	{
		id: "mcp_tool_executor",
		name: "MCP Tool Executor",
		description: "Execute MCP tools",
		scope: "SYSTEM" as const,
	},
];

interface Agent {
	id: string;
	agentId?: string;
	name: string;
	displayName?: string;
	description?: string;
	scope: "SYSTEM" | "ORGANIZATION" | "USER";
	framework?: string;
}

interface McpConfig {
	id: string;
	displayName: string;
	description?: string;
	enabled: boolean;
	scope?: "USER" | "ORGANIZATION";
}

interface Integration {
	id: string;
	provider: string;
	name: string;
	isActive: boolean;
	hasCredentials: boolean;
}

interface OrchestratorConfigPanelProps {
	organizationId?: string;
	enabledAgentIds: string[];
	enabledMcpConfigIds: string[];
	enabledFabricToolIds: string[];
	enabledIntegrationIds?: string[];
	prioritizedToolIds: string[];
	prioritizedAgentIds: string[];
	prioritizedMcpConfigIds: string[];
	prioritizedIntegrationIds?: string[];
	onAgentToggle: (agentId: string, enabled: boolean) => void;
	onMcpToggle: (configId: string, enabled: boolean) => void;
	onFabricToolToggle: (toolId: string, enabled: boolean) => void;
	onIntegrationToggle?: (integrationId: string, enabled: boolean) => void;
	onAgentPrioritize: (agentId: string, prioritized: boolean) => void;
	onMcpPrioritize: (configId: string, prioritized: boolean) => void;
	onToolPrioritize: (toolId: string, prioritized: boolean) => void;
	onIntegrationPrioritize?: (
		integrationId: string,
		prioritized: boolean,
	) => void;
	onEnableAllAgents: () => void;
	onDisableAllAgents: () => void;
	onEnableAllMcp: () => void;
	onDisableAllMcp: () => void;
	onEnableAllFabricTools: () => void;
	onDisableAllFabricTools: () => void;
	onEnableAllIntegrations?: (integrationIds: string[]) => void;
	onDisableAllIntegrations?: () => void;
	/** Whether to show the agents section (default: true). Set to false for Direct Mode. */
	showAgents?: boolean;
	sectionMode?: "all" | "agents" | "tools";
	className?: string;
}

/**
 * The star toggle shared by the agents / servers / tools / integrations rows.
 * It is icon-only, so it carries both the tooltip and an `aria-label` — the
 * star glyph is its entire content, and there is no visible text to name it.
 */
function PriorityStarButton({
	isPrioritized,
	onToggle,
	copy,
	activeClassName,
	idleClassName,
}: {
	isPrioritized: boolean;
	onToggle: () => void;
	copy: string;
	activeClassName: string;
	idleClassName: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={onToggle}
					className={cn(
						"flex-shrink-0",
						isPrioritized ? activeClassName : idleClassName,
					)}
					aria-label={copy}
				>
					<Star
						className={cn(
							"h-3 w-3",
							isPrioritized && "fill-current",
						)}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent>{copy}</TooltipContent>
		</Tooltip>
	);
}

export function OrchestratorConfigPanel({
	organizationId,
	enabledAgentIds,
	enabledMcpConfigIds,
	enabledFabricToolIds,
	enabledIntegrationIds = [],
	prioritizedToolIds,
	prioritizedAgentIds,
	prioritizedMcpConfigIds,
	prioritizedIntegrationIds = [],
	onAgentToggle,
	onMcpToggle,
	onFabricToolToggle,
	onIntegrationToggle = () => {},
	onAgentPrioritize,
	onMcpPrioritize,
	onToolPrioritize,
	onIntegrationPrioritize = () => {},
	onEnableAllAgents,
	onDisableAllAgents,
	onEnableAllMcp,
	onDisableAllMcp,
	onEnableAllFabricTools,
	onDisableAllFabricTools,
	onEnableAllIntegrations = (_ids: string[]) => {},
	onDisableAllIntegrations = () => {},
	showAgents = true,
	sectionMode = "all",
	className,
}: OrchestratorConfigPanelProps) {
	const t = useTranslations("tooltips.agents");
	const [agentsOpen, setAgentsOpen] = useState(true);
	const [mcpOpen, setMcpOpen] = useState(true);
	const [fabricOpen, setFabricOpen] = useState(true);
	const [integrationsOpen, setIntegrationsOpen] = useState(true);
	const [agentSearch, setAgentSearch] = useState("");
	const [mcpSearch, setMcpSearch] = useState("");
	const [fabricSearch, setFabricSearch] = useState("");
	const [integrationSearch, setIntegrationSearch] = useState("");
	// Track if component has mounted (for hydration-safe rendering of dynamic counts)
	const [hasMounted, setHasMounted] = useState(false);
	useEffect(() => {
		setHasMounted(true);
	}, []);

	// Fetch user-registered agents
	const { data: registeredAgentsData, isLoading: isLoadingAgents } = useQuery(
		{
			queryKey: ["agents", "registry", "list", organizationId],
			queryFn: async () => {
				const result = await orpcClient.agents.registry.list({
					limit: 100,
					offset: 0,
					organizationId,
				});
				return result;
			},
		},
	);

	// Fetch MCP configurations
	// SECURITY: Strict isolation between personal and organizational data
	// When in organization context, only fetch org configs
	// When in personal context, only fetch personal configs
	const { data: mcpConfigsData = [], isLoading: isLoadingMcp } = useQuery({
		queryKey: ["mcp-configs", { organizationId }],
		queryFn: async () => {
			if (organizationId) {
				// Organization context: fetch only org configs
				return await orpcClient.mcp.configs.list({ organizationId });
			}
			// Personal context: fetch only user configs
			return await orpcClient.mcp.configs.list();
		},
	});

	// Fetch workflow integrations
	// SECURITY: Strict isolation between personal and organizational data
	// Pass null explicitly for personal context to prevent session fallback
	// staleTime: 0 ensures fresh data — status may change via settings page
	const { data: integrationsData, isLoading: isLoadingIntegrations } =
		useQuery({
			// Normalize queryKey to match the API call (null for personal context)
			// This prevents caching the same request under different keys (undefined vs null)
			queryKey: [
				"workflow-integrations",
				{ organizationId: organizationId ?? null },
			],
			queryFn: async () => {
				const result = await orpcClient.workflows.integrations.list({
					// Pass null explicitly for personal context (when organizationId is undefined)
					// This prevents resolveOrganizationId from falling back to session's activeOrganizationId
					organizationId: organizationId ?? null,
				});
				return result.integrations || [];
			},
			staleTime: 0,
		});

	// Combine system agents with user-registered A2A agents
	const allAgents = useMemo(() => {
		const agents: Agent[] = [...SYSTEM_AGENTS];

		// Add user-registered A2A agents
		if (registeredAgentsData?.agents) {
			for (const agent of registeredAgentsData.agents) {
				// Only include A2A agents that aren't already in system agents
				if (
					agent.framework === "A2A" &&
					!SYSTEM_AGENTS.some((s) => s.id === agent.agentId)
				) {
					agents.push({
						id: agent.agentId,
						agentId: agent.agentId,
						name: agent.displayName || agent.name,
						displayName: agent.displayName,
						description: agent.description || undefined,
						scope: agent.scope as
							| "SYSTEM"
							| "ORGANIZATION"
							| "USER",
						framework: agent.framework,
					});
				}
			}
		}

		return agents;
	}, [registeredAgentsData]);

	// Get MCP configs - displayName from config, or fallback to mcpServer.name
	const mcpConfigs: McpConfig[] = useMemo(() => {
		if (!mcpConfigsData || mcpConfigsData.length === 0) {
			return [];
		}
		return mcpConfigsData.map((config: any) => ({
			id: config.id,
			displayName:
				config.displayName ||
				config.mcpServer?.name ||
				config.mcpServerId ||
				"Unknown Server",
			description: config.mcpServer?.description || config.description,
			enabled: config.enabled,
			scope: config.organizationId
				? ("ORGANIZATION" as const)
				: ("USER" as const),
		}));
	}, [mcpConfigsData]);

	// Get integrations list
	const integrations: Integration[] = useMemo(() => {
		if (!integrationsData || integrationsData.length === 0) {
			return [];
		}
		// Filter out MCP and AI_GATEWAY as they're managed separately
		return integrationsData
			.filter(
				(i: any) => i.provider !== "MCP" && i.provider !== "AI_GATEWAY",
			)
			.map((integration: any) => ({
				id: integration.id,
				provider: integration.provider,
				name:
					integration.name ||
					INTEGRATION_PROVIDERS[integration.provider]?.name ||
					integration.provider,
				isActive: integration.isActive,
				hasCredentials: integration.hasCredentials,
			}));
	}, [integrationsData]);

	// Filter and sort agents based on search (enabled first)
	const filteredAgents = useMemo(() => {
		let agents = allAgents;
		if (agentSearch.trim()) {
			const query = agentSearch.toLowerCase();
			agents = agents.filter(
				(agent) =>
					(agent.displayName || agent.name)
						.toLowerCase()
						.includes(query) ||
					agent.description?.toLowerCase().includes(query),
			);
		}
		// Sort by enabled status (enabled first)
		return [...agents].sort((a, b) => {
			const aEnabled = enabledAgentIds.includes(a.id);
			const bEnabled = enabledAgentIds.includes(b.id);
			if (aEnabled && !bEnabled) {
				return -1;
			}
			if (!aEnabled && bEnabled) {
				return 1;
			}
			return 0;
		});
	}, [allAgents, agentSearch, enabledAgentIds]);

	// Filter and sort MCP configs based on search (enabled first)
	// Only show MCP configs that are enabled in MCP settings (can actually be used)
	const filteredMcpConfigs = useMemo(() => {
		// First filter to only enabled configs (enabled in MCP settings)
		let configs = mcpConfigs.filter((config) => config.enabled);
		if (mcpSearch.trim()) {
			const query = mcpSearch.toLowerCase();
			configs = configs.filter(
				(config) =>
					config.displayName.toLowerCase().includes(query) ||
					config.description?.toLowerCase().includes(query),
			);
		}
		// Sort by enabled status in orchestrator preferences (enabled first)
		return [...configs].sort((a, b) => {
			const aEnabled = enabledMcpConfigIds.includes(a.id);
			const bEnabled = enabledMcpConfigIds.includes(b.id);
			if (aEnabled && !bEnabled) {
				return -1;
			}
			if (!aEnabled && bEnabled) {
				return 1;
			}
			return 0;
		});
	}, [mcpConfigs, mcpSearch, enabledMcpConfigIds]);

	// Filter and sort Fabric tools based on search (enabled first)
	const filteredFabricTools = useMemo(() => {
		let tools = FABRIC_AI_TOOLS;
		if (fabricSearch.trim()) {
			const query = fabricSearch.toLowerCase();
			tools = tools.filter(
				(tool) =>
					tool.name.toLowerCase().includes(query) ||
					tool.description.toLowerCase().includes(query) ||
					tool.category.toLowerCase().includes(query),
			);
		}
		// Sort by enabled status (enabled first)
		return [...tools].sort((a, b) => {
			const aEnabled = enabledFabricToolIds.includes(a.id);
			const bEnabled = enabledFabricToolIds.includes(b.id);
			if (aEnabled && !bEnabled) {
				return -1;
			}
			if (!aEnabled && bEnabled) {
				return 1;
			}
			return 0;
		});
	}, [fabricSearch, enabledFabricToolIds]);

	// Group Fabric tools by category for display
	const fabricToolsByCategory = useMemo(() => {
		const groups: Record<string, typeof FABRIC_AI_TOOLS> = {};
		for (const tool of filteredFabricTools) {
			if (!groups[tool.category]) {
				groups[tool.category] = [];
			}
			groups[tool.category].push(tool);
		}
		return groups;
	}, [filteredFabricTools]);

	// Filter and sort integrations based on search (enabled first)
	// Only show integrations that are active and have credentials (can actually be used)
	const filteredIntegrations = useMemo(() => {
		// First filter to only active integrations with credentials
		let items = integrations.filter((i) => i.isActive && i.hasCredentials);
		if (integrationSearch.trim()) {
			const query = integrationSearch.toLowerCase();
			items = items.filter(
				(integration) =>
					integration.name.toLowerCase().includes(query) ||
					integration.provider.toLowerCase().includes(query) ||
					INTEGRATION_PROVIDERS[integration.provider]?.description
						?.toLowerCase()
						.includes(query),
			);
		}
		// Sort by enabled status in orchestrator preferences (enabled first)
		return [...items].sort((a, b) => {
			const aEnabled = enabledIntegrationIds.includes(a.id);
			const bEnabled = enabledIntegrationIds.includes(b.id);
			if (aEnabled && !bEnabled) {
				return -1;
			}
			if (!aEnabled && bEnabled) {
				return 1;
			}
			return 0;
		});
	}, [integrations, integrationSearch, enabledIntegrationIds]);

	// Count enabled (only count items visible in current context AND actually usable)
	const enabledAgentsCount = enabledAgentIds.length;
	// Filter enabled MCP count to only include configs that are enabled in MCP settings AND in orchestrator preferences
	const enabledMcpCount = mcpConfigs.filter(
		(c) => c.enabled && enabledMcpConfigIds.includes(c.id),
	).length;
	const enabledFabricCount = enabledFabricToolIds.length;
	// Filter enabled integrations count to only include integrations that are active with credentials AND in orchestrator preferences
	const enabledIntegrationsCount = integrations.filter(
		(i) =>
			i.isActive &&
			i.hasCredentials &&
			enabledIntegrationIds.includes(i.id),
	).length;
	const totalAgents = allAgents.length;
	// Only count MCP configs that are enabled in MCP settings (can actually be used)
	const totalMcp = mcpConfigs.filter((c) => c.enabled).length;
	const totalFabric = FABRIC_AI_TOOLS.length;
	// Only count integrations that are active with credentials (can actually be used)
	const totalIntegrations = integrations.filter(
		(i) => i.isActive && i.hasCredentials,
	).length;

	// Get names of enabled MCP servers for display (only enabled in both MCP settings AND orchestrator)
	const enabledMcpNames = useMemo(() => {
		return mcpConfigs
			.filter((c) => c.enabled && enabledMcpConfigIds.includes(c.id))
			.map((c) => c.displayName)
			.slice(0, 3); // Show first 3
	}, [mcpConfigs, enabledMcpConfigIds]);

	// Get names of enabled integrations for display (only active with credentials AND in orchestrator preferences)
	const enabledIntegrationNames = useMemo(() => {
		return integrations
			.filter(
				(i) =>
					i.isActive &&
					i.hasCredentials &&
					enabledIntegrationIds.includes(i.id),
			)
			.map((i) => i.name)
			.slice(0, 3); // Show first 3
	}, [integrations, enabledIntegrationIds]);

	const enabledAgentNames = useMemo(() => {
		return allAgents
			.filter((agent) => enabledAgentIds.includes(agent.id))
			.map((agent) => agent.displayName || agent.name)
			.slice(0, 3);
	}, [allAgents, enabledAgentIds]);

	const enabledFabricNames = useMemo(() => {
		return FABRIC_AI_TOOLS.filter((tool) =>
			enabledFabricToolIds.includes(tool.id),
		)
			.map((tool) => tool.name)
			.slice(0, 3);
	}, [enabledFabricToolIds]);

	const showAgentsSection = showAgents && sectionMode !== "tools";
	const showToolsSections = sectionMode !== "agents";

	return (
		<div className={cn("space-y-4", className)}>
			{/* Agents Section - only shown when showAgents is true */}
			{showAgentsSection && (
				<Collapsible
					open={agentsOpen}
					onOpenChange={setAgentsOpen}
					className="rounded-md border border-border/60 bg-card/30 p-2"
				>
					<CollapsibleTrigger className="flex w-full items-start justify-between rounded-md px-2 py-2 text-left hover:bg-background/35 transition-colors">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<FabricLogo className="h-4 w-4" size={16} />
								<span className="text-sm font-medium">
									Agents
								</span>
								<Badge
									variant="secondary"
									className="h-5 text-[10px]"
								>
									{hasMounted
										? `${enabledAgentsCount}/${totalAgents}`
										: "—"}
								</Badge>
							</div>
							<p className="mt-1 text-xs leading-5 text-muted-foreground">
								Choose which specialist agents Fabric can plan
								with and delegate to.
							</p>
							<p className="mt-2 text-[11px] leading-5 text-muted-foreground">
								{enabledAgentNames.length > 0
									? `Selected: ${enabledAgentNames.join(", ")}${enabledAgentsCount > 3 ? ` +${enabledAgentsCount - 3} more` : ""}`
									: "No agents selected yet."}
							</p>
						</div>
						<div className="ml-3 pt-1">
							<Badge
								variant="outline"
								className="rounded-full border-border/50 bg-background/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
							>
								{agentsOpen ? "Open" : "Closed"}
							</Badge>
							{agentsOpen ? (
								<ChevronDown className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronRight className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							)}
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						{/* Quick actions */}
						<div className="mb-3 flex gap-2 px-2">
							<button
								type="button"
								onClick={onEnableAllAgents}
								className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-primary transition-colors hover:bg-primary/15"
							>
								Enable All
							</button>
							<button
								type="button"
								onClick={onDisableAllAgents}
								className="rounded-full border border-border/55 bg-background/55 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
							>
								Disable All
							</button>
						</div>

						{/* Search */}
						<div className="relative px-2 mb-2">
							<Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
							<SearchInput
								placeholder="Search agents..."
								value={agentSearch}
								onChange={(e) => setAgentSearch(e.target.value)}
								className="h-7 pl-7 text-xs"
							/>
						</div>

						{isLoadingAgents ? (
							<div className="space-y-2 px-2">
								{[1, 2, 3].map((i) => (
									<Skeleton key={i} className="h-12 w-full" />
								))}
							</div>
						) : (
							<div className="space-y-1 px-2 pr-3">
								{filteredAgents.length === 0 && agentSearch ? (
									<p className="text-xs text-muted-foreground text-center py-4">
										No agents match "{agentSearch}"
									</p>
								) : (
									filteredAgents.map((agent) => {
										const isEnabled =
											enabledAgentIds.includes(agent.id);
										const isPrioritized =
											hasMounted &&
											prioritizedAgentIds.includes(
												agent.id,
											);
										return (
											<div
												key={agent.id}
												className={cn(
													"flex items-start justify-between rounded-md border p-2.5 transition-colors",
													isPrioritized
														? "border-primary/30 bg-primary/10"
														: "border-border/55 bg-background/45 hover:bg-background/65",
												)}
											>
												<div className="flex-1 min-w-0 mr-2">
													<div className="flex items-center gap-1.5">
														<PriorityStarButton
															isPrioritized={
																isPrioritized
															}
															onToggle={() =>
																onAgentPrioritize(
																	agent.id,
																	!isPrioritized,
																)
															}
															copy={
																isPrioritized
																	? t(
																			"removePriorityAgent",
																		)
																	: t(
																			"prioritizeAgent",
																		)
															}
															activeClassName="text-purple-500"
															idleClassName="text-muted-foreground/40 hover:text-purple-400"
														/>
														<span className="text-xs font-medium truncate">
															{agent.displayName ||
																agent.name}
														</span>
														{agent.scope !==
															"SYSTEM" && (
															<Badge
																variant="outline"
																className="text-[9px] h-4 px-1"
															>
																{agent.scope ===
																"ORGANIZATION"
																	? "Org"
																	: "Personal"}
															</Badge>
														)}
													</div>
													{agent.description && (
														<p className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5 ml-[18px]">
															{agent.description}
														</p>
													)}
												</div>
												<Switch
													checked={isEnabled}
													onCheckedChange={(
														checked,
													) =>
														onAgentToggle(
															agent.id,
															checked,
														)
													}
													className="scale-75"
												/>
											</div>
										);
									})
								)}
							</div>
						)}
					</CollapsibleContent>
				</Collapsible>
			)}

			{/* MCP Servers Section */}
			{showToolsSections && (
				<Collapsible
					open={mcpOpen}
					onOpenChange={setMcpOpen}
					className="rounded-md border border-border/60 bg-card/30 p-2"
				>
					<CollapsibleTrigger className="flex w-full items-start justify-between rounded-md px-2 py-2 text-left hover:bg-background/35 transition-colors">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<McpLogo size={16} />
								<span className="text-sm font-medium">
									MCP Servers
								</span>
								<Badge
									variant="secondary"
									className="text-[10px] h-5"
								>
									{hasMounted
										? `${enabledMcpCount}/${totalMcp}`
										: "—"}
								</Badge>
							</div>
							<p className="mt-1 text-xs leading-5 text-muted-foreground">
								These are the external systems and tool servers
								Fabric can call.
							</p>
							<p className="mt-2 text-[11px] leading-5 text-muted-foreground">
								{enabledMcpNames.length > 0
									? `Selected: ${enabledMcpNames.join(", ")}${enabledMcpCount > 3 ? ` +${enabledMcpCount - 3} more` : ""}`
									: "No MCP servers selected yet."}
							</p>
						</div>
						<div className="ml-3 pt-1">
							<Badge
								variant="outline"
								className="rounded-full border-border/50 bg-background/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
							>
								{mcpOpen ? "Open" : "Closed"}
							</Badge>
							{mcpOpen ? (
								<ChevronDown className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronRight className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							)}
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						{/* Quick actions */}
						<div className="mb-3 flex gap-2 px-2">
							<button
								type="button"
								onClick={onEnableAllMcp}
								className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-primary transition-colors hover:bg-primary/15"
							>
								Enable All
							</button>
							<button
								type="button"
								onClick={onDisableAllMcp}
								className="rounded-full border border-border/55 bg-background/55 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
							>
								Disable All
							</button>
						</div>

						{/* Search */}
						<div className="relative px-2 mb-2">
							<Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
							<SearchInput
								placeholder="Search MCP servers..."
								value={mcpSearch}
								onChange={(e) => setMcpSearch(e.target.value)}
								className="h-7 pl-7 text-xs"
							/>
						</div>

						{isLoadingMcp ? (
							<div className="space-y-2 px-2">
								{[1, 2].map((i) => (
									<Skeleton key={i} className="h-12 w-full" />
								))}
							</div>
						) : mcpConfigs.length === 0 ? (
							<div className="text-center py-4 px-2">
								<div className="flex justify-center mb-2 opacity-50">
									<McpLogo size={24} />
								</div>
								<p className="text-xs text-muted-foreground">
									No MCP servers connected
								</p>
							</div>
						) : (
							<div className="space-y-1 px-2 pr-3">
								{filteredMcpConfigs.length === 0 &&
								mcpSearch ? (
									<p className="text-xs text-muted-foreground text-center py-4">
										No servers match "{mcpSearch}"
									</p>
								) : (
									filteredMcpConfigs.map((config) => {
										const isEnabled =
											enabledMcpConfigIds.includes(
												config.id,
											);
										const isPrioritized =
											hasMounted &&
											prioritizedMcpConfigIds.includes(
												config.id,
											);
										return (
											<div
												key={config.id}
												className={cn(
													"flex items-center justify-between rounded-md border p-2.5 transition-colors",
													isPrioritized
														? "border-primary/30 bg-primary/10"
														: "border-border/55 bg-background/45 hover:bg-background/65",
												)}
											>
												<div className="flex items-center gap-1.5 flex-1 min-w-0 mr-2">
													<PriorityStarButton
														isPrioritized={
															isPrioritized
														}
														onToggle={() =>
															onMcpPrioritize(
																config.id,
																!isPrioritized,
															)
														}
														copy={
															isPrioritized
																? t(
																		"removePriorityServer",
																	)
																: t(
																		"prioritizeServer",
																	)
														}
														activeClassName="text-blue-500"
														idleClassName="text-muted-foreground/40 hover:text-blue-400"
													/>
													<McpLogo
														size={12}
														className="flex-shrink-0"
													/>
													{config.description ? (
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<span className="text-xs font-medium truncate cursor-help">
																	{
																		config.displayName
																	}
																</span>
															</TooltipTrigger>
															<TooltipContent
																side="top"
																className="max-w-[250px]"
															>
																{
																	config.description
																}
															</TooltipContent>
														</Tooltip>
													) : (
														<span className="text-xs font-medium truncate">
															{config.displayName}
														</span>
													)}
													{config.scope ===
														"ORGANIZATION" && (
														<Badge
															variant="outline"
															className="text-[9px] h-4 px-1 flex-shrink-0"
														>
															Org
														</Badge>
													)}
												</div>
												<Switch
													// The row's name is plain
													// text next to the switch,
													// so a screen reader
													// announced "switch, off"
													// with no way to tell which
													// server it belongs to.
													aria-label={`Enable ${config.displayName ?? "MCP server"} for this chat`}
													checked={isEnabled}
													onCheckedChange={(
														checked,
													) =>
														onMcpToggle(
															config.id,
															checked,
														)
													}
													className="scale-75 flex-shrink-0"
												/>
											</div>
										);
									})
								)}
							</div>
						)}
					</CollapsibleContent>
				</Collapsible>
			)}

			{/* Fabric AI Tools Section */}
			{showToolsSections && (
				<Collapsible
					open={fabricOpen}
					onOpenChange={setFabricOpen}
					className="rounded-md border border-border/60 bg-card/30 p-2"
				>
					<CollapsibleTrigger className="flex w-full items-start justify-between rounded-md px-2 py-2 text-left hover:bg-background/35 transition-colors">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<FabricLogo size={16} />
								<span className="text-sm font-medium">
									Fabric AI Tools
								</span>
								<Badge
									variant="secondary"
									className="text-[10px] h-5 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
								>
									{hasMounted
										? `${enabledFabricCount}/${totalFabric}`
										: "—"}
								</Badge>
							</div>
							<p className="mt-1 text-xs leading-5 text-muted-foreground">
								These are Fabric-native capabilities for web
								research, pattern execution, and workspace
								retrieval.
							</p>
							<p className="mt-2 text-[11px] leading-5 text-muted-foreground">
								{enabledFabricNames.length > 0
									? `Selected: ${enabledFabricNames.join(", ")}${enabledFabricCount > 3 ? ` +${enabledFabricCount - 3} more` : ""}`
									: "No Fabric tools selected yet."}
							</p>
						</div>
						<div className="ml-3 pt-1">
							<Badge
								variant="outline"
								className="rounded-full border-border/50 bg-background/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
							>
								{fabricOpen ? "Open" : "Closed"}
							</Badge>
							{fabricOpen ? (
								<ChevronDown className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronRight className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							)}
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						{/* Quick actions */}
						<div className="mb-3 flex gap-2 px-2">
							<button
								type="button"
								onClick={onEnableAllFabricTools}
								className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-primary transition-colors hover:bg-primary/15"
							>
								Enable All
							</button>
							<button
								type="button"
								onClick={onDisableAllFabricTools}
								className="rounded-full border border-border/55 bg-background/55 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
							>
								Disable All
							</button>
						</div>

						{/* Search */}
						<div className="relative px-2 mb-2">
							<Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
							<SearchInput
								placeholder="Search Fabric tools..."
								value={fabricSearch}
								onChange={(e) =>
									setFabricSearch(e.target.value)
								}
								className="pl-8 h-7 text-xs"
							/>
						</div>

						{/* Tool list grouped by category */}
						<div className="space-y-3 px-2">
							{Object.entries(fabricToolsByCategory).map(
								([category, tools]) => (
									<div key={category}>
										<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 px-1">
											{category}
										</div>
										<div className="space-y-1">
											{tools.map((tool) => {
												const isEnabled =
													enabledFabricToolIds.includes(
														tool.id,
													);
												const isPrioritized =
													hasMounted &&
													prioritizedToolIds.includes(
														tool.id,
													);
												return (
													<div
														key={tool.id}
														className={cn(
															"flex items-center justify-between rounded-md border p-2.5 transition-colors",
															isPrioritized
																? "border-primary/30 bg-primary/10"
																: isEnabled
																	? "border-border/55 bg-background/55"
																	: "border-border/40 bg-background/30 hover:bg-background/55",
														)}
													>
														<div className="flex items-center gap-1.5 flex-1 min-w-0 mr-2">
															<PriorityStarButton
																isPrioritized={
																	isPrioritized
																}
																onToggle={() =>
																	onToolPrioritize(
																		tool.id,
																		!isPrioritized,
																	)
																}
																copy={
																	isPrioritized
																		? t(
																				"removePriorityTool",
																			)
																		: t(
																				"prioritizeTool",
																			)
																}
																activeClassName="text-orange-500"
																idleClassName="text-muted-foreground/40 hover:text-orange-400"
															/>
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<p className="text-xs font-medium truncate cursor-help">
																		{
																			tool.name
																		}
																	</p>
																</TooltipTrigger>
																<TooltipContent
																	side="top"
																	className="max-w-[250px]"
																>
																	{
																		tool.description
																	}
																</TooltipContent>
															</Tooltip>
														</div>
														<Switch
															checked={isEnabled}
															onCheckedChange={(
																checked,
															) =>
																onFabricToolToggle(
																	tool.id,
																	checked,
																)
															}
															className="scale-75 flex-shrink-0"
														/>
													</div>
												);
											})}
										</div>
									</div>
								),
							)}
							{filteredFabricTools.length === 0 && (
								<div className="text-center py-4 text-xs text-muted-foreground">
									No Fabric tools found
								</div>
							)}
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}

			{/* Workflow Integrations Section */}
			{showToolsSections && (
				<Collapsible
					open={integrationsOpen}
					onOpenChange={setIntegrationsOpen}
					className="rounded-md border border-border/60 bg-card/30 p-2"
				>
					<CollapsibleTrigger className="flex w-full items-start justify-between rounded-md px-2 py-2 text-left hover:bg-background/35 transition-colors">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<Plug2 className="h-4 w-4 text-emerald-600" />
								<span className="text-sm font-medium">
									Integrations
								</span>
								<Badge
									variant="secondary"
									className="text-[10px] h-5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
								>
									{hasMounted
										? `${enabledIntegrationsCount}/${totalIntegrations}`
										: "—"}
								</Badge>
							</div>
							<p className="mt-1 text-xs leading-5 text-muted-foreground">
								Enable app connections Fabric can use inside
								orchestrated workflows.
							</p>
							<p className="mt-2 text-[11px] leading-5 text-muted-foreground">
								{enabledIntegrationNames.length > 0
									? `Selected: ${enabledIntegrationNames.join(", ")}${enabledIntegrationsCount > 3 ? ` +${enabledIntegrationsCount - 3} more` : ""}`
									: "No integrations selected yet."}
							</p>
						</div>
						<div className="ml-3 pt-1">
							<Badge
								variant="outline"
								className="rounded-full border-border/50 bg-background/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
							>
								{integrationsOpen ? "Open" : "Closed"}
							</Badge>
							{integrationsOpen ? (
								<ChevronDown className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronRight className="mx-auto mt-2 h-4 w-4 text-muted-foreground" />
							)}
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						{/* Quick actions */}
						<div className="mb-3 flex gap-2 px-2">
							<button
								type="button"
								onClick={() =>
									onEnableAllIntegrations(
										integrations.map((i) => i.id),
									)
								}
								className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-primary transition-colors hover:bg-primary/15"
							>
								Enable All
							</button>
							<button
								type="button"
								onClick={onDisableAllIntegrations}
								className="rounded-full border border-border/55 bg-background/55 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
							>
								Disable All
							</button>
						</div>

						{/* Search */}
						<div className="relative px-2 mb-2">
							<Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
							<SearchInput
								placeholder="Search integrations..."
								value={integrationSearch}
								onChange={(e) =>
									setIntegrationSearch(e.target.value)
								}
								className="h-7 pl-7 text-xs"
							/>
						</div>

						{isLoadingIntegrations ? (
							<div className="space-y-2 px-2">
								{[1, 2].map((i) => (
									<Skeleton key={i} className="h-12 w-full" />
								))}
							</div>
						) : integrations.length === 0 ? (
							<div className="text-center py-4 px-2">
								<div className="flex justify-center mb-2 opacity-50">
									<Plug2 className="h-6 w-6" />
								</div>
								<p className="text-xs text-muted-foreground">
									No integrations configured
								</p>
							</div>
						) : (
							<div className="space-y-1 px-2 pr-3">
								{filteredIntegrations.length === 0 &&
								integrationSearch ? (
									<p className="text-xs text-muted-foreground text-center py-4">
										No integrations match "
										{integrationSearch}"
									</p>
								) : (
									filteredIntegrations.map((integration) => {
										const isEnabled =
											enabledIntegrationIds.includes(
												integration.id,
											);
										const isPrioritized =
											hasMounted &&
											prioritizedIntegrationIds.includes(
												integration.id,
											);
										const providerInfo =
											INTEGRATION_PROVIDERS[
												integration.provider
											];
										return (
											<div
												key={integration.id}
												className={cn(
													"flex items-center justify-between rounded-md border p-2.5 transition-colors",
													isPrioritized
														? "border-primary/30 bg-primary/10"
														: "border-border/55 bg-background/45 hover:bg-background/65",
												)}
											>
												<div className="flex items-center gap-1.5 flex-1 min-w-0 mr-2">
													<PriorityStarButton
														isPrioritized={
															isPrioritized
														}
														onToggle={() =>
															onIntegrationPrioritize(
																integration.id,
																!isPrioritized,
															)
														}
														copy={
															isPrioritized
																? t(
																		"removePriorityIntegration",
																	)
																: t(
																		"prioritizeIntegration",
																	)
														}
														activeClassName="text-emerald-500"
														idleClassName="text-muted-foreground/40 hover:text-emerald-400"
													/>
													<div
														className={cn(
															"w-3 h-3 rounded-sm flex-shrink-0",
															providerInfo?.color ||
																"bg-gray-400",
														)}
													/>
													{providerInfo?.description ? (
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<span className="text-xs font-medium truncate cursor-help">
																	{
																		integration.name
																	}
																</span>
															</TooltipTrigger>
															<TooltipContent
																side="top"
																className="max-w-[250px]"
															>
																{
																	providerInfo.description
																}
															</TooltipContent>
														</Tooltip>
													) : (
														<span className="text-xs font-medium truncate">
															{integration.name}
														</span>
													)}
													{!integration.hasCredentials && (
														<Badge
															variant="outline"
															className="text-[9px] h-4 px-1 flex-shrink-0 text-amber-600"
														>
															No creds
														</Badge>
													)}
												</div>
												<Switch
													checked={isEnabled}
													onCheckedChange={(
														checked,
													) =>
														onIntegrationToggle(
															integration.id,
															checked,
														)
													}
													className="scale-75 flex-shrink-0"
													disabled={
														!integration.hasCredentials
													}
												/>
											</div>
										);
									})
								)}
							</div>
						)}
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

// =============================================================================
// Configuration Constants
// =============================================================================

const SYNC_DEBOUNCE_MS = 500;
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Hook to manage orchestrator config state with database persistence and localStorage caching
 *
 * Data flow:
 * 1. Load from localStorage immediately (for fast UX)
 * 2. Fetch from database to sync/verify (source of truth for security)
 * 3. When database has values, use them (overrides localStorage)
 * 4. On toggle: update localStorage immediately (UX), then sync to database (security)
 *
 * Error Handling:
 * - Failed database syncs show toast notifications
 * - Automatic retry with exponential backoff
 * - localStorage fallback for offline scenarios
 * - Conflicts resolved by database taking precedence
 */
export function useOrchestratorConfig(organizationId?: string) {
	const _queryClient = useQueryClient();
	const dbSyncInProgress = useRef(false);
	const retryCountRef = useRef(0);
	const lastSyncErrorRef = useRef<string | null>(null);

	// Initialize from localStorage or defaults
	const [enabledAgentIds, setEnabledAgentIds] = useState<string[]>(() => {
		const saved = getFromLocalStorage<string[]>(STORAGE_KEYS.AGENTS, []);
		if (saved.length > 0) {
			return saved;
		}
		// Default: all system agents enabled
		return SYSTEM_AGENTS.map((a) => a.id);
	});

	const [enabledMcpConfigIds, setEnabledMcpConfigIds] = useState<string[]>(
		() => getFromLocalStorage<string[]>(STORAGE_KEYS.MCP, []),
	);

	const [enabledWorkspaceIds, setEnabledWorkspaceIds] = useState<string[]>(
		() => getFromLocalStorage<string[]>(STORAGE_KEYS.WORKSPACES, []),
	);

	// Fabric AI tools - default to all enabled except YouTube and Frames.
	// Frames are off-by-default; users must opt in via the orchestrator tools panel.
	const [enabledFabricToolIds, setEnabledFabricToolIds] = useState<string[]>(
		() => {
			const FRAMES_OFF_MIGRATION_FLAG =
				"fabric-orchestrator-frames-off-migrated";
			const markMigrated = () => {
				if (typeof window !== "undefined") {
					window.localStorage?.setItem(
						FRAMES_OFF_MIGRATION_FLAG,
						"1",
					);
				}
			};
			const frameToolIds = new Set(
				FABRIC_AI_TOOLS.filter((t) => t.category === "Frames").map(
					(t) => t.id,
				),
			);
			const defaultIds = FABRIC_AI_TOOLS.filter(
				(t) => t.category !== "YouTube" && t.category !== "Frames",
			).map((t) => t.id);

			const saved = getFromLocalStorage<string[]>(
				STORAGE_KEYS.FABRIC_TOOLS,
				[],
			);
			if (saved.length === 0) {
				// Fresh user — already starts with the new default. Set the
				// migration flag so a subsequent opt-in to a Frame tool isn't
				// pruned away on the next load.
				markMigrated();
				return defaultIds;
			}

			// One-time migration: existing users had Frames in their saved set
			// because the prior default included them. Prune Frames and persist
			// so the next refresh doesn't re-hydrate them. The migration flag
			// prevents re-pruning if the user later opts in.
			const migrated =
				typeof window !== "undefined" &&
				window.localStorage?.getItem(FRAMES_OFF_MIGRATION_FLAG) === "1";
			let working = saved;
			if (!migrated) {
				working = saved.filter((id) => !frameToolIds.has(id));
				setToLocalStorage(STORAGE_KEYS.FABRIC_TOOLS, working);
				markMigrated();
			}

			// Auto-enable newly added non-Frame tools that weren't in the saved set.
			const workingSet = new Set(working);
			const newToolIds = defaultIds.filter((id) => !workingSet.has(id));
			if (newToolIds.length > 0) {
				const merged = [...working, ...newToolIds];
				setToLocalStorage(STORAGE_KEYS.FABRIC_TOOLS, merged);
				return merged;
			}
			return working;
		},
	);

	// Workflow integrations - default to all with credentials enabled
	const [enabledIntegrationIds, setEnabledIntegrationIds] = useState<
		string[]
	>(() => getFromLocalStorage<string[]>(STORAGE_KEYS.INTEGRATIONS, []));

	// Prioritization state - tools/agents/MCP servers/integrations that get boosted confidence
	const [prioritizedToolIds, setPrioritizedToolIds] = useState<string[]>(() =>
		getFromLocalStorage<string[]>(STORAGE_KEYS.PRIORITIZED_TOOLS, []),
	);
	const [prioritizedAgentIds, setPrioritizedAgentIds] = useState<string[]>(
		() =>
			getFromLocalStorage<string[]>(STORAGE_KEYS.PRIORITIZED_AGENTS, []),
	);
	const [prioritizedMcpConfigIds, setPrioritizedMcpConfigIds] = useState<
		string[]
	>(() => getFromLocalStorage<string[]>(STORAGE_KEYS.PRIORITIZED_MCP, []));
	const [prioritizedIntegrationIds, setPrioritizedIntegrationIds] = useState<
		string[]
	>(() =>
		getFromLocalStorage<string[]>(
			STORAGE_KEYS.PRIORITIZED_INTEGRATIONS,
			[],
		),
	);

	const [initialized, setInitialized] = useState(false);

	// Track sync status for UI feedback
	const [syncStatus, setSyncStatus] = useState<
		"idle" | "syncing" | "error" | "success"
	>("idle");

	// Track if we loaded from localStorage (separate for agents, MCP, and workspaces)
	const [loadedAgentsFromStorage] = useState(() =>
		hasLocalStorageKey(STORAGE_KEYS.AGENTS),
	);
	const [loadedMcpFromStorage] = useState(() =>
		hasLocalStorageKey(STORAGE_KEYS.MCP),
	);
	const [loadedWorkspacesFromStorage] = useState(() =>
		hasLocalStorageKey(STORAGE_KEYS.WORKSPACES),
	);

	// ==========================================================================
	// DATABASE SYNC: Fetch preferences from database (source of truth)
	// ==========================================================================
	const { data: dbPreferences, error: dbFetchError } = useQuery({
		// org in the key: preferences are per (user × org), so a workspace
		// switch must not serve the previous org's settings (must match the
		// FabricAIClient key exactly so the two observers still share a cache
		// entry within an org).
		queryKey: ["orchestrator-preferences", organizationId ?? null],
		queryFn: async () => {
			return await orpcClient.users.orchestratorPreferences.get();
		},
		staleTime: 30000, // Cache for 30 seconds
		retry: 2, // Retry failed fetches
	});

	// Show warning if initial fetch fails but we have localStorage data
	useEffect(() => {
		if (
			dbFetchError &&
			(loadedAgentsFromStorage ||
				loadedMcpFromStorage ||
				loadedWorkspacesFromStorage)
		) {
			toast.warning("Using cached settings", {
				description:
					"Could not connect to server. Your settings are loaded from cache.",
				duration: 4000,
			});
		}
	}, [
		dbFetchError,
		loadedAgentsFromStorage,
		loadedMcpFromStorage,
		loadedWorkspacesFromStorage,
	]);

	// Mutation to sync preferences to database with retry logic
	const syncToDb = useMutation({
		mutationFn: async (prefs: {
			enabledMcpConfigIds?: string[];
			enabledAgentIds?: string[];
			enabledWorkspaceIds?: string[];
		}) => {
			setSyncStatus("syncing");

			// Use retry logic for resilience
			return await executeWithRetry(
				async () => {
					const result =
						await orpcClient.users.orchestratorPreferences.update(
							prefs,
						);
					return result;
				},
				{
					maxRetries: MAX_RETRY_ATTEMPTS,
					baseDelayMs: 1000,
					onRetry: (attempt, error) => {
						console.warn(
							`[OrchestratorConfig] Sync retry ${attempt}/${MAX_RETRY_ATTEMPTS}:`,
							error.message,
						);
						retryCountRef.current = attempt;
					},
				},
			);
		},
		onSuccess: () => {
			setSyncStatus("success");
			retryCountRef.current = 0;
			lastSyncErrorRef.current = null;
			showSyncSuccess();
			// Don't invalidate the query - this causes an infinite loop
			// The local state is already the source of truth after user changes
		},
		onError: (error) => {
			setSyncStatus("error");
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			lastSyncErrorRef.current = errorMessage;

			// Show user-friendly error notification
			showSyncError(
				"Failed to save settings",
				"Your changes are saved locally and will sync when connection is restored.",
			);

			console.error(
				"[OrchestratorConfig] Database sync failed after retries:",
				error,
			);
		},
	});

	// Sync to database when values change (debounced)
	const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const pendingPrefsRef = useRef<{
		enabledMcpConfigIds?: string[];
		enabledAgentIds?: string[];
		enabledWorkspaceIds?: string[];
	}>({});

	const syncToDatabase = useCallback(
		(prefs: {
			enabledMcpConfigIds?: string[];
			enabledAgentIds?: string[];
			enabledWorkspaceIds?: string[];
		}) => {
			// Merge with any pending prefs to batch changes
			pendingPrefsRef.current = { ...pendingPrefsRef.current, ...prefs };

			// Cancel any pending sync
			if (syncTimeoutRef.current) {
				clearTimeout(syncTimeoutRef.current);
			}

			// Debounce database sync to batch rapid changes
			syncTimeoutRef.current = setTimeout(() => {
				const prefsToSync = { ...pendingPrefsRef.current };
				pendingPrefsRef.current = {};
				syncToDb.mutate(prefsToSync);
			}, SYNC_DEBOUNCE_MS);
		},
		[syncToDb],
	);

	// Manual retry function for error recovery
	const retrySyncNow = useCallback(() => {
		if (syncTimeoutRef.current) {
			clearTimeout(syncTimeoutRef.current);
		}
		// Sync all current state
		syncToDb.mutate({
			enabledAgentIds,
			enabledMcpConfigIds,
			enabledWorkspaceIds,
		});
	}, [syncToDb, enabledAgentIds, enabledMcpConfigIds, enabledWorkspaceIds]);

	// Track if we've already applied DB preferences to prevent re-applying
	const dbPreferencesApplied = useRef(false);

	// Apply database preferences when they load (database is source of truth)
	// Only apply ONCE on initial load to prevent infinite loops
	useEffect(() => {
		if (
			dbPreferences?.exists &&
			!dbSyncInProgress.current &&
			!dbPreferencesApplied.current
		) {
			dbSyncInProgress.current = true;
			dbPreferencesApplied.current = true; // Mark as applied

			// Database has preferences - use them (overrides localStorage)
			const hasAnyPreferences =
				dbPreferences.enabledMcpConfigIds.length > 0 ||
				dbPreferences.enabledAgentIds.length > 0 ||
				dbPreferences.enabledWorkspaceIds.length > 0;

			if (hasAnyPreferences) {
				// Separate MCP config IDs from OAuth integration IDs
				// Use "oauth:" prefix to catch all OAuth ID formats (not just "oauth:integration:")
				const allMcpConfigIds = dbPreferences.enabledMcpConfigIds;
				const mcpOnlyIds = allMcpConfigIds.filter(
					(id: string) => !id.startsWith("oauth:"),
				);
				const integrationIds = allMcpConfigIds
					.filter((id: string) => id.startsWith("oauth:integration:"))
					.map((id: string) => id.replace("oauth:integration:", ""));

				setEnabledMcpConfigIds(mcpOnlyIds);
				setEnabledIntegrationIds(integrationIds);
				setEnabledAgentIds(dbPreferences.enabledAgentIds);
				setEnabledWorkspaceIds(dbPreferences.enabledWorkspaceIds);

				// Update localStorage to match database
				setToLocalStorage(STORAGE_KEYS.MCP, mcpOnlyIds);
				setToLocalStorage(STORAGE_KEYS.INTEGRATIONS, integrationIds);
				setToLocalStorage(
					STORAGE_KEYS.AGENTS,
					dbPreferences.enabledAgentIds,
				);
				setToLocalStorage(
					STORAGE_KEYS.WORKSPACES,
					dbPreferences.enabledWorkspaceIds,
				);
			}
			// Keep the flag true for longer to prevent sync effects from triggering
			// Use requestAnimationFrame to ensure React has processed state updates
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					dbSyncInProgress.current = false;
				});
			});
		}
	}, [dbPreferences]);

	// Track previous values to detect actual user changes (not initialization)
	const prevAgentIds = useRef<string[] | null>(null);
	const _prevMcpIds = useRef<string[] | null>(null);
	const prevWorkspaceIds = useRef<string[] | null>(null);

	// Save to localStorage when enabled IDs change and sync to database
	// Only sync when user actually makes changes, not on initialization
	useEffect(() => {
		if (typeof window === "undefined" || !initialized) {
			return;
		}
		if (dbSyncInProgress.current) {
			return;
		}

		// Skip if this is the first render (initialization)
		if (prevAgentIds.current === null) {
			prevAgentIds.current = enabledAgentIds;
			return;
		}

		// Check if the value actually changed (not just a re-render)
		const hasChanged =
			JSON.stringify(prevAgentIds.current) !==
			JSON.stringify(enabledAgentIds);
		if (!hasChanged) {
			return;
		}

		prevAgentIds.current = enabledAgentIds;
		setToLocalStorage(STORAGE_KEYS.AGENTS, enabledAgentIds);
		syncToDatabase({ enabledAgentIds });
	}, [enabledAgentIds, initialized, syncToDatabase]);

	// NOTE: MCP config sync is handled in the integration sync effect below
	// to avoid redundant writes and ensure OAuth integrations are included

	useEffect(() => {
		if (typeof window === "undefined" || !initialized) {
			return;
		}
		if (dbSyncInProgress.current) {
			return;
		}

		if (prevWorkspaceIds.current === null) {
			prevWorkspaceIds.current = enabledWorkspaceIds;
			return;
		}

		const hasChanged =
			JSON.stringify(prevWorkspaceIds.current) !==
			JSON.stringify(enabledWorkspaceIds);
		if (!hasChanged) {
			return;
		}

		prevWorkspaceIds.current = enabledWorkspaceIds;
		setToLocalStorage(STORAGE_KEYS.WORKSPACES, enabledWorkspaceIds);
		syncToDatabase({ enabledWorkspaceIds });
	}, [enabledWorkspaceIds, initialized, syncToDatabase]);

	// Sync enabledIntegrationIds to database (merged into enabledMcpConfigIds)
	// OAuth integrations are stored alongside MCP configs in the same array
	const prevIntegrationIds = useRef<string[] | null>(null);
	const prevMcpIdsForIntegration = useRef<string[] | null>(null);
	useEffect(() => {
		if (typeof window === "undefined" || !initialized) {
			return;
		}
		if (dbSyncInProgress.current) {
			return;
		}

		if (prevIntegrationIds.current === null) {
			prevIntegrationIds.current = enabledIntegrationIds;
			prevMcpIdsForIntegration.current = enabledMcpConfigIds;
			return;
		}

		const integrationChanged =
			JSON.stringify(prevIntegrationIds.current) !==
			JSON.stringify(enabledIntegrationIds);
		const mcpChanged =
			JSON.stringify(prevMcpIdsForIntegration.current) !==
			JSON.stringify(enabledMcpConfigIds);

		// Only sync if integration IDs changed OR if MCP IDs changed (for merging)
		if (!integrationChanged && !mcpChanged) {
			return;
		}

		prevIntegrationIds.current = enabledIntegrationIds;
		prevMcpIdsForIntegration.current = enabledMcpConfigIds;

		// Update localStorage for both if they changed
		if (integrationChanged) {
			setToLocalStorage(STORAGE_KEYS.INTEGRATIONS, enabledIntegrationIds);
		}
		if (mcpChanged) {
			setToLocalStorage(STORAGE_KEYS.MCP, enabledMcpConfigIds);
		}

		// Merge integration IDs with MCP config IDs for database storage
		// Use a special prefix to distinguish them when loading back
		const prefixedIntegrationIds = enabledIntegrationIds.map(
			(id) => `oauth:integration:${id}`,
		);
		const mcpOnlyIds = enabledMcpConfigIds.filter(
			(id) => !id.startsWith("oauth:"),
		);
		const mergedIds = [...mcpOnlyIds, ...prefixedIntegrationIds];

		syncToDatabase({ enabledMcpConfigIds: mergedIds });
	}, [
		enabledIntegrationIds,
		enabledMcpConfigIds,
		initialized,
		syncToDatabase,
	]);

	// Fetch MCP configs to initialize enabled state
	// SECURITY: Strict isolation between personal and organizational data
	const { data: mcpConfigsData = [] } = useQuery({
		queryKey: ["mcp-configs", { organizationId }],
		queryFn: async () => {
			if (organizationId) {
				// Organization context: fetch only org configs
				return await orpcClient.mcp.configs.list({ organizationId });
			}
			// Personal context: fetch only user configs
			return await orpcClient.mcp.configs.list();
		},
	});

	// Fetch workflow integrations for filtering enabled IDs
	// SECURITY: Strict isolation between personal and organizational data
	// staleTime: 0 ensures fresh data — status may change via settings page
	const { data: integrationsData = [] } = useQuery({
		queryKey: [
			"workflow-integrations",
			{ organizationId: organizationId ?? null },
		],
		queryFn: async () => {
			const result = await orpcClient.workflows.integrations.list({
				organizationId: organizationId ?? null,
			});
			return result.integrations || [];
		},
		staleTime: 0,
	});

	// Fetch registered agents to add them to enabled list
	const { data: registeredAgentsData } = useQuery({
		queryKey: ["agents", "registry", "list", organizationId],
		queryFn: async () => {
			const result = await orpcClient.agents.registry.list({
				limit: 100,
				offset: 0,
				organizationId,
			});
			return result;
		},
	});

	// Initialize MCP configs - enable ALL by default in orchestrator mode
	// Skip if already loaded from localStorage or database
	useEffect(() => {
		// Don't initialize if database preferences exist
		if (dbPreferences?.exists) {
			setInitialized(true);
			return;
		}
		if (
			mcpConfigsData &&
			mcpConfigsData.length > 0 &&
			!initialized &&
			!loadedMcpFromStorage
		) {
			// Enable all MCP servers by default
			const allIds = mcpConfigsData.map((c: any) => c.id);
			setEnabledMcpConfigIds(allIds);
		}
		// Mark as initialized when MCP data is loaded (even if loaded from storage)
		if (mcpConfigsData && !initialized) {
			setInitialized(true);
		}
	}, [mcpConfigsData, initialized, loadedMcpFromStorage, dbPreferences]);

	// Add registered A2A agents to enabled list when they load
	// Skip adding new agents if loaded from localStorage or database (user already made choices)
	useEffect(() => {
		// Don't add agents if database preferences exist
		if (dbPreferences?.exists) {
			return;
		}
		if (registeredAgentsData?.agents && !loadedAgentsFromStorage) {
			const a2aAgentIds = registeredAgentsData.agents
				.filter(
					(a: any) => a.framework === "A2A" && a.status === "ACTIVE",
				)
				.map((a: any) => a.agentId);

			if (a2aAgentIds.length > 0) {
				setEnabledAgentIds((prev) => {
					const newIds = a2aAgentIds.filter(
						(id: string) => !prev.includes(id),
					);
					if (newIds.length === 0) {
						return prev;
					}
					return [...prev, ...newIds];
				});
			}
		}
	}, [registeredAgentsData, loadedAgentsFromStorage, dbPreferences]);

	const handleAgentToggle = (agentId: string, enabled: boolean) => {
		setEnabledAgentIds((prev) =>
			enabled ? [...prev, agentId] : prev.filter((id) => id !== agentId),
		);
	};

	const handleMcpToggle = (configId: string, enabled: boolean) => {
		setEnabledMcpConfigIds((prev) =>
			enabled
				? [...prev, configId]
				: prev.filter((id) => id !== configId),
		);
	};

	const handleWorkspaceToggle = (workspaceId: string, enabled: boolean) => {
		setEnabledWorkspaceIds((prev) =>
			enabled
				? [...prev, workspaceId]
				: prev.filter((id) => id !== workspaceId),
		);
	};

	const handleEnableAllAgents = () => {
		const allIds = [
			...SYSTEM_AGENTS.map((a) => a.id),
			...(registeredAgentsData?.agents
				?.filter((a: any) => a.framework === "A2A")
				.map((a: any) => a.agentId) || []),
		];
		setEnabledAgentIds(allIds);
	};

	const handleDisableAllAgents = () => {
		setEnabledAgentIds([]);
	};

	const handleEnableAllMcp = () => {
		const allIds = mcpConfigsData?.map((c: any) => c.id) || [];
		setEnabledMcpConfigIds(allIds);
	};

	const handleDisableAllMcp = () => {
		setEnabledMcpConfigIds([]);
	};

	const handleEnableAllWorkspaces = (workspaceIds: string[]) => {
		setEnabledWorkspaceIds(workspaceIds);
	};

	const handleDisableAllWorkspaces = () => {
		setEnabledWorkspaceIds([]);
	};

	const handleFabricToolToggle = (toolId: string, enabled: boolean) => {
		setEnabledFabricToolIds((prev) => {
			const newIds = enabled
				? [...prev, toolId]
				: prev.filter((id) => id !== toolId);
			setToLocalStorage(STORAGE_KEYS.FABRIC_TOOLS, newIds);
			return newIds;
		});
	};

	const handleEnableAllFabricTools = () => {
		const allIds = FABRIC_AI_TOOLS.map((t) => t.id);
		setEnabledFabricToolIds(allIds);
		setToLocalStorage(STORAGE_KEYS.FABRIC_TOOLS, allIds);
	};

	const handleDisableAllFabricTools = () => {
		setEnabledFabricToolIds([]);
		setToLocalStorage(STORAGE_KEYS.FABRIC_TOOLS, []);
	};

	const handleIntegrationToggle = (
		integrationId: string,
		enabled: boolean,
	) => {
		setEnabledIntegrationIds((prev) => {
			const newIds = enabled
				? [...prev, integrationId]
				: prev.filter((id) => id !== integrationId);
			setToLocalStorage(STORAGE_KEYS.INTEGRATIONS, newIds);
			return newIds;
		});
	};

	const handleEnableAllIntegrations = (integrationIds: string[]) => {
		setEnabledIntegrationIds(integrationIds);
		setToLocalStorage(STORAGE_KEYS.INTEGRATIONS, integrationIds);
	};

	const handleDisableAllIntegrations = () => {
		setEnabledIntegrationIds([]);
		setToLocalStorage(STORAGE_KEYS.INTEGRATIONS, []);
	};

	// Prioritization handlers
	const handleToolPrioritize = (toolId: string, prioritized: boolean) => {
		setPrioritizedToolIds((prev) => {
			const newIds = prioritized
				? [...prev, toolId]
				: prev.filter((id) => id !== toolId);
			setToLocalStorage(STORAGE_KEYS.PRIORITIZED_TOOLS, newIds);
			return newIds;
		});
	};

	const handleAgentPrioritize = (agentId: string, prioritized: boolean) => {
		setPrioritizedAgentIds((prev) => {
			const newIds = prioritized
				? [...prev, agentId]
				: prev.filter((id) => id !== agentId);
			setToLocalStorage(STORAGE_KEYS.PRIORITIZED_AGENTS, newIds);
			return newIds;
		});
	};

	const handleMcpPrioritize = (configId: string, prioritized: boolean) => {
		setPrioritizedMcpConfigIds((prev) => {
			const newIds = prioritized
				? [...prev, configId]
				: prev.filter((id) => id !== configId);
			setToLocalStorage(STORAGE_KEYS.PRIORITIZED_MCP, newIds);
			return newIds;
		});
	};

	const handleIntegrationPrioritize = (
		integrationId: string,
		prioritized: boolean,
	) => {
		setPrioritizedIntegrationIds((prev) => {
			const newIds = prioritized
				? [...prev, integrationId]
				: prev.filter((id) => id !== integrationId);
			setToLocalStorage(STORAGE_KEYS.PRIORITIZED_INTEGRATIONS, newIds);
			return newIds;
		});
	};

	const handleClearAllPrioritized = () => {
		setPrioritizedToolIds([]);
		setPrioritizedAgentIds([]);
		setPrioritizedMcpConfigIds([]);
		setPrioritizedIntegrationIds([]);
		setToLocalStorage(STORAGE_KEYS.PRIORITIZED_TOOLS, []);
		setToLocalStorage(STORAGE_KEYS.PRIORITIZED_AGENTS, []);
		setToLocalStorage(STORAGE_KEYS.PRIORITIZED_MCP, []);
		setToLocalStorage(STORAGE_KEYS.PRIORITIZED_INTEGRATIONS, []);
	};

	// SECURITY FIX: Filter enabled IDs to only include those that exist in the current tenant's data
	// AND are currently enabled (not disabled by user in MCP settings)
	// This prevents cross-tenant data leakage AND stale references to disabled configs
	const currentTenantMcpConfigIds = useMemo(() => {
		if (!mcpConfigsData || mcpConfigsData.length === 0) {
			return [];
		}
		// Only include configs that are enabled (not disabled in MCP settings)
		const validIds = new Set(
			mcpConfigsData.filter((c: any) => c.enabled).map((c: any) => c.id),
		);
		return enabledMcpConfigIds.filter((id) => validIds.has(id));
	}, [mcpConfigsData, enabledMcpConfigIds]);

	// Also filter prioritized MCP IDs to current tenant and enabled configs only
	const currentTenantPrioritizedMcpConfigIds = useMemo(() => {
		if (!mcpConfigsData || mcpConfigsData.length === 0) {
			return [];
		}
		const validIds = new Set(
			mcpConfigsData.filter((c: any) => c.enabled).map((c: any) => c.id),
		);
		return prioritizedMcpConfigIds.filter((id) => validIds.has(id));
	}, [mcpConfigsData, prioritizedMcpConfigIds]);

	// SECURITY FIX: Filter enabled integration IDs to only include those in the current tenant
	// AND are active with credentials (can actually be used)
	// This prevents cross-tenant data leakage AND stale references to inactive integrations
	const currentTenantIntegrationIds = useMemo(() => {
		if (!integrationsData || integrationsData.length === 0) {
			return [];
		}
		// Only include integrations that are active and have credentials
		const validIds = new Set(
			integrationsData
				.filter(
					(i: {
						id: string;
						isActive: boolean;
						hasCredentials: boolean;
					}) => i.isActive && i.hasCredentials,
				)
				.map((i: { id: string }) => i.id),
		);
		return enabledIntegrationIds.filter((id) => validIds.has(id));
	}, [integrationsData, enabledIntegrationIds]);

	// Also filter prioritized integration IDs to current tenant and active integrations only
	const currentTenantPrioritizedIntegrationIds = useMemo(() => {
		if (!integrationsData || integrationsData.length === 0) {
			return [];
		}
		const validIds = new Set(
			integrationsData
				.filter(
					(i: {
						id: string;
						isActive: boolean;
						hasCredentials: boolean;
					}) => i.isActive && i.hasCredentials,
				)
				.map((i: { id: string }) => i.id),
		);
		return prioritizedIntegrationIds.filter((id) => validIds.has(id));
	}, [integrationsData, prioritizedIntegrationIds]);

	return {
		enabledAgentIds,
		// Return filtered IDs that only include configs in the current tenant context
		enabledMcpConfigIds: currentTenantMcpConfigIds,
		enabledWorkspaceIds,
		enabledFabricToolIds,
		enabledIntegrationIds: currentTenantIntegrationIds,
		// Prioritization state
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds: currentTenantPrioritizedMcpConfigIds,
		prioritizedIntegrationIds: currentTenantPrioritizedIntegrationIds,
		// Toggle handlers
		handleAgentToggle,
		handleMcpToggle,
		handleWorkspaceToggle,
		handleFabricToolToggle,
		handleIntegrationToggle,
		handleEnableAllAgents,
		handleDisableAllAgents,
		handleEnableAllMcp,
		handleDisableAllMcp,
		handleEnableAllWorkspaces,
		handleDisableAllWorkspaces,
		handleEnableAllFabricTools,
		handleDisableAllFabricTools,
		handleEnableAllIntegrations,
		handleDisableAllIntegrations,
		// Prioritization handlers
		handleToolPrioritize,
		handleAgentPrioritize,
		handleMcpPrioritize,
		handleIntegrationPrioritize,
		handleClearAllPrioritized,
		// Expose sync status for UI feedback
		isSyncing: syncToDb.isPending,
		syncStatus,
		// Manual retry function for error recovery
		retrySyncNow,
	};
}
