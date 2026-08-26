"use client";

/**
 * ActiveContextIndicator
 *
 * Displays context pills (workspaces, MCP servers, agents) with hover cards
 * that show the detailed list of what's in each context.
 * Users can star items to prioritize them in routing.
 */

import { McpLogo } from "@saas/mcp/components/McpLogo";
import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ui/components/hover-card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { FolderKanban, FolderOpen, Info, Plug2, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

// System agents list (matching OrchestratorConfigPanel)
const SYSTEM_AGENTS: Record<string, string> = {
	project_document_generator: "Project Document Generator",
	document_generator: "Document Generator",
	task_planner: "Task Planner",
	story_breakdown: "Story Breakdown",
	code_executor: "Code Executor",
	prompt_enhancer: "Prompt Enhancer",
	api_agent: "API Agent",
	cuga_generalist: "CUGA Generalist Agent",
	mcp_tool_executor: "MCP Tool Executor",
};

// Fabric AI tools mapping
const FABRIC_AI_TOOLS: Record<string, { name: string; description: string }> = {
	fabric_pattern: {
		name: "Apply Pattern",
		description: "Apply Fabric patterns to text",
	},
	fabric_analyze_youtube: {
		name: "Analyze YouTube",
		description: "Extract and analyze videos",
	},
	fabric_youtube_transcript: {
		name: "YouTube Transcript",
		description: "Extract transcripts",
	},
	fabric_youtube_metadata: {
		name: "YouTube Metadata",
		description: "Get video metadata",
	},
	fabric_youtube_comments: {
		name: "YouTube Comments",
		description: "Retrieve comments",
	},
	fabric_youtube_playlist: {
		name: "YouTube Playlist",
		description: "Get playlist videos",
	},
	fabric_scrape_url: {
		name: "Scrape URL",
		description: "Extract web content",
	},
	fabric_readability: {
		name: "HTML Readability",
		description: "Extract readable content",
	},
	fabric_transcribe_audio: {
		name: "Transcribe Audio",
		description: "Convert audio to text",
	},
	fabric_list_patterns: {
		name: "List Patterns",
		description: "List available patterns",
	},
	fabric_list_models: { name: "List Models", description: "List AI models" },
	fabric_get_context: {
		name: "Get Context",
		description: "Retrieve context",
	},
	fabric_list_contexts: {
		name: "List Contexts",
		description: "List contexts",
	},
	fabric_get_strategy: {
		name: "Get Strategy",
		description: "Retrieve strategy",
	},
	fabric_list_strategies: {
		name: "List Strategies",
		description: "List strategies",
	},
	fabric_template_plugins: {
		name: "Template Plugins",
		description: "List plugins",
	},
	fabric_web_search: { name: "Web Search", description: "Search the web" },
	fabric_search_and_analyze: {
		name: "Search & Analyze",
		description: "Search and analyze results",
	},
	fabric_scrape_and_analyze: {
		name: "Scrape & Analyze",
		description: "Scrape and analyze web pages",
	},
	workspace_rag_query: {
		name: "Workspace Query",
		description: "Search workspace documents",
	},
	workspace_rag_summarize: {
		name: "Workspace Summarize",
		description: "Summarize workspace docs",
	},
	// MCP CLI tools for dynamic MCP server discovery
	fabric_mcp_list: {
		name: "MCP List Servers",
		description: "List MCP servers and tools",
	},
	fabric_mcp_grep: {
		name: "MCP Search Tools",
		description: "Search MCP tools by pattern",
	},
	fabric_mcp_schema: {
		name: "MCP Tool Schema",
		description: "Get MCP tool schema",
	},
	fabric_mcp_call: { name: "MCP Call Tool", description: "Execute MCP tool" },
	fabric_generate_image: {
		name: "Image Generation",
		description: "Generate and edit images",
	},
};

// Integration provider display info
const INTEGRATION_PROVIDERS: Record<
	string,
	{ name: string; description: string }
> = {
	SLACK: { name: "Slack", description: "Send messages and manage channels" },
	GITHUB: {
		name: "GitHub",
		description: "Manage repositories, issues, and PRs",
	},
	LINEAR: {
		name: "Linear",
		description: "Create and manage issues and projects",
	},
	RESEND: { name: "Resend", description: "Send transactional emails" },
	PERPLEXITY: { name: "Perplexity", description: "AI-powered web search" },
	FIRECRAWL: {
		name: "Firecrawl",
		description: "Web scraping and data extraction",
	},
	FAL: { name: "Fal.ai", description: "Run AI models and image generation" },
	CUSTOM_WEBHOOK: {
		name: "Custom Webhook",
		description: "Send data to custom endpoints",
	},
};

interface ActiveContextIndicatorProps {
	/** IDs of attached/enabled workspaces */
	workspaceIds?: string[];
	/** IDs of enabled MCP server configs */
	mcpConfigIds?: string[];
	/** IDs of enabled agents */
	agentIds?: string[];
	/** IDs of enabled Fabric AI tools */
	fabricToolIds?: string[];
	/** IDs of enabled workflow integrations */
	integrationIds?: string[];
	/** Attached project ID */
	projectId?: string | null;
	/** Callback when project pill is clicked */
	onProjectClick?: () => void;
	/** IDs of prioritized tools (Fabric AI) */
	prioritizedToolIds?: string[];
	/** IDs of prioritized agents */
	prioritizedAgentIds?: string[];
	/** IDs of prioritized MCP server configs */
	prioritizedMcpConfigIds?: string[];
	/** IDs of prioritized integrations */
	prioritizedIntegrationIds?: string[];
	/** Callback when tool priority changes */
	onToolPrioritize?: (toolId: string, prioritized: boolean) => void;
	/** Callback when agent priority changes */
	onAgentPrioritize?: (agentId: string, prioritized: boolean) => void;
	/** Callback when MCP server priority changes */
	onMcpPrioritize?: (configId: string, prioritized: boolean) => void;
	/** Callback when integration priority changes */
	onIntegrationPrioritize?: (
		integrationId: string,
		prioritized: boolean,
	) => void;
	/**
	 * Organization ID for filtering data.
	 * - `string`: Show data for this organization
	 * - `null`: Show personal data only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
	/** Custom class name */
	className?: string;
}

interface ContextPillProps {
	count: number;
	label: string;
	singularLabel: string;
	color: "green" | "blue" | "purple" | "orange" | "emerald";
	icon: React.ReactNode;
	items: Array<{ id: string; name: string; description?: string }>;
	isLoading?: boolean;
	/** IDs of prioritized items */
	prioritizedIds?: string[];
	/** Callback when priority changes */
	onPrioritize?: (id: string, prioritized: boolean) => void;
}

function ContextPill({
	count,
	label,
	singularLabel,
	color,
	icon,
	items,
	isLoading,
	prioritizedIds = [],
	onPrioritize,
}: ContextPillProps) {
	const t = useTranslations("tooltips.agents");
	const colorClasses = {
		green: {
			pill: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300",
			dot: "bg-green-500",
			header: "text-success dark:text-green-400",
			star: "text-success",
		},
		blue: {
			pill: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300",
			dot: "bg-blue-500",
			header: "text-blue-600 dark:text-blue-400",
			star: "text-blue-500",
		},
		purple: {
			pill: "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300",
			dot: "bg-purple-500",
			header: "text-purple-600 dark:text-purple-400",
			star: "text-purple-500",
		},
		orange: {
			pill: "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300",
			dot: "bg-orange-500",
			header: "text-highlight dark:text-orange-400",
			star: "text-orange-500",
		},
		emerald: {
			pill: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300",
			dot: "bg-emerald-500",
			header: "text-emerald-600 dark:text-emerald-400",
			star: "text-emerald-500",
		},
	};

	const colors = colorClasses[color];
	const prioritizedCount = items.filter((item) =>
		prioritizedIds.includes(item.id),
	).length;

	return (
		<HoverCard openDelay={200} closeDelay={100}>
			<HoverCardTrigger asChild>
				<span
					className={cn(
						"inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium cursor-default transition-colors hover:opacity-80",
						colors.pill,
					)}
				>
					<span
						className={cn("w-1.5 h-1.5 rounded-full", colors.dot)}
					/>
					{count} {count === 1 ? singularLabel : label}
					{prioritizedCount > 0 && (
						<Star
							className={cn(
								"h-2.5 w-2.5 fill-current",
								colors.star,
							)}
						/>
					)}
				</span>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="start"
				className="w-64 p-3"
				sideOffset={8}
			>
				<div className="space-y-2">
					{/* Header */}
					<div
						className={cn("flex items-center gap-2", colors.header)}
					>
						{icon}
						<span className="text-xs font-medium">
							{count} {count === 1 ? singularLabel : label}
						</span>
						{onPrioritize && (
							<span className="text-[10px] text-muted-foreground ml-auto">
								Click star to prioritize
							</span>
						)}
					</div>

					{/* List */}
					{isLoading ? (
						<div className="space-y-1.5">
							{[1, 2, 3].map((i) => (
								<div
									key={i}
									className="h-4 bg-muted rounded animate-pulse"
								/>
							))}
						</div>
					) : items.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No items in context
						</p>
					) : (
						<div className="space-y-1">
							{items.map((item) => {
								const isPrioritized = prioritizedIds.includes(
									item.id,
								);
								const priorityCopy = isPrioritized
									? t("removePriorityContextItem")
									: t("prioritizeContextItem");
								return (
									<div
										key={item.id}
										className={cn(
											"flex items-center gap-2 text-xs p-1 rounded transition-colors",
											isPrioritized && "bg-muted/50",
										)}
									>
										{onPrioritize ? (
											// Icon-only control, so it carries
											// both the tooltip and an
											// `aria-label` — the star is its
											// only content.
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={() =>
															onPrioritize(
																item.id,
																!isPrioritized,
															)
														}
														className={cn(
															"flex-shrink-0 transition-colors",
															isPrioritized
																? colors.star
																: "text-muted-foreground/40 hover:text-muted-foreground",
														)}
														aria-label={
															priorityCopy
														}
													>
														<Star
															className={cn(
																"h-3 w-3",
																isPrioritized &&
																	"fill-current",
															)}
														/>
													</button>
												</TooltipTrigger>
												<TooltipContent>
													{priorityCopy}
												</TooltipContent>
											</Tooltip>
										) : (
											<span
												className={cn(
													"w-1 h-1 rounded-full flex-shrink-0",
													colors.dot,
												)}
											/>
										)}
										<div className="min-w-0 flex-1">
											<span className="font-medium text-foreground truncate block">
												{item.name}
											</span>
											{item.description && (
												<span className="text-[10px] text-muted-foreground line-clamp-1">
													{item.description}
												</span>
											)}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

export function ActiveContextIndicator({
	workspaceIds = [],
	mcpConfigIds = [],
	agentIds = [],
	fabricToolIds = [],
	integrationIds = [],
	projectId,
	onProjectClick,
	prioritizedToolIds = [],
	prioritizedAgentIds = [],
	prioritizedMcpConfigIds = [],
	prioritizedIntegrationIds = [],
	onToolPrioritize,
	onAgentPrioritize,
	onMcpPrioritize,
	onIntegrationPrioritize,
	organizationId: propOrgId,
	className,
}: ActiveContextIndicatorProps) {
	const organizationId = useEffectiveOrganizationId(propOrgId);

	// Fetch workspace details
	const { data: workspacesData, isLoading: isLoadingWorkspaces } = useQuery({
		queryKey: ["context-workspaces", workspaceIds],
		queryFn: async () => {
			if (workspaceIds.length === 0) {
				return [];
			}
			// Fetch workspace details - the list endpoint returns all workspaces
			const result = await orpcClient.documentWorkspaces.list({
				organizationId,
				status: "ACTIVE",
			});
			// Filter to only the ones we need
			return (
				result.workspaces?.filter((w: any) =>
					workspaceIds.includes(w.id),
				) || []
			);
		},
		enabled: workspaceIds.length > 0,
		staleTime: 30000,
	});

	// Fetch MCP config details
	// SECURITY: Strict isolation between personal and organizational data
	const { data: mcpConfigsData, isLoading: isLoadingMcp } = useQuery({
		queryKey: ["context-mcp-configs", mcpConfigIds, organizationId],
		queryFn: async () => {
			if (mcpConfigIds.length === 0) {
				return [];
			}

			// Fetch configs for the current context only (never mix personal and org)
			const configs = organizationId
				? await orpcClient.mcp.configs.list({ organizationId })
				: await orpcClient.mcp.configs.list();

			// Filter to only enabled ones
			return configs.filter((c: any) => mcpConfigIds.includes(c.id));
		},
		enabled: mcpConfigIds.length > 0,
		staleTime: 30000,
	});

	// Transform workspace data for display
	const workspaceItems = useMemo(() => {
		if (!workspacesData) {
			return [];
		}
		return workspacesData.map((w: any) => ({
			id: w.id,
			name: w.name,
			description:
				w.documentCount !== undefined
					? `${w.documentCount} document${w.documentCount !== 1 ? "s" : ""}`
					: undefined,
		}));
	}, [workspacesData]);

	// Transform MCP config data for display
	const mcpItems = useMemo(() => {
		if (!mcpConfigsData) {
			return [];
		}
		return mcpConfigsData.map((c: any) => ({
			id: c.id,
			name:
				c.displayName ||
				c.mcpServer?.name ||
				c.mcpServerId ||
				"Unknown Server",
			description: c.mcpServer?.description || c.description,
		}));
	}, [mcpConfigsData]);

	// Transform agent IDs to items using the system agents map
	const agentItems = useMemo(() => {
		return agentIds.map((id) => ({
			id,
			name: SYSTEM_AGENTS[id] || id,
			description: undefined,
		}));
	}, [agentIds]);

	// Transform Fabric tool IDs to items
	const fabricToolItems = useMemo(() => {
		return fabricToolIds.map((id) => ({
			id,
			name: FABRIC_AI_TOOLS[id]?.name || id,
			description: FABRIC_AI_TOOLS[id]?.description,
		}));
	}, [fabricToolIds]);

	// Fetch integration details
	const { data: integrationsData, isLoading: isLoadingIntegrations } =
		useQuery({
			queryKey: ["context-integrations", integrationIds, organizationId],
			queryFn: async () => {
				if (integrationIds.length === 0) {
					return [];
				}
				const result = await orpcClient.workflows.integrations.list({
					organizationId,
				});
				// Filter to only enabled ones
				return (result.integrations || []).filter((i: any) =>
					integrationIds.includes(i.id),
				);
			},
			enabled: integrationIds.length > 0,
			staleTime: 30000,
		});

	// Transform integration data for display
	const integrationItems = useMemo(() => {
		if (!integrationsData) {
			return [];
		}
		return integrationsData.map((i: any) => ({
			id: i.id,
			name:
				i.name || INTEGRATION_PROVIDERS[i.provider]?.name || i.provider,
			description: INTEGRATION_PROVIDERS[i.provider]?.description,
		}));
	}, [integrationsData]);

	// Fetch project name when projectId is set
	const { data: projectData } = useQuery({
		queryKey: ["context-project", projectId],
		queryFn: async () => {
			if (!projectId) {
				return null;
			}
			const result = await orpcClient.projects.get({
				id: projectId,
				organizationId,
			});
			return result;
		},
		enabled: !!projectId,
		staleTime: 30000,
	});

	const projectName = projectData?.project?.name ?? "Project";

	// Don't render anything if no context
	const hasContext =
		workspaceIds.length > 0 ||
		mcpConfigIds.length > 0 ||
		agentIds.length > 0 ||
		fabricToolIds.length > 0 ||
		integrationIds.length > 0 ||
		!!projectId;

	if (!hasContext) {
		return null;
	}

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-1.5 sm:gap-2 min-w-0",
				className,
			)}
		>
			<div className="flex items-center gap-1 shrink-0">
				<span className="text-[10px] text-muted-foreground whitespace-nowrap">
					Active context:
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<Info className="h-3 w-3 text-muted-foreground/50 cursor-help" />
					</TooltipTrigger>
					<TooltipContent
						side="top"
						align="start"
						className="max-w-[380px] p-3"
					>
						<div className="space-y-3 text-xs">
							<p className="font-medium">How Fabric AI Works</p>
							<ul className="space-y-1.5 text-muted-foreground">
								<li className="flex gap-2">
									<span className="text-primary">•</span>
									<span>
										<strong>Hover</strong> on pills to see
										available tools, agents, and workspaces
									</span>
								</li>
								<li className="flex gap-2">
									<Star className="h-3 w-3 text-highlight flex-shrink-0 mt-0.5" />
									<span>
										<strong>Star items</strong> to
										prioritize them - starred tools/agents
										are used first
									</span>
								</li>
							</ul>

							<div className="border-t pt-2">
								<p className="font-medium mb-1.5">
									Teach Me Your Preferences
								</p>
								<p className="text-muted-foreground mb-2">
									Add &quot;remember&quot; phrases to any
									message:
								</p>
								<ul className="space-y-1 text-muted-foreground">
									<li className="flex gap-2">
										<span className="text-highlight">
											✦
										</span>
										<span>
											&quot;Remember to always show data
											in tables&quot;
										</span>
									</li>
									<li className="flex gap-2">
										<span className="text-highlight">
											✦
										</span>
										<span>
											&quot;I prefer detailed
											responses&quot;
										</span>
									</li>
									<li className="flex gap-2">
										<span className="text-highlight">
											✦
										</span>
										<span>
											&quot;From now on, use bullet
											points&quot;
										</span>
									</li>
									<li className="flex gap-2">
										<span className="text-highlight">
											✦
										</span>
										<span>
											&quot;Don&apos;t forget to include
											timestamps&quot;
										</span>
									</li>
								</ul>
							</div>
						</div>
					</TooltipContent>
				</Tooltip>
			</div>

			{workspaceIds.length > 0 && (
				<ContextPill
					count={workspaceIds.length}
					label="workspaces"
					singularLabel="workspace"
					color="green"
					icon={<FolderOpen className="h-3.5 w-3.5" />}
					items={workspaceItems}
					isLoading={isLoadingWorkspaces}
				/>
			)}

			{mcpConfigIds.length > 0 && (
				<ContextPill
					count={mcpConfigIds.length}
					label="MCP servers"
					singularLabel="MCP server"
					color="blue"
					icon={<McpLogo size={14} />}
					items={mcpItems}
					isLoading={isLoadingMcp}
					prioritizedIds={prioritizedMcpConfigIds}
					onPrioritize={onMcpPrioritize}
				/>
			)}

			{agentIds.length > 0 && (
				<ContextPill
					count={agentIds.length}
					label="agents"
					singularLabel="agent"
					color="purple"
					icon={<FabricLogo size={14} />}
					items={agentItems}
					isLoading={false}
					prioritizedIds={prioritizedAgentIds}
					onPrioritize={onAgentPrioritize}
				/>
			)}

			{fabricToolIds.length > 0 && (
				<ContextPill
					count={fabricToolIds.length}
					label="Fabric tools"
					singularLabel="Fabric tool"
					color="orange"
					icon={<FabricLogo size={14} />}
					items={fabricToolItems}
					isLoading={false}
					prioritizedIds={prioritizedToolIds}
					onPrioritize={onToolPrioritize}
				/>
			)}

			{integrationIds.length > 0 && (
				<ContextPill
					count={integrationIds.length}
					label="integrations"
					singularLabel="integration"
					color="emerald"
					icon={<Plug2 className="h-3.5 w-3.5" />}
					items={integrationItems}
					isLoading={isLoadingIntegrations}
					prioritizedIds={prioritizedIntegrationIds}
					onPrioritize={onIntegrationPrioritize}
				/>
			)}

			{projectId && (
				<button
					type="button"
					onClick={onProjectClick}
					className={cn(
						"inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium cursor-pointer transition-colors hover:opacity-80",
						"bg-primary/10 text-primary",
					)}
				>
					<FolderKanban className="h-2.5 w-2.5" />
					{projectName}
				</button>
			)}
		</div>
	);
}
