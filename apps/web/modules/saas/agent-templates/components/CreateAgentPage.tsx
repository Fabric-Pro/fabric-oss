"use client";

/**
 * Create Agent Page
 * Full page layout for creating an agent from a template
 * Two-column layout: Main content + Pro Tips sidebar
 */

import {
	getBuiltInCapability,
	getCapabilityIcon,
} from "@saas/agents/lib/builtin-capabilities";
import { AgentBuilderSidekick } from "@saas/agents/sidekick/AgentBuilderSidekick";
import { SidekickFormProvider } from "@saas/agents/sidekick/SidekickFormContext";
import { SidekickSuggestionsProvider } from "@saas/agents/sidekick/SidekickSuggestionsContext";
import { McpLogo } from "@saas/mcp/components/McpLogo";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Square3Stack3DIcon } from "@saas/shared/components/icons/Square3Stack3DIcon";
import { IntegrationBrandIcon } from "@saas/workflows/components/integrations/IntegrationBrandIcon";
import {
	getAllIntegrations,
	getIntegration,
	getIntegrationTypes,
	type IntegrationType,
} from "@saas/workflows/lib/plugins";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	BarChart3Icon,
	BookOpenIcon,
	BriefcaseIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	CodeIcon,
	CopyIcon,
	GlobeIcon,
	HeadphonesIcon,
	LightbulbIcon,
	Loader2Icon,
	MegaphoneIcon,
	PlusIcon,
	RocketIcon,
	ScaleIcon,
	ServerIcon,
	SettingsIcon,
	SparklesIcon,
	WalletIcon,
	XIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DataSourcesSheet } from "./DataSourcesSheet";
import { ToolsSheet } from "./ToolsSheet";
import { type TriggerConfig, TriggersSheet } from "./TriggersSheet";
import {
	type WorkspaceDocumentFilter,
	WorkspacesSheet,
} from "./WorkspacesSheet";

// Category to icon mapping
const categoryIcons: Record<
	string,
	{ icon: React.ElementType; gradient: string }
> = {
	DATA: { icon: BarChart3Icon, gradient: "from-blue-500 to-blue-600" },
	ENGINEERING: { icon: CodeIcon, gradient: "from-green-500 to-green-600" },
	SALES: { icon: BriefcaseIcon, gradient: "from-amber-500 to-amber-600" },
	SUPPORT: {
		icon: HeadphonesIcon,
		gradient: "from-purple-500 to-purple-600",
	},
	MARKETING: { icon: MegaphoneIcon, gradient: "from-pink-500 to-pink-600" },
	PRODUCT: { icon: RocketIcon, gradient: "from-cyan-500 to-cyan-600" },
	KNOWLEDGE: {
		icon: BookOpenIcon,
		gradient: "from-indigo-500 to-indigo-600",
	},
	PRODUCTIVITY: { icon: ZapIcon, gradient: "from-yellow-500 to-yellow-600" },
	FINANCE: { icon: WalletIcon, gradient: "from-emerald-500 to-emerald-600" },
	LEGAL: { icon: ScaleIcon, gradient: "from-slate-500 to-slate-600" },
	OPERATIONS: {
		icon: SettingsIcon,
		gradient: "from-orange-500 to-orange-600",
	},
	GENERAL: { icon: RobotIcon, gradient: "from-slate-500 to-slate-600" },
};

const getCategoryIcon = (category: string) => {
	return categoryIcons[category] || categoryIcons.GENERAL;
};

type AgentTemplate = {
	id: string;
	slug: string;
	name: string;
	displayName: string;
	description: string;
	heroEmojis: string[];
	category: string;
	instructions: string;
	suggestedModel?: string | null;
};

/** Starter message shown as a clickable chip in the chat welcome screen */
export interface StarterMessage {
	/** Short label for the chip (e.g. "Plan a feature") */
	label: string;
	/** Emoji icon for the chip (e.g. "📝") */
	emoji: string;
	/** Full prompt text sent when clicked */
	prompt: string;
}

export type AgentBuilderInitialValues = {
	name?: string;
	description?: string;
	instructions?: string;
	selectedDataSources?: string[];
	selectedTools?: string[];
	selectedSkillIds?: string[];
	triggers?: TriggerConfig[];
	executionMode?: "single_turn" | "goal_oriented";
	goal?: string;
	maxIterations?: number;
	isApiExposed?: boolean;
	starterMessages?: StarterMessage[];
	workspaceDocumentFilters?: WorkspaceDocumentFilter[];
	existingToolConnections?: Record<string, Record<string, unknown>>;
	existingSkillFiles?: Array<{
		path: string;
		sourceSkillId?: string | null;
	}>;
	/**
	 * Per-provider resource scoping for knowledge connections that need it
	 * (currently Databricks Vector Search), keyed by provider type.
	 */
	knowledgeResources?: Record<string, { schema: string; indexes: string[] }>;
	/**
	 * The WorkflowIntegration id this agent's Databricks Vector Search
	 * knowledge source is bound to. Pins index discovery to that exact
	 * connection on edit/duplicate so a tenant with multiple active
	 * Databricks connections can't have discovery silently resolve to a
	 * different one than what was persisted.
	 */
	databricksIntegrationId?: string;
};

type Props = {
	template: AgentTemplate;
	organizationId?: string;
	basePath?: string;
	isCustomAgent?: boolean;
	mode?: "create" | "edit";
	instanceId?: string;
	/** Stable identifier across versions — used for external API URLs */
	instanceSId?: string;
	initialValues?: AgentBuilderInitialValues;
};

/**
 * OAuth providers don't use WorkflowIntegration records - they use OAuthIntegration.
 * When a user selects these in the UI, we store them as { "NOTION": "oauth" }
 * to indicate the connection is OAuth-based.
 * IMPORTANT: Keep in sync with OAUTH_PROVIDERS in validate-connections.ts
 */
const OAUTH_PROVIDERS = [
	"GITHUB",
	"GOOGLE_DRIVE",
	"MICROSOFT_GRAPH",
	"SLACK",
	"NOTION",
] as const;

type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

function isOAuthProvider(type: string): type is OAuthProvider {
	return OAUTH_PROVIDERS.includes(type as OAuthProvider);
}

// Map tool/knowledgeSource names to integration types
// Includes both lowercase (for tools) and uppercase (for knowledgeSources from templates)
// Note: DATABASE is excluded as there's no plugin for it yet
const TOOL_TO_INTEGRATION_MAP: Record<string, IntegrationType> = {
	// Lowercase versions (tools)
	notion: "NOTION",
	confluence: "CONFLUENCE",
	"google-drive": "GOOGLE_DRIVE",
	"google drive": "GOOGLE_DRIVE",
	google_drive: "GOOGLE_DRIVE",
	github: "GITHUB",
	linear: "LINEAR",
	slack: "SLACK",
	perplexity: "PERPLEXITY",
	"web search": "PERPLEXITY",
	"web-search": "PERPLEXITY",
	"web-search-browse": "PERPLEXITY",
	firecrawl: "FIRECRAWL",
	"web scraping": "FIRECRAWL",
	fal: "FAL",
	"image generation": "FAL",
	"ai-gateway": "AI_GATEWAY",
	ai_gateway: "AI_GATEWAY",
	resend: "RESEND",
	email: "RESEND",
	mcp: "MCP",
	nhtsa_vpic: "NHTSA_VPIC",
	"nhtsa-vpic": "NHTSA_VPIC",
	"vehicle data": "NHTSA_VPIC",
	"databricks-vector-search": "DATABRICKS_VECTOR_SEARCH",
	"vector search": "DATABRICKS_VECTOR_SEARCH",
	// Uppercase versions (knowledgeSources from templates)
	NOTION: "NOTION",
	CONFLUENCE: "CONFLUENCE",
	GOOGLE_DRIVE: "GOOGLE_DRIVE",
	GITHUB: "GITHUB",
	LINEAR: "LINEAR",
	SLACK: "SLACK",
	PERPLEXITY: "PERPLEXITY",
	FIRECRAWL: "FIRECRAWL",
	FAL: "FAL",
	AI_GATEWAY: "AI_GATEWAY",
	RESEND: "RESEND",
	MCP: "MCP",
	NHTSA_VPIC: "NHTSA_VPIC",
	DATABRICKS_VECTOR_SEARCH: "DATABRICKS_VECTOR_SEARCH",
};

const LEGACY_TOOL_LABELS: Record<string, string> = {
	search: "Discover Knowledge",
	"web-search": "Web Search Browse",
	"web-search-browse": "Web Search Browse",
};

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_KNOWLEDGE_RESOURCES: Record<
	string,
	{ schema: string; indexes: string[] }
> = {};
const DEFAULT_TRIGGERS: TriggerConfig[] = [{ type: "manual", enabled: true }];

export function CreateAgentPage({
	template,
	organizationId,
	basePath = "/app/agent-templates",
	isCustomAgent = false,
	mode = "create",
	instanceId,
	instanceSId,
	initialValues,
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const tooltipT = useTranslations("tooltips.agents");
	const isEditMode = mode === "edit";

	const getDefaultName = () => initialValues?.name ?? "";
	const getDefaultDescription = () =>
		initialValues?.description ??
		(isCustomAgent ? "" : (template.description ?? ""));
	const getDefaultInstructions = () =>
		initialValues?.instructions ??
		(isCustomAgent
			? ""
			: (template.instructions ?? template.description ?? ""));
	const initialDataSources =
		initialValues?.selectedDataSources ?? EMPTY_STRING_ARRAY;
	const initialTools = initialValues?.selectedTools ?? EMPTY_STRING_ARRAY;
	const initialSkillIds =
		initialValues?.selectedSkillIds ?? EMPTY_STRING_ARRAY;
	const initialTriggers = initialValues?.triggers ?? DEFAULT_TRIGGERS;
	const initialStarterMessages = initialValues?.starterMessages ?? [];
	const initialWorkspaceDocumentFilters =
		initialValues?.workspaceDocumentFilters ?? [];
	const initialExecutionMode = initialValues?.executionMode ?? "single_turn";
	const initialGoal = initialValues?.goal ?? "";
	const initialMaxIterations = initialValues?.maxIterations ?? 10;
	const existingToolConnections =
		initialValues?.existingToolConnections ?? {};
	const existingSkillFiles = initialValues?.existingSkillFiles ?? [];
	const initialKnowledgeResources =
		initialValues?.knowledgeResources ?? EMPTY_KNOWLEDGE_RESOURCES;
	const initialDatabricksIntegrationId =
		initialValues?.databricksIntegrationId;

	// State
	const [name, setName] = useState(getDefaultName);
	const [description, setDescription] = useState(getDefaultDescription);
	const [instructions, setInstructions] = useState(getDefaultInstructions);
	const [selectedDataSources, setSelectedDataSources] =
		useState<string[]>(initialDataSources);
	const [knowledgeResources, setKnowledgeResources] = useState<
		Record<string, { schema: string; indexes: string[] }>
	>(initialKnowledgeResources);
	// Pins Databricks index discovery to the exact WorkflowIntegration bound
	// on this agent (edit/duplicate). Cleared when the user removes the
	// Databricks knowledge source, so a later reselect is free to bind
	// whichever connection the org-wide discovery resolves.
	const [pinnedDatabricksIntegrationId, setPinnedDatabricksIntegrationId] =
		useState<string | undefined>(initialDatabricksIntegrationId);

	// Wraps setSelectedDataSources: clears the pinned Databricks integration
	// id AND its schema/index selection whenever the user deselects the
	// Databricks knowledge source. A later reselect binds whatever the
	// org-wide discovery resolves — carrying the old connection's index
	// names onto a different connection would query the wrong workspace.
	const applySelectedDataSources = (next: string[]) => {
		if (
			selectedDataSources.includes("DATABRICKS_VECTOR_SEARCH") &&
			!next.includes("DATABRICKS_VECTOR_SEARCH")
		) {
			setPinnedDatabricksIntegrationId(undefined);
			setKnowledgeResources((prev) => {
				if (!prev.DATABRICKS_VECTOR_SEARCH) {
					return prev;
				}
				const { DATABRICKS_VECTOR_SEARCH: _removed, ...rest } = prev;
				return rest;
			});
		}
		setSelectedDataSources(next);
	};

	const [selectedTools, setSelectedTools] = useState<string[]>(initialTools);
	const [toolConfigs, setToolConfigs] = useState<
		Record<string, Record<string, unknown>>
	>(() => {
		const initial: Record<string, Record<string, unknown>> = {};
		for (const [key, value] of Object.entries(existingToolConnections)) {
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				!key.startsWith("mcp:")
			) {
				const {
					enabled: _enabled,
					connectionId,
					...rest
				} = value as {
					enabled?: boolean;
					connectionId?: unknown;
					[k: string]: unknown;
				};
				if (connectionId) {
					continue;
				}
				if (Object.keys(rest).length > 0) {
					initial[key] = rest;
				}
			}
		}
		return initial;
	});
	const [dataSourcesSheetOpen, setDataSourcesSheetOpen] = useState(false);
	const [toolsSheetOpen, setToolsSheetOpen] = useState(false);
	const [triggersSheetOpen, setTriggersSheetOpen] = useState(false);
	const [workspacesSheetOpen, setWorkspacesSheetOpen] = useState(false);
	const [triggers, setTriggers] = useState<TriggerConfig[]>(initialTriggers);
	const [starterMessages, setStarterMessages] = useState<StarterMessage[]>(
		initialStarterMessages,
	);
	const [workspaceDocumentFilters, setWorkspaceDocumentFilters] = useState<
		WorkspaceDocumentFilter[]
	>(initialWorkspaceDocumentFilters);

	// Goal-oriented execution state
	const [executionMode, setExecutionMode] = useState<
		"single_turn" | "goal_oriented"
	>(initialExecutionMode);
	const [goal, setGoal] = useState(initialGoal);
	const [maxIterations, setMaxIterations] = useState(initialMaxIterations);

	// External API state
	const [isApiExposed, setIsApiExposed] = useState(
		initialValues?.isApiExposed ?? false,
	);
	// Stable identifier for external API URLs (survives version updates)
	const apiIdentifier = instanceSId || instanceId;

	// Skills state
	const [selectedSkillIds, setSelectedSkillIds] =
		useState<string[]>(initialSkillIds);

	// Right panel tab state
	const [rightPanelTab, setRightPanelTab] = useState<"sidekick" | "guide">(
		"sidekick",
	);

	// AI generation state
	const [isGeneratingName, setIsGeneratingName] = useState(false);
	const [isGeneratingDesc, setIsGeneratingDesc] = useState(false);
	const [isGeneratingInstructions, setIsGeneratingInstructions] =
		useState(false);

	// Get category icon for this template
	const { icon: CategoryIcon } = getCategoryIcon(template.category);
	const descriptionPlaceholder = (template.description ?? "").trim();
	const instructionsPlaceholder = (
		template.instructions ??
		template.description ??
		""
	).trim();
	const hasRequiredText =
		name.trim().length > 0 &&
		description.trim().length > 0 &&
		instructions.trim().length > 0;

	// Get all available integration plugins for icons
	const allIntegrations = useMemo(() => getAllIntegrations(), []);

	// Get plugin by type
	const getPluginByType = (type: IntegrationType) => {
		return allIntegrations.find((p) => p.type === type);
	};

	// Fetch the system custom-agent template when in custom agent mode
	// This allows us to create instances from a single system template
	// instead of creating a new template for each custom agent
	const { data: systemCustomAgentTemplate } = useQuery({
		queryKey: ["agent-template", "custom-agent"],
		queryFn: async () => {
			try {
				return await orpcClient.agentTemplates.templates.get({
					slugOrId: "custom-agent",
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.toLowerCase().includes("template not found")
				) {
					return null;
				}
				throw error;
			}
		},
		enabled: isCustomAgent,
		retry: false,
	});

	// Fetch configured integrations
	// staleTime: 0 ensures fresh data on mount — integration status may change
	// on the settings page and must be current when creating an agent
	const { data: integrationsData } = useQuery({
		queryKey: ["workflow-integrations", organizationId],
		queryFn: async () => {
			return await orpcClient.workflows.integrations.list({
				organizationId,
			});
		},
		staleTime: 0,
	});

	const configuredIntegrations = integrationsData?.integrations ?? [];

	// Databricks Vector Search may be connected by another org member — that
	// connection doesn't show up in `configuredIntegrations` (creator-only)
	// but the discovery endpoint is authorized at the tenant level. Mirrors
	// the same query in DataSourcesSheet so a fallback integrationId is
	// available when binding the agent below.
	const { data: databricksIndexData } = useQuery({
		queryKey: [
			"databricks-vector-indexes",
			organizationId ?? null,
			pinnedDatabricksIntegrationId ?? null,
		],
		queryFn: async () =>
			await orpcClient.workflows.integrations.listDatabricksIndexes({
				organizationId: organizationId ?? null,
				integrationId: pinnedDatabricksIntegrationId,
			}),
		enabled: selectedDataSources.includes("DATABRICKS_VECTOR_SEARCH"),
		staleTime: 5 * 60 * 1000,
	});

	// Fetch workspace details for selected workspaces (to show names)
	const { data: workspacesData } = useQuery({
		queryKey: ["workspaces-list", organizationId],
		queryFn: async () => {
			return await orpcClient.documentWorkspaces.list({
				organizationId: organizationId ?? null,
				limit: 50,
				status: "ACTIVE",
				includeShared: true,
			});
		},
	});

	// Fetch MCP configs (for resolving mcp:id display names)
	const { data: mcpConfigsData } = useQuery({
		queryKey: ["mcp-configs", organizationId],
		queryFn: async () => {
			return await orpcClient.mcp.configs.list({
				organizationId: organizationId ?? null,
			});
		},
	});

	const mcpConfigs: any[] = Array.isArray(mcpConfigsData)
		? mcpConfigsData
		: (mcpConfigsData?.configs ?? []);

	// Resolve display name for a tool ID (handles mcp:configId → friendly name)
	const getToolDisplayName = (toolId: string): string => {
		if (toolId.startsWith("mcp:")) {
			const configId = toolId.slice(4);
			const config = mcpConfigs.find((c: any) => c.id === configId);
			if (config) {
				return (
					config.displayName || config.mcpServer?.name || "MCP Server"
				);
			}
			return "MCP Server";
		}
		const builtInCapability = getBuiltInCapability(toolId);
		if (builtInCapability) {
			return builtInCapability.name;
		}
		const legacyLabel = LEGACY_TOOL_LABELS[toolId];
		if (legacyLabel) {
			return legacyLabel;
		}
		const integrationType =
			TOOL_TO_INTEGRATION_MAP[toolId] ||
			TOOL_TO_INTEGRATION_MAP[toolId.toLowerCase()];
		if (integrationType) {
			return getIntegration(integrationType)?.label || toolId;
		}
		return toolId;
	};

	// Fetch skills catalog
	const { data: skillsCatalogData } = useQuery(
		orpc.skills.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 100,
				isPublished: true,
			},
		}),
	);

	const catalogSkills = skillsCatalogData?.skills ?? [];
	const selectedSkills = selectedSkillIds
		.map((skillId) => {
			const catalogSkill = catalogSkills.find((s) => s.id === skillId);
			if (catalogSkill) {
				return catalogSkill;
			}
			const existingSkill = existingSkillFiles.find(
				(file) => file.sourceSkillId === skillId,
			);
			return existingSkill
				? {
						id: skillId,
						name: existingSkill.path
							.replace("skills/", "")
							.replace("/SKILL.md", "")
							.replace(/[-/]+/g, " "),
						description: "",
						category: null,
					}
				: null;
		})
		.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));

	useEffect(() => {
		setName(getDefaultName());
		setDescription(getDefaultDescription());
		setInstructions(getDefaultInstructions());
		setSelectedDataSources(initialDataSources);
		setPinnedDatabricksIntegrationId(initialDatabricksIntegrationId);
		setKnowledgeResources(initialKnowledgeResources);
		setSelectedTools(initialTools);
		setSelectedSkillIds(initialSkillIds);
		setTriggers(initialTriggers);
		setExecutionMode(initialExecutionMode);
		setGoal(initialGoal);
		setMaxIterations(initialMaxIterations);
	}, [
		template.id,
		isCustomAgent,
		initialDataSources,
		initialDatabricksIntegrationId,
		initialKnowledgeResources,
		initialExecutionMode,
		initialGoal,
		initialMaxIterations,
		initialSkillIds,
		initialTools,
		initialTriggers,
	]);

	// Get selected workspace details
	const selectedWorkspaces = useMemo(() => {
		if (!workspacesData?.workspaces || selectedDataSources.length === 0) {
			return [];
		}
		return workspacesData.workspaces.filter((w) =>
			selectedDataSources.includes(w.id),
		);
	}, [workspacesData?.workspaces, selectedDataSources]);

	// Dust-style templates do not prescribe integrations.
	const requiredIntegrations: Array<{
		type: IntegrationType;
		plugin: ReturnType<typeof getPluginByType>;
		isConfigured: boolean;
	}> = [];

	const missingIntegrations = requiredIntegrations.filter(
		(i) => !i.isConfigured,
	);
	const hasAllRequiredIntegrations = missingIntegrations.length === 0;
	const integrationsSettingsUrl = useContextPath("settings/integrations");
	// Was built by interpolating the organization ID into a segment that
	// resolves by SLUG, so the "Add" link 404'd inside an organization.
	const mcpServersUrl = useContextPath("mcp-servers");
	// === MCP Server Requirements ===
	// State to track which MCP config is selected for each required key
	type ToolConnections = Record<
		string,
		{ enabled: boolean; mcpConfigId?: string }
	>;
	const [toolConnections, setToolConnections] = useState<ToolConnections>({});

	// Dust-style templates do not prescribe MCP requirements.
	const requiredMcpServerKeys = useMemo<string[]>(() => [], []);

	// Fetch available MCP configs matching required keys (system + custom servers)
	const { data: availableMcpConfigsData } = useQuery({
		queryKey: [
			"mcp-available-configs",
			requiredMcpServerKeys,
			organizationId,
		],
		queryFn: async () => {
			if (requiredMcpServerKeys.length === 0) {
				return [];
			}
			return await orpcClient.mcp.availableConfigs({
				keys: requiredMcpServerKeys,
				organizationId: organizationId ?? null,
			});
		},
		enabled: requiredMcpServerKeys.length > 0,
	});

	type McpConfigOption = {
		configId: string;
		configName: string;
		serverId: string | null;
		serverName: string | null;
		serverKey: string | null;
		isSystemServer: boolean;
		iconUrl: string | null;
	};

	type RequiredMcpKey = {
		key: string;
		configs: McpConfigOption[];
	};

	const requiredMcpKeys = (availableMcpConfigsData ?? []) as RequiredMcpKey[];

	// Check which required keys have at least one available config
	const _mcpKeysWithConfigs = requiredMcpKeys.filter(
		(k) => k.configs.length > 0,
	);
	const _mcpKeysWithoutConfigs = requiredMcpKeys.filter(
		(k) => k.configs.length === 0,
	);

	// Also check which keys are missing from the response (server not found at all)
	const _missingMcpKeys = requiredMcpServerKeys.filter(
		(key) => !requiredMcpKeys.some((k) => k.key === key),
	);

	// Has all required MCP if every key has at least one config AND user has selected one
	const hasAllRequiredMcpServers = useMemo(() => {
		if (requiredMcpServerKeys.length === 0) {
			return true;
		}
		// Check if all required keys have configs available
		const allKeysHaveConfigs = requiredMcpServerKeys.every((key) => {
			const keyData = requiredMcpKeys.find((k) => k.key === key);
			return keyData && keyData.configs.length > 0;
		});
		if (!allKeysHaveConfigs) {
			return false;
		}
		// Check if user has selected a config for each key
		return requiredMcpServerKeys.every((key) => {
			return toolConnections[`mcp:${key}`]?.mcpConfigId;
		});
	}, [requiredMcpServerKeys, requiredMcpKeys, toolConnections]);

	// Auto-populate toolConnections when configs are loaded (select first available)
	useEffect(() => {
		if (requiredMcpKeys.length > 0) {
			const newToolConnections: ToolConnections = { ...toolConnections };
			let hasChanges = false;

			for (const keyData of requiredMcpKeys) {
				if (keyData.configs.length > 0) {
					// Auto-select first config if not already set
					if (!newToolConnections[`mcp:${keyData.key}`]) {
						newToolConnections[`mcp:${keyData.key}`] = {
							enabled: true,
							mcpConfigId: keyData.configs[0].configId,
						};
						hasChanges = true;
					}
				}
			}

			if (hasChanges) {
				setToolConnections(newToolConnections);
			}
		}
	}, [requiredMcpKeys]);

	// Mutation for creating an instance from an existing template
	const createInstanceMutation = useMutation(
		orpc.agentTemplates.instances.create.mutationOptions(),
	);
	const updateInstanceMutation = useMutation(
		orpc.agentTemplates.instances.update.mutationOptions(),
	);

	const handleSubmit = async () => {
		if (!name.trim()) {
			toast.error("Please enter a name for your agent");
			return;
		}

		if (!description.trim()) {
			toast.error("Please enter a description for your agent");
			return;
		}

		if (!instructions.trim()) {
			toast.error("Please enter instructions for your agent");
			return;
		}

		// Validate goal is provided when goal_oriented mode is selected
		if (executionMode === "goal_oriented" && !goal.trim()) {
			toast.error("Please enter a goal for goal-oriented execution");
			return;
		}

		// Transform TriggerConfig[] to the format expected by the API
		const triggersForApi = triggers
			.filter((t) => t.enabled)
			.map((t) => ({
				type: t.type,
				enabled: t.enabled,
				config: t.config,
			}));

		// Filter out integration types from selectedDataSources - only keep actual workspace UUIDs
		// Use getIntegrationTypes() to dynamically get all registered integration types
		const allIntegrationTypes = getIntegrationTypes();
		const workspaceIdsOnly = selectedDataSources.filter(
			(id) => !allIntegrationTypes.includes(id as IntegrationType),
		);

		// Extract integration types (like NOTION, MICROSOFT_GRAPH) and build knowledgeConnections
		// Format: { "NOTION": "oauth", "CONFLUENCE": "integration-id-123" }
		// OAuth providers use "oauth" marker, API-key providers use actual integration ID
		const selectedIntegrationTypes = selectedDataSources.filter((id) =>
			allIntegrationTypes.includes(id as IntegrationType),
		) as IntegrationType[];
		const trimmedName = name.trim();
		const trimmedDescription = description.trim().slice(0, 500);
		const trimmedInstructions = instructions.trim();
		const trimmedGoal = goal.trim();

		const knowledgeConnections: Record<string, string> = {};
		for (const integrationType of selectedIntegrationTypes) {
			if (isOAuthProvider(integrationType)) {
				// OAuth providers use "oauth" as a marker value
				knowledgeConnections[integrationType] = "oauth";
			} else if (integrationType === "DATABRICKS_VECTOR_SEARCH") {
				// Bind exactly the integration whose indexes were discovered —
				// a creator-owned row may be a different workspace than the one
				// the org-shared discovery listed. Fall back to the pinned id
				// (this agent's already-bound integration) so saving an
				// unrelated edit on an existing agent isn't blocked while
				// discovery is slow, failed, or hasn't returned yet — the
				// discovery query above is itself pinned to this same
				// integration, so it can only confirm it, never resolve to a
				// different one.
				const boundDatabricksIntegrationId =
					databricksIndexData?.integrationId ??
					pinnedDatabricksIntegrationId;
				if (boundDatabricksIntegrationId) {
					knowledgeConnections[integrationType] =
						boundDatabricksIntegrationId;
				} else {
					toast.error(
						"Databricks index discovery hasn't finished — reopen Data sources and try again",
					);
					return;
				}
			} else {
				// API-key providers need the actual integration ID from WorkflowIntegration
				const integration = configuredIntegrations.find(
					(i) => i.provider === integrationType && i.hasCredentials,
				);
				if (integration) {
					knowledgeConnections[integrationType] = integration.id;
				}
				// If no configured integration found, skip this one (validation will catch it)
			}
		}

		// Only send resource scoping for connections that are actually being
		// bound this submission, and only once at least one index is picked.
		const knowledgeResourcesForApi: Record<
			string,
			{ schema: string; indexes: string[] }
		> = {};
		for (const [provider, resources] of Object.entries(
			knowledgeResources,
		)) {
			if (
				knowledgeConnections[provider] &&
				resources.indexes.length > 0
			) {
				knowledgeResourcesForApi[provider] = resources;
			}
		}

		const toolConnectionsForApi: Record<
			string,
			{ enabled: boolean; mcpConfigId?: string; [key: string]: unknown }
		> = {};
		for (const tool of selectedTools) {
			const existingConnection = existingToolConnections[tool] as
				| {
						enabled?: boolean;
						mcpConfigId?: string;
						[key: string]: unknown;
				  }
				| undefined;
			const overlay = toolConfigs[tool] ?? {};
			if (existingConnection) {
				toolConnectionsForApi[tool] = {
					...existingConnection,
					...overlay,
					enabled: true,
				};
			} else if (tool.startsWith("mcp:")) {
				const configId = tool.slice(4);
				toolConnectionsForApi[tool] = {
					enabled: true,
					mcpConfigId: configId,
					...overlay,
				};
			} else {
				toolConnectionsForApi[tool] = { enabled: true, ...overlay };
			}
		}
		try {
			if (isEditMode) {
				if (!instanceId) {
					toast.error("Agent instance is missing");
					return;
				}

				const result = await updateInstanceMutation.mutateAsync({
					id: instanceId,
					name: trimmedName,
					description: trimmedDescription,
					customInstructions: {
						role: trimmedInstructions,
						starterMessages:
							starterMessages.length > 0
								? starterMessages
								: undefined,
						knowledgeFilters:
							workspaceDocumentFilters.length > 0
								? workspaceDocumentFilters
								: undefined,
					},
					workspaceIds: workspaceIdsOnly,
					knowledgeConnections,
					knowledgeResources:
						Object.keys(knowledgeResourcesForApi).length > 0
							? knowledgeResourcesForApi
							: undefined,
					toolConnections: toolConnectionsForApi,
					triggers:
						triggersForApi.length > 0 ? triggersForApi : undefined,
					executionMode,
					goal:
						executionMode === "goal_oriented"
							? trimmedGoal
							: undefined,
					maxIterations:
						executionMode === "goal_oriented"
							? maxIterations
							: undefined,
					isApiExposed,
					createNewVersion: true,
				});

				const savedInstanceId = result.instance?.id ?? instanceId;
				const existingSkillIds = new Set(
					existingSkillFiles
						.map((file) => file.sourceSkillId)
						.filter((id): id is string => Boolean(id)),
				);

				await Promise.all(
					existingSkillFiles
						.filter(
							(file) =>
								file.sourceSkillId &&
								!selectedSkillIds.includes(file.sourceSkillId),
						)
						.map((file) =>
							orpcClient.agentMemory.files.delete({
								organizationId: organizationId ?? null,
								agentInstanceId: savedInstanceId,
								path: file.path,
							}),
						),
				);

				await Promise.all(
					catalogSkills
						.filter(
							(skill) =>
								selectedSkillIds.includes(skill.id) &&
								!existingSkillIds.has(skill.id),
						)
						.map((skill) =>
							orpcClient.agentMemory.files.write({
								organizationId: organizationId ?? null,
								agentInstanceId: savedInstanceId,
								path: `skills/${skill.slug}/SKILL.md`,
								content: skill.content,
								isEnabled: true,
								sourceSkillId: skill.id,
							}),
						),
				);

				await queryClient.invalidateQueries({
					queryKey: ["agentMemory"],
				});
				await queryClient.invalidateQueries({
					queryKey: ["agentTemplates", "instances"],
				});
				toast.success("Agent updated successfully!");
				router.push(
					`${basePath.replace(/\/agents$/, "")}/agents/${savedInstanceId}`,
				);
				return;
			}

			const createPayload = {
				templateId: isCustomAgent
					? systemCustomAgentTemplate?.template?.id
					: template.id,
				name: trimmedName,
				description: trimmedDescription,
				organizationId: organizationId ?? null,
				heroEmojis: template.heroEmojis,
				workspaceIds:
					workspaceIdsOnly.length > 0 ? workspaceIdsOnly : undefined,
				knowledgeConnections:
					Object.keys(knowledgeConnections).length > 0
						? knowledgeConnections
						: undefined,
				knowledgeResources:
					Object.keys(knowledgeResourcesForApi).length > 0
						? knowledgeResourcesForApi
						: undefined,
				toolConnections:
					Object.keys(toolConnectionsForApi).length > 0
						? toolConnectionsForApi
						: undefined,
				triggers:
					triggersForApi.length > 0 ? triggersForApi : undefined,
				customInstructions: {
					role: trimmedInstructions,
					starterMessages:
						starterMessages.length > 0
							? starterMessages
							: undefined,
					knowledgeFilters:
						workspaceDocumentFilters.length > 0
							? workspaceDocumentFilters
							: undefined,
				},
				executionMode,
				goal:
					executionMode === "goal_oriented" ? trimmedGoal : undefined,
				maxIterations:
					executionMode === "goal_oriented"
						? maxIterations
						: undefined,
				additionalSkillIds:
					selectedSkillIds.length > 0 ? selectedSkillIds : undefined,
			};

			if (isCustomAgent && !createPayload.templateId) {
				toast.error(
					"Custom agent template not found. Please ensure the system templates have been seeded.",
				);
				return;
			}

			const result = await createInstanceMutation.mutateAsync(
				createPayload as never,
			);
			await queryClient.invalidateQueries({
				queryKey: ["agentTemplates", "instances"],
			});
			toast.success("Agent created successfully!");
			router.push(
				`${basePath.replace(/\/agents$/, "")}/agents/${result.instance.id}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: isEditMode
						? "Failed to update agent"
						: "Failed to create agent",
			);
		}
	};

	// AI Generation handlers
	const handleGenerateName = async () => {
		setIsGeneratingName(true);
		try {
			// Generate a name based on template
			const baseName = template.displayName
				.toLowerCase()
				.replace(/\s+/g, "-");
			const suggestions = [
				`${baseName}-agent`,
				`my-${template.category.toLowerCase()}-assistant`,
				`${baseName}-v1`,
				`${template.category.toLowerCase()}-helper`,
			];
			// Simulate AI delay
			await new Promise((resolve) => setTimeout(resolve, 500));
			setName(
				suggestions[Math.floor(Math.random() * suggestions.length)],
			);
			toast.success("Name generated!");
		} catch {
			toast.error("Failed to generate name");
		} finally {
			setIsGeneratingName(false);
		}
	};

	const handleGenerateDescription = async () => {
		setIsGeneratingDesc(true);
		try {
			await new Promise((resolve) => setTimeout(resolve, 500));
			const desc = `AI-powered ${template.category.toLowerCase()} assistant based on ${template.displayName}. ${template.description}`;
			setDescription(desc);
			toast.success("Description generated!");
		} catch {
			toast.error("Failed to generate description");
		} finally {
			setIsGeneratingDesc(false);
		}
	};

	const handleGenerateInstructions = async () => {
		setIsGeneratingInstructions(true);
		try {
			await new Promise((resolve) => setTimeout(resolve, 800));
			// Enhance existing instructions with template context
			const enhanced = `${instructions}\n\n## Additional Context\nThis agent is configured for ${template.category.toLowerCase()} tasks. Please ensure responses are professional and accurate.`;
			setInstructions(enhanced);
			toast.success("Instructions enhanced!");
		} catch {
			toast.error("Failed to enhance instructions");
		} finally {
			setIsGeneratingInstructions(false);
		}
	};

	const effectiveAgentId = instanceId ?? "new";
	// Saved instances use the "instance" entity type so the Sidekick stream
	// authz path looks them up in AgentTemplateInstance rather than the
	// RegisteredAgent table. Unsaved agents stay on the "new" sentinel.
	const sidekickEntityType = instanceId ? "instance" : "registered";

	return (
		<SidekickSuggestionsProvider
			agentId={effectiveAgentId}
			entityType={sidekickEntityType}
		>
			<SidekickFormProvider
				formValues={{
					name,
					description,
					systemPromptMarkdown: instructions,
					model: "",
					tools: selectedTools.map((t) => ({ id: t, name: t })),
					skills: selectedSkillIds,
				}}
				pendingSuggestions={[]}
				onSetFormField={(field, updater) => {
					if (field === "name") {
						setName(updater(name) as string);
					} else if (field === "description") {
						setDescription(updater(description) as string);
					} else if (
						field === "systemPromptMarkdown" ||
						field === "systemPrompt"
					) {
						setInstructions(updater(instructions) as string);
					} else if (field === "tools") {
						// The updater works with {id, name} objects (matching
						// SidekickFormValues.tools) but this page stores plain
						// string IDs. Convert both ways at the boundary.
						const asObjects = selectedTools.map((t) => ({
							id: t,
							name: t,
						}));
						const result = updater(asObjects) as Array<
							string | { id: string; name: string }
						>;
						setSelectedTools(
							result.map((t) =>
								typeof t === "string" ? t : t.id,
							),
						);
					} else if (field === "dataSources") {
						applySelectedDataSources(
							updater(selectedDataSources) as string[],
						);
					} else if (field === "skills") {
						setSelectedSkillIds(
							updater(selectedSkillIds) as string[],
						);
					}
				}}
			>
				<div className="bg-background">
					{/* Sticky action bar */}
					<div className="sticky top-0 z-10 border-b border-border bg-card">
						<div className="w-full px-6 py-3">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<div className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
										<RobotIcon className="h-4 w-4 text-primary" />
									</div>
									<div className="h-4 w-px bg-border" />
									<div>
										<p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
											Agent Builder
										</p>
										<h1 className="font-sans text-base font-normal leading-tight">
											{isEditMode
												? "Edit Agent"
												: isCustomAgent
													? "Create Custom Agent"
													: "Create New Agent"}
										</h1>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										onClick={() => router.back()}
									>
										Cancel
									</Button>
									<Button
										onClick={handleSubmit}
										disabled={
											createInstanceMutation.isPending ||
											updateInstanceMutation.isPending ||
											!hasRequiredText ||
											(executionMode ===
												"goal_oriented" &&
												!goal.trim()) ||
											(!isEditMode &&
												isCustomAgent &&
												!systemCustomAgentTemplate
													?.template?.id)
										}
										className="bg-primary px-6 text-primary-foreground hover:bg-primary/90"
									>
										{createInstanceMutation.isPending ||
										updateInstanceMutation.isPending ? (
											<>
												<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
												{isEditMode
													? "Saving..."
													: "Creating..."}
											</>
										) : isEditMode ? (
											"Save Changes"
										) : isCustomAgent ? (
											"Create Custom Agent"
										) : (
											"Create Agent"
										)}
									</Button>
								</div>
							</div>
						</div>
					</div>

					{/* Two-column layout */}
					<div className="flex w-full">
						{/* Main content */}
						<div className="flex-1">
							<div className="p-6 space-y-8">
								{/* Section 1: Instructions */}
								<section>
									<div className="flex items-center justify-between mb-4">
										<div>
											<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
												<span className="inline-block h-3 w-px bg-[--mkt-red]" />
												Step 1
											</p>
											<h3 className="text-base font-semibold">
												Instructions
												<span className="ml-1 text-destructive">
													*
												</span>
											</h3>
											<p className="text-sm text-muted-foreground">
												Edit the starting instructions
												from this template before
												{isEditMode
													? " saving your agent."
													: " creating your agent."}
											</p>
										</div>
									</div>

									<div className="relative">
										<Textarea
											value={instructions}
											onChange={(e) =>
												setInstructions(e.target.value)
											}
											className="min-h-[400px] rounded-xl border-border bg-muted/40 p-4 font-mono text-sm"
											placeholder={
												instructionsPlaceholder ||
												"Describe how this agent should behave, what context it should use, and how it should respond."
											}
										/>
										<Button
											variant="ghost"
											size="icon"
											className="absolute bottom-3 right-3 h-8 w-8 bg-background hover:bg-muted"
											title="Generate with AI"
											onClick={handleGenerateInstructions}
											disabled={isGeneratingInstructions}
										>
											{isGeneratingInstructions ? (
												<Loader2Icon className="h-4 w-4 animate-spin" />
											) : (
												<SparklesIcon className="h-4 w-4" />
											)}
										</Button>
									</div>
								</section>

								{/* Starter Messages */}
								<section>
									<div className="mb-4">
										<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
											<span className="inline-block h-3 w-px bg-[--mkt-red]" />
											Optional
										</p>
										<h3 className="text-base font-semibold">
											Starter Messages
										</h3>
										<p className="mt-0.5 text-sm text-muted-foreground">
											Clickable suggestions shown when a
											user opens a new chat with this
											agent.
										</p>
									</div>

									{starterMessages.length > 0 && (
										<div className="flex flex-wrap gap-2 mb-3">
											{starterMessages.map((msg, idx) => (
												<div
													key={idx}
													className="group flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1.5 text-sm"
												>
													<span>{msg.emoji}</span>
													<span>{msg.label}</span>
													<button
														type="button"
														className="ml-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
														onClick={() =>
															setStarterMessages(
																starterMessages.filter(
																	(_, i) =>
																		i !==
																		idx,
																),
															)
														}
													>
														&times;
													</button>
												</div>
											))}
										</div>
									)}

									{starterMessages.length < 6 && (
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => {
												setStarterMessages([
													...starterMessages,
													{
														label: "",
														emoji: "💡",
														prompt: "",
													},
												]);
											}}
										>
											<PlusIcon className="mr-1.5 h-3.5 w-3.5" />
											Add Starter Message
										</Button>
									)}

									{starterMessages.length > 0 && (
										<div className="mt-3 space-y-3">
											{starterMessages.map((msg, idx) => (
												<div
													key={idx}
													className="grid grid-cols-[60px_1fr_1fr] gap-2 items-start rounded-lg border bg-card p-3"
												>
													<div>
														<label
															htmlFor={`starter-message-emoji-${idx}`}
															className="text-xs text-muted-foreground"
														>
															Emoji
														</label>
														<input
															id={`starter-message-emoji-${idx}`}
															type="text"
															value={msg.emoji}
															maxLength={2}
															className="mt-1 w-full rounded border bg-muted/40 px-2 py-1 text-center text-lg"
															onChange={(e) => {
																const updated =
																	[
																		...starterMessages,
																	];
																updated[idx] = {
																	...updated[
																		idx
																	],
																	emoji: e
																		.target
																		.value,
																};
																setStarterMessages(
																	updated,
																);
															}}
														/>
													</div>
													<div>
														<label
															htmlFor={`starter-message-label-${idx}`}
															className="text-xs text-muted-foreground"
														>
															Label
														</label>
														<input
															id={`starter-message-label-${idx}`}
															type="text"
															value={msg.label}
															placeholder="e.g. Plan a feature"
															maxLength={40}
															className="mt-1 w-full rounded border bg-muted/40 px-2 py-1.5 text-sm"
															onChange={(e) => {
																const updated =
																	[
																		...starterMessages,
																	];
																updated[idx] = {
																	...updated[
																		idx
																	],
																	label: e
																		.target
																		.value,
																};
																setStarterMessages(
																	updated,
																);
															}}
														/>
													</div>
													<div>
														<label
															htmlFor={`starter-message-prompt-${idx}`}
															className="text-xs text-muted-foreground"
														>
															Prompt
														</label>
														<input
															id={`starter-message-prompt-${idx}`}
															type="text"
															value={msg.prompt}
															placeholder="Full message sent on click"
															className="mt-1 w-full rounded border bg-muted/40 px-2 py-1.5 text-sm"
															onChange={(e) => {
																const updated =
																	[
																		...starterMessages,
																	];
																updated[idx] = {
																	...updated[
																		idx
																	],
																	prompt: e
																		.target
																		.value,
																};
																setStarterMessages(
																	updated,
																);
															}}
														/>
													</div>
												</div>
											))}
										</div>
									)}
								</section>

								{/* Section 2: Required Integrations Warning (only show when creating from template) */}
								{!isCustomAgent &&
									requiredIntegrations.length > 0 && (
										<section>
											<div className="mb-4">
												<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
													<span className="inline-block h-3 w-px bg-[--mkt-red]" />
													Step 2
												</p>
												<h3 className="text-base font-semibold">
													Required Integrations
												</h3>
												<p className="text-sm text-muted-foreground">
													This template requires the
													following integrations to
													work properly.
												</p>
											</div>

											<div
												className={cn(
													"rounded-xl border p-4",
													hasAllRequiredIntegrations
														? "border-success/20 bg-success/5"
														: "border-destructive/20 bg-destructive/5",
												)}
											>
												<div className="flex flex-wrap gap-3 mb-4">
													{requiredIntegrations.map(
														({
															type,
															plugin,
															isConfigured,
														}) => {
															if (!plugin) {
																return null;
															}
															return (
																<div
																	key={type}
																	className={cn(
																		"flex items-center gap-2 rounded-lg border px-3 py-2",
																		isConfigured
																			? "border-success/30 bg-card"
																			: "border-destructive/30 bg-card",
																	)}
																>
																	<IntegrationBrandIcon
																		icon={
																			plugin.icon
																		}
																		label={
																			plugin.label
																		}
																		color={
																			plugin.color
																		}
																		brandColor={
																			plugin.brandColor
																		}
																		size={
																			24
																		}
																		className="rounded-md"
																		iconClassName="h-3.5 w-3.5"
																	/>
																	<span className="text-sm font-medium">
																		{
																			plugin.label
																		}
																	</span>
																	{isConfigured ? (
																		<CheckCircle2Icon className="h-4 w-4 text-success" />
																	) : (
																		<AlertCircleIcon className="h-4 w-4 text-amber-600" />
																	)}
																</div>
															);
														},
													)}
												</div>

												{!hasAllRequiredIntegrations && (
													<div className="flex items-center justify-between">
														<p className="text-sm text-highlight">
															{
																missingIntegrations.length
															}{" "}
															integration
															{missingIntegrations.length !==
															1
																? "s"
																: ""}{" "}
															need
															{missingIntegrations.length ===
															1
																? "s"
																: ""}{" "}
															to be configured
														</p>
														<Button
															variant="outline"
															size="sm"
															className="border-border text-foreground hover:bg-muted"
															asChild
														>
															<Link
																href={
																	integrationsSettingsUrl
																}
															>
																<SettingsIcon className="h-4 w-4 mr-2" />
																Configure
																Integrations
															</Link>
														</Button>
													</div>
												)}

												{hasAllRequiredIntegrations && (
													<p className="text-sm text-success flex items-center gap-2">
														<CheckCircle2Icon className="h-4 w-4" />
														All required
														integrations are
														configured!
													</p>
												)}
											</div>
										</section>
									)}

								{/* Section 2b: Required MCP Servers (only show when template has requiredMcpServers) */}
								{!isCustomAgent &&
									requiredMcpServerKeys.length > 0 && (
										<section>
											<div className="mb-4">
												<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
													<span className="inline-block h-3 w-px bg-[--mkt-red]" />
													Step 2b
												</p>
												<h3 className="text-base font-semibold">
													Required MCP Integrations
												</h3>
												<p className="text-sm text-muted-foreground">
													Select which MCP connection
													to use for each required
													integration.
												</p>
											</div>

											<div className="space-y-4">
												{requiredMcpServerKeys.map(
													(key) => {
														const keyData =
															requiredMcpKeys.find(
																(k) =>
																	k.key ===
																	key,
															);
														const hasConfigs =
															keyData &&
															keyData.configs
																.length > 0;
														const selectedConfigId =
															toolConnections[
																`mcp:${key}`
															]?.mcpConfigId;
														const selectedConfig =
															keyData?.configs.find(
																(c) =>
																	c.configId ===
																	selectedConfigId,
															);

														return (
															<div
																key={key}
																className={cn(
																	"rounded-xl border p-4",
																	hasConfigs
																		? "border-success/20 bg-success/5"
																		: "border-destructive/20 bg-destructive/5",
																)}
															>
																<div className="flex items-center justify-between">
																	<div className="flex items-center gap-3">
																		<div
																			className={cn(
																				"flex h-8 w-8 items-center justify-center rounded-lg",
																				hasConfigs
																					? "bg-success/10"
																					: "bg-destructive/10",
																			)}
																		>
																			<SettingsIcon
																				className={cn(
																					"h-4 w-4",
																					hasConfigs
																						? "text-success"
																						: "text-amber-600",
																				)}
																			/>
																		</div>
																		<div>
																			<p className="font-medium capitalize">
																				{
																					key
																				}
																			</p>
																			{hasConfigs ? (
																				<p className="text-xs text-muted-foreground">
																					{
																						keyData
																							.configs
																							.length
																					}{" "}
																					connection
																					{keyData
																						.configs
																						.length !==
																					1
																						? "s"
																						: ""}{" "}
																					available
																				</p>
																			) : (
																				<p className="text-xs text-amber-600">
																					No
																					connections
																					found
																				</p>
																			)}
																		</div>
																	</div>

																	{hasConfigs ? (
																		<div className="flex items-center gap-2">
																			{keyData
																				.configs
																				.length ===
																			1 ? (
																				<div className="flex items-center gap-2 rounded-lg border border-success/30 bg-card px-3 py-1.5">
																					<CheckCircle2Icon className="h-4 w-4 text-success" />
																					<span className="text-sm">
																						{
																							selectedConfig?.configName
																						}
																					</span>
																				</div>
																			) : (
																				<DropdownMenu>
																					<DropdownMenuTrigger
																						asChild
																					>
																						<Button
																							variant="outline"
																							size="sm"
																							className="gap-2"
																						>
																							{selectedConfig?.configName ||
																								"Select connection"}
																							<ChevronDownIcon className="h-4 w-4" />
																						</Button>
																					</DropdownMenuTrigger>
																					<DropdownMenuContent align="end">
																						{keyData.configs.map(
																							(
																								config,
																							) => (
																								<DropdownMenuItem
																									key={
																										config.configId
																									}
																									onClick={() => {
																										setToolConnections(
																											{
																												...toolConnections,
																												[`mcp:${key}`]:
																													{
																														enabled: true,
																														mcpConfigId:
																															config.configId,
																													},
																											},
																										);
																									}}
																								>
																									<div className="flex items-center gap-2">
																										{config.configId ===
																											selectedConfigId && (
																											<CheckIcon className="h-4 w-4 text-success" />
																										)}
																										<span>
																											{
																												config.configName
																											}
																										</span>
																										{config.isSystemServer && (
																											<Badge
																												variant="secondary"
																												className="text-xs"
																											>
																												System
																											</Badge>
																										)}
																									</div>
																								</DropdownMenuItem>
																							),
																						)}
																					</DropdownMenuContent>
																				</DropdownMenu>
																			)}
																		</div>
																	) : (
																		<Button
																			variant="outline"
																			size="sm"
																			className="border-border text-foreground hover:bg-muted"
																			asChild
																		>
																			<Link
																				href={`${mcpServersUrl}?search=${key}`}
																			>
																				<PlusIcon className="h-4 w-4 mr-1" />
																				Add
																				Connection
																			</Link>
																		</Button>
																	)}
																</div>
															</div>
														);
													},
												)}
											</div>

											{hasAllRequiredMcpServers && (
												<p className="mt-4 text-sm text-success flex items-center gap-2">
													<CheckCircle2Icon className="h-4 w-4" />
													All required MCP
													integrations are configured!
												</p>
											)}
										</section>
									)}

								{/* Section 2: Knowledge & Tools */}
								<section>
									<div className="mb-4 flex items-start justify-between">
										<div>
											<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
												<span className="inline-block h-3 w-px bg-[--mkt-red]" />
												Step 2
											</p>
											<h3 className="text-base font-semibold">
												Knowledge & Tools
											</h3>
											<p className="mt-0.5 text-sm text-muted-foreground">
												Connect knowledge sources and
												tools to enhance your
												agent&apos;s abilities.
											</p>
										</div>
									</div>

									<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
										{/* ── Searchable knowledge card ── */}
										<div className="flex flex-col rounded-xl border border-border bg-card">
											<div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
												<div className="flex items-center gap-2.5">
													<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
														<Square3Stack3DIcon className="h-3.5 w-3.5 text-primary" />
													</div>
													<div>
														<h4 className="text-sm font-semibold">
															Knowledge
														</h4>
														<p className="text-xs text-muted-foreground">
															Workspaces &
															integrations
														</p>
													</div>
												</div>
												<div className="flex items-center gap-1.5">
													{selectedWorkspaces.length >
														0 && (
														<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
															{
																selectedWorkspaces.length
															}
														</span>
													)}
													<Button
														variant="outline"
														size="sm"
														className="h-7 gap-1 px-2.5 text-xs"
														onClick={() =>
															setWorkspacesSheetOpen(
																true,
															)
														}
													>
														<PlusIcon className="h-3 w-3" />
														Add
													</Button>
												</div>
											</div>

											<div className="flex-1 p-3">
												{selectedWorkspaces.length >
												0 ? (
													<div className="space-y-1.5">
														{selectedWorkspaces.map(
															(workspace) => (
																<div
																	key={
																		workspace.id
																	}
																	className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2"
																>
																	<Square3Stack3DIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
																	<span className="flex-1 truncate text-sm">
																		{
																			workspace.name
																		}
																	</span>
																	{workspace.documentCount >
																		0 && (
																		<span className="shrink-0 text-xs text-muted-foreground">
																			{
																				workspace.documentCount
																			}{" "}
																			docs
																		</span>
																	)}
																	<Button
																		variant="ghost"
																		size="icon"
																		type="button"
																		className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
																		onClick={() =>
																			setSelectedDataSources(
																				selectedDataSources.filter(
																					(
																						id,
																					) =>
																						id !==
																						workspace.id,
																				),
																			)
																		}
																	>
																		<XIcon className="h-3 w-3" />
																	</Button>
																</div>
															),
														)}
													</div>
												) : (
													<div className="rounded-xl border border-dashed border-border p-4 text-center">
														<Square3Stack3DIcon className="mx-auto mb-2 h-5 w-5 text-muted-foreground/30" />
														<p className="text-xs text-muted-foreground">
															No searchable
															knowledge added yet
														</p>
														<button
															type="button"
															className="mt-1.5 text-xs text-primary hover:underline"
															onClick={() =>
																setWorkspacesSheetOpen(
																	true,
																)
															}
														>
															Browse workspaces →
														</button>
													</div>
												)}
											</div>
											<div className="border-t border-border/60 px-3 py-2.5">
												<button
													type="button"
													className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
													onClick={() =>
														setDataSourcesSheetOpen(
															true,
														)
													}
												>
													<GlobeIcon className="h-3.5 w-3.5 shrink-0" />
													<span>
														Connect external sources
													</span>
													<span className="text-muted-foreground/50">
														(Notion, Drive,
														Confluence…)
													</span>
													<span className="ml-auto text-muted-foreground/60">
														→
													</span>
												</button>
											</div>
										</div>

										{/* ── Capabilities card ── */}
										<div className="flex flex-col rounded-xl border border-border bg-card">
											<div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
												<div className="flex items-center gap-2.5">
													<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary/10">
														<McpLogo size={14} />
													</div>
													<div>
														<h4 className="text-sm font-semibold">
															Capabilities
														</h4>
														<p className="text-xs text-muted-foreground">
															Skills and tools
															available to this
															agent
														</p>
													</div>
												</div>
												<div className="flex items-center gap-1.5">
													{selectedTools.length +
														selectedSkillIds.length >
														0 && (
														<span className="rounded-full bg-secondary/10 px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
															{selectedTools.length +
																selectedSkillIds.length}
														</span>
													)}
													<Button
														variant="outline"
														size="sm"
														className="h-7 gap-1 px-2.5 text-xs"
														onClick={() =>
															setToolsSheetOpen(
																true,
															)
														}
													>
														<PlusIcon className="h-3 w-3" />
														Add capabilities
													</Button>
												</div>
											</div>

											<div className="flex-1 p-3">
												{selectedTools.length > 0 ||
												selectedSkills.length > 0 ? (
													<div className="space-y-1.5">
														{selectedSkills.map(
															(skill) => (
																<div
																	key={
																		skill.id
																	}
																	className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2"
																>
																	<PuzzleIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
																	<span className="flex-1 truncate text-sm">
																		{
																			skill.name
																		}
																	</span>
																	<span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
																		Skill
																	</span>
																	<Button
																		variant="ghost"
																		size="icon"
																		type="button"
																		className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
																		onClick={() =>
																			setSelectedSkillIds(
																				(
																					ids,
																				) =>
																					ids.filter(
																						(
																							id,
																						) =>
																							id !==
																							skill.id,
																					),
																			)
																		}
																	>
																		<XIcon className="h-3 w-3" />
																	</Button>
																</div>
															),
														)}
														{selectedTools.map(
															(toolId) => {
																const config =
																	mcpConfigs.find(
																		(
																			c: any,
																		) =>
																			`mcp:${c.id}` ===
																			toolId,
																	);
																const toolName =
																	(
																		config as any
																	)
																		?.displayName ||
																	(
																		config as any
																	)?.mcpServer
																		?.name ||
																	getBuiltInCapability(
																		toolId,
																	)?.name ||
																	getToolDisplayName(
																		toolId,
																	);
																const isMcp =
																	toolId.startsWith(
																		"mcp:",
																	);
																const builtinIcon =
																	!isMcp
																		? getCapabilityIcon(
																				toolId,
																				"h-3.5 w-3.5 text-success shrink-0",
																			)
																		: null;
																return (
																	<div
																		key={
																			toolId
																		}
																		className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2"
																	>
																		{isMcp ? (
																			<ServerIcon className="h-3.5 w-3.5 shrink-0 text-success" />
																		) : (
																			builtinIcon
																		)}
																		<span className="flex-1 truncate text-sm">
																			{
																				toolName
																			}
																		</span>
																		<span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
																			Active
																		</span>
																		<Button
																			variant="ghost"
																			size="icon"
																			type="button"
																			className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
																			onClick={() =>
																				setSelectedTools(
																					selectedTools.filter(
																						(
																							t,
																						) =>
																							t !==
																							toolId,
																					),
																				)
																			}
																		>
																			<XIcon className="h-3 w-3" />
																		</Button>
																	</div>
																);
															},
														)}
													</div>
												) : (
													<div className="rounded-xl border border-dashed border-border p-4 text-center">
														<McpLogo
															size={20}
															className="mx-auto mb-2 opacity-30"
														/>
														<p className="text-xs text-muted-foreground">
															No capabilities
															added yet
														</p>
														<button
															type="button"
															className="mt-1.5 text-xs text-primary hover:underline"
															onClick={() =>
																setToolsSheetOpen(
																	true,
																)
															}
														>
															Browse capabilities
															→
														</button>
													</div>
												)}
											</div>
										</div>
									</div>
								</section>

								{/* Section 4: Triggers */}
								<section>
									<div className="mb-4 flex items-start justify-between">
										<div>
											<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
												<span className="inline-block h-3 w-px bg-[--mkt-red]" />
												Optional
											</p>
											<h3 className="flex items-center gap-2 text-base font-semibold">
												<ZapIcon className="h-[18px] w-[18px] text-primary" />
												Triggers
											</h3>
											<p className="mt-0.5 text-sm text-muted-foreground">
												Automate this agent based on
												events.
											</p>
										</div>
										<Button
											variant="outline"
											size="sm"
											className="mt-1 shrink-0 gap-1.5"
											onClick={() =>
												setTriggersSheetOpen(true)
											}
										>
											<SettingsIcon className="h-3.5 w-3.5" />
											Configure
										</Button>
									</div>

									{triggers.filter((t) => t.enabled).length >
									0 ? (
										<div className="space-y-2">
											{triggers
												.filter((t) => t.enabled)
												.map((trigger) => (
													<div
														key={trigger.type}
														className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
													>
														<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
															<ZapIcon className="h-3.5 w-3.5 text-primary" />
														</div>
														<div className="min-w-0 flex-1">
															<div className="text-sm font-medium capitalize">
																{trigger.type.replace(
																	/_/g,
																	" ",
																)}
															</div>
														</div>
														<Badge
															variant="secondary"
															className="shrink-0 text-xs"
														>
															Active
														</Badge>
													</div>
												))}
										</div>
									) : (
										<div className="rounded-xl border border-dashed border-border p-5 text-center">
											<ZapIcon className="mx-auto mb-2 h-5 w-5 text-muted-foreground/40" />
											<p className="text-sm text-muted-foreground">
												No triggers configured. The
												agent runs when manually
												invoked.
											</p>
										</div>
									)}
								</section>

								{/* Section 4: Settings */}
								<section>
									<div className="mb-4">
										<p className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
											<span className="inline-block h-3 w-px bg-[--mkt-red]" />
											Step 4
										</p>
										<h3 className="text-base font-semibold">
											Settings
										</h3>
									</div>

									<div className="space-y-5">
										{/* Name with category icon */}
										<div>
											<Label
												htmlFor="agent-name"
												className="text-sm font-medium mb-2 block"
											>
												Name
												<span className="ml-1 text-destructive">
													*
												</span>
											</Label>
											<div className="flex items-center gap-3">
												<div className="relative flex-1">
													<Input
														id="agent-name"
														value={name}
														onChange={(e) =>
															setName(
																e.target.value,
															)
														}
														className="h-11 rounded-xl border-border bg-muted/40 pr-10"
														placeholder={
															template.displayName
																? `e.g., ${template.displayName}`
																: "e.g., Customer Support Assistant"
														}
													/>
													<Button
														variant="ghost"
														size="icon"
														className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
														title="Generate with AI"
														onClick={
															handleGenerateName
														}
														disabled={
															isGeneratingName
														}
													>
														{isGeneratingName ? (
															<Loader2Icon className="h-4 w-4 animate-spin" />
														) : (
															<SparklesIcon className="h-4 w-4" />
														)}
													</Button>
												</div>

												{/* Category icon — not interactive, so the
													copy reaches pointer users through
													the tooltip and everyone else
													through the `sr-only` child. */}
												<Tooltip>
													<TooltipTrigger asChild>
														<div className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
															<CategoryIcon className="h-5 w-5 text-primary" />
															<span className="sr-only">
																{tooltipT(
																	"templateCategory",
																	{
																		category:
																			template.category,
																	},
																)}
															</span>
														</div>
													</TooltipTrigger>
													<TooltipContent>
														{tooltipT(
															"templateCategory",
															{
																category:
																	template.category,
															},
														)}
													</TooltipContent>
												</Tooltip>
											</div>
										</div>

										{/* Description */}
										<div>
											<Label
												htmlFor="agent-description"
												className="text-sm font-medium mb-2 block"
											>
												Description
												<span className="ml-1 text-destructive">
													*
												</span>
											</Label>
											<div className="relative">
												<Textarea
													id="agent-description"
													value={description}
													onChange={(e) =>
														setDescription(
															e.target.value,
														)
													}
													className="min-h-[80px] resize-none rounded-xl border-border bg-muted/40 pr-10"
													placeholder={
														descriptionPlaceholder ||
														"Explain what this agent does and when someone should use it."
													}
													rows={3}
												/>
												<Button
													variant="ghost"
													size="icon"
													className="absolute right-2 top-2 h-8 w-8"
													title="Generate with AI"
													onClick={
														handleGenerateDescription
													}
													disabled={isGeneratingDesc}
												>
													{isGeneratingDesc ? (
														<Loader2Icon className="h-4 w-4 animate-spin" />
													) : (
														<SparklesIcon className="h-4 w-4" />
													)}
												</Button>
											</div>
										</div>

										{/* Execution Mode */}
										<div>
											<Label className="text-sm font-medium mb-2 block">
												Execution Mode
											</Label>
											<div className="space-y-3">
												<div className="grid grid-cols-2 gap-1.5 rounded-xl border border-border bg-muted/40 p-1.5">
													<button
														type="button"
														className={cn(
															"flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
															executionMode ===
																"single_turn"
																? "bg-card shadow-sm ring-1 ring-border/60"
																: "hover:bg-muted/60",
														)}
														onClick={() =>
															setExecutionMode(
																"single_turn",
															)
														}
													>
														<div
															className={cn(
																"flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
																executionMode ===
																	"single_turn"
																	? "bg-primary/10"
																	: "bg-muted",
															)}
														>
															<RobotIcon
																className={cn(
																	"h-4 w-4 transition-colors",
																	executionMode ===
																		"single_turn"
																		? "text-primary"
																		: "text-muted-foreground",
																)}
															/>
														</div>
														<div>
															<div
																className={cn(
																	"text-sm font-medium transition-colors",
																	executionMode ===
																		"single_turn"
																		? "text-foreground"
																		: "text-muted-foreground",
																)}
															>
																Single Turn
															</div>
															<div className="text-xs text-muted-foreground">
																Simple Q&amp;A
															</div>
														</div>
													</button>
													<button
														type="button"
														className={cn(
															"flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
															executionMode ===
																"goal_oriented"
																? "bg-card shadow-sm ring-1 ring-border/60"
																: "hover:bg-muted/60",
														)}
														onClick={() =>
															setExecutionMode(
																"goal_oriented",
															)
														}
													>
														<div
															className={cn(
																"flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
																executionMode ===
																	"goal_oriented"
																	? "bg-secondary/10"
																	: "bg-muted",
															)}
														>
															<RocketIcon
																className={cn(
																	"h-4 w-4 transition-colors",
																	executionMode ===
																		"goal_oriented"
																		? "text-secondary-foreground"
																		: "text-muted-foreground",
																)}
															/>
														</div>
														<div>
															<div
																className={cn(
																	"text-sm font-medium transition-colors",
																	executionMode ===
																		"goal_oriented"
																		? "text-foreground"
																		: "text-muted-foreground",
																)}
															>
																Goal Oriented
															</div>
															<div className="text-xs text-muted-foreground">
																Multi-step tasks
															</div>
														</div>
													</button>
												</div>

												{/* Goal input - shown when goal_oriented is selected */}
												{executionMode ===
													"goal_oriented" && (
													<div className="space-y-4 rounded-xl border border-secondary/20 bg-secondary/5 p-4">
														<div>
															<Label
																htmlFor="agent-goal"
																className="mb-2 block text-sm font-medium"
															>
																Goal
															</Label>
															<Textarea
																id="agent-goal"
																value={goal}
																onChange={(e) =>
																	setGoal(
																		e.target
																			.value,
																	)
																}
																className="min-h-[80px] resize-none rounded-xl border-border bg-background"
																placeholder="Describe the goal this agent should achieve, e.g., 'Analyze customer feedback and generate a summary report with key insights and recommendations'"
																rows={3}
															/>
															<p className="mt-1 text-xs text-muted-foreground">
																The agent will
																iteratively
																plan, execute,
																and verify until
																this goal is
																achieved.
															</p>
														</div>

														<div>
															<Label
																htmlFor="max-iterations"
																className="mb-2 block text-sm font-medium"
															>
																Max Iterations:{" "}
																{maxIterations}
															</Label>
															<input
																id="max-iterations"
																type="range"
																min={1}
																max={50}
																value={
																	maxIterations
																}
																onChange={(e) =>
																	setMaxIterations(
																		Number(
																			e
																				.target
																				.value,
																		),
																	)
																}
																className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
															/>
															<div className="mt-1 flex justify-between text-xs text-muted-foreground">
																<span>1</span>
																<span>
																	Max attempts
																	before
																	stopping
																</span>
																<span>50</span>
															</div>
														</div>
													</div>
												)}
											</div>
										</div>

										{/* External API Access - only in edit mode */}
										{isEditMode && instanceId && (
											<div>
												<Label className="text-sm font-medium mb-2 block">
													External API Access
												</Label>
												<div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
													<div className="flex items-center justify-between">
														<div>
															<p className="text-sm font-medium">
																Expose via API
															</p>
															<p className="text-xs text-muted-foreground">
																Allow external
																systems to
																execute this
																agent
															</p>
														</div>
														<Switch
															checked={
																isApiExposed
															}
															onCheckedChange={
																setIsApiExposed
															}
														/>
													</div>
													{isApiExposed ? (
														<div className="space-y-2">
															<p className="text-xs text-muted-foreground">
																Endpoint URL
															</p>
															<div className="flex items-center gap-2">
																<code className="flex-1 text-xs bg-background px-3 py-2 rounded-md break-all border border-border">
																	{typeof window !==
																	"undefined"
																		? `${window.location.origin}/api/v1/external/agents/${apiIdentifier}/execute`
																		: `/api/v1/external/agents/${apiIdentifier}/execute`}
																</code>
																<Button
																	variant="outline"
																	size="icon"
																	className="shrink-0"
																	onClick={() => {
																		const url = `${window.location.origin}/api/v1/external/agents/${apiIdentifier}/execute`;
																		navigator.clipboard.writeText(
																			url,
																		);
																		toast.success(
																			"URL copied to clipboard",
																		);
																	}}
																>
																	<CopyIcon className="h-4 w-4" />
																</Button>
															</div>
															<p className="text-xs text-muted-foreground">
																Requires an API
																key (
																<code className="text-xs">
																	fab_*
																</code>{" "}
																or{" "}
																<code className="text-xs">
																	org_*
																</code>
																) in the{" "}
																<code className="text-xs">
																	Authorization:
																	Bearer
																</code>{" "}
																header.
															</p>
														</div>
													) : (
														<p className="text-xs text-muted-foreground">
															Enable to allow this
															agent to be executed
															via the external
															REST API.
														</p>
													)}
												</div>
											</div>
										)}
									</div>
								</section>
							</div>
						</div>

						{/* Right Panel: Sidekick + Guide */}
						<div className="sticky top-[53px] flex h-[calc(100vh-53px)] w-[346px] shrink-0 flex-col border-l border-border bg-card/50">
							{/* Tab bar */}
							<div className="flex border-b border-border/60">
								<button
									type="button"
									onClick={() => setRightPanelTab("sidekick")}
									className={cn(
										"flex-1 px-4 py-2.5 text-sm font-medium transition-colors",
										rightPanelTab === "sidekick"
											? "border-b-2 border-primary text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									Sidekick
								</button>
								<button
									type="button"
									onClick={() => setRightPanelTab("guide")}
									className={cn(
										"flex-1 px-4 py-2.5 text-sm font-medium transition-colors",
										rightPanelTab === "guide"
											? "border-b-2 border-primary text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									Guide
								</button>
							</div>

							{/* Tab content */}
							<div className="flex-1 overflow-hidden">
								{rightPanelTab === "sidekick" ? (
									<AgentBuilderSidekick
										agentId={effectiveAgentId}
										entityType={sidekickEntityType}
									/>
								) : (
									<div
										className="overflow-y-auto"
										style={{
											height: "calc(100vh - 170px)",
										}}
									>
										{/* Header */}
										<div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
											<div>
												<p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
													<span className="inline-block h-3 w-px bg-[--mkt-red]" />
													Guidance
												</p>
												<h3 className="flex items-center gap-1.5 text-sm font-semibold">
													<LightbulbIcon className="h-3.5 w-3.5 text-[--mkt-red]" />
													Agent Setup Guide
												</h3>
											</div>
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														variant="ghost"
														size="sm"
														className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
													>
														Reset
														<ChevronDownIcon className="h-3 w-3" />
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														onClick={() => {
															setInstructions(
																getDefaultInstructions(),
															);
															setName(
																getDefaultName(),
															);
															setDescription(
																getDefaultDescription(),
															);
															setSelectedDataSources(
																initialDataSources,
															);
															setPinnedDatabricksIntegrationId(
																initialDatabricksIntegrationId,
															);
															setKnowledgeResources(
																initialKnowledgeResources,
															);
															setSelectedTools(
																initialTools,
															);
															setSelectedSkillIds(
																initialSkillIds,
															);
															setTriggers(
																initialTriggers,
															);
															setExecutionMode(
																initialExecutionMode,
															);
															setGoal(
																initialGoal,
															);
															setMaxIterations(
																initialMaxIterations,
															);
														}}
													>
														Reset to template
														defaults
													</DropdownMenuItem>
													<DropdownMenuItem
														onClick={() => {
															setInstructions("");
															setName("");
															setDescription("");
														}}
													>
														Clear all
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</div>

										<div className="space-y-0 divide-y divide-border/60">
											{/* ── 1. Setup checklist ── */}
											<div className="px-5 py-4">
												<p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
													Setup checklist
												</p>
												<ul className="space-y-2">
													{[
														{
															label: "Agent name",
															done:
																name.trim()
																	.length > 0,
															required: true,
															hint: "Give it a clear, recognisable name",
														},
														{
															label: "Instructions written",
															done:
																instructions.trim()
																	.length >
																30,
															required: true,
															hint: "Be specific — context beats brevity",
														},
														{
															label: "Knowledge source",
															done:
																selectedDataSources.length >
																0,
															required: false,
															hint: "Connect a workspace or integration",
														},
														{
															label: "Tools (MCP)",
															done:
																selectedTools.length >
																0,
															required: false,
															hint: "Add MCP servers to extend capabilities",
														},
													].map(
														({
															label,
															done,
															required,
															hint,
														}) => (
															<li
																key={label}
																className="flex items-start gap-2.5"
															>
																<div
																	className={cn(
																		"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors",
																		done
																			? "bg-primary/15 text-primary"
																			: required
																				? "border border-border bg-background"
																				: "border border-dashed border-border/50 bg-background",
																	)}
																>
																	{done && (
																		<CheckIcon className="h-2.5 w-2.5 text-primary" />
																	)}
																</div>
																<div className="min-w-0 flex-1">
																	<div className="flex items-center gap-1.5">
																		<span
																			className={cn(
																				"text-xs font-medium",
																				done
																					? "text-foreground line-through decoration-muted-foreground/40"
																					: "text-foreground",
																			)}
																		>
																			{
																				label
																			}
																		</span>
																		{!required && (
																			<span className="text-[10px] text-muted-foreground/60">
																				optional
																			</span>
																		)}
																	</div>
																	{!done && (
																		<p className="mt-0.5 text-[11px] text-muted-foreground">
																			{
																				hint
																			}
																		</p>
																	)}
																</div>
															</li>
														),
													)}
												</ul>
											</div>

											{/* ── 2. Template tips ── */}
											{/* ── 3. Writing good instructions ── */}
											<div className="px-5 py-4">
												<p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
													Writing good instructions
												</p>
												<ul className="space-y-3">
													{[
														{
															title: "Set context first",
															body: "Open with who the agent is and what it’s for. One clear paragraph beats five vague ones.",
														},
														{
															title: "Give examples",
															body: "Show the format you expect. “Respond like this: …” is far more effective than “be concise”.",
														},
														{
															title: "Define the boundaries",
															body: "Explicitly list what the agent should not do to prevent drift.",
														},
													].map(({ title, body }) => (
														<li key={title}>
															<p className="text-xs font-semibold text-foreground">
																{title}
															</p>
															<p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
																{body}
															</p>
														</li>
													))}
												</ul>
											</div>

											{/* ── 4. Ready to test callout ── */}
											<div className="px-5 py-4">
												<div className="rounded-xl bg-muted/60 p-3.5">
													<p className="mb-1 text-xs font-semibold text-foreground">
														After you create
													</p>
													<p className="text-[11px] leading-relaxed text-muted-foreground">
														Chat with your agent
														immediately. Start
														simple, then push edge
														cases. Refine the
														instructions based on
														where it gets confused.
													</p>
												</div>
											</div>
										</div>
									</div>
								)}
							</div>
						</div>
					</div>
				</div>

				{/* Workspaces Sheet (for MCP-based templates) */}
				<WorkspacesSheet
					open={workspacesSheetOpen}
					onOpenChange={setWorkspacesSheetOpen}
					organizationId={organizationId}
					selectedWorkspaceIds={selectedDataSources}
					onSelectionChange={setSelectedDataSources}
					documentFilters={workspaceDocumentFilters}
					onDocumentFiltersChange={setWorkspaceDocumentFilters}
				/>

				{/* Data Sources Sheet (for non-MCP templates) */}
				<DataSourcesSheet
					open={dataSourcesSheetOpen}
					onOpenChange={setDataSourcesSheetOpen}
					organizationId={organizationId}
					selectedSourceIds={selectedDataSources}
					onSelectionChange={applySelectedDataSources}
					knowledgeResources={knowledgeResources}
					onKnowledgeResourcesChange={setKnowledgeResources}
					databricksIntegrationId={pinnedDatabricksIntegrationId}
				/>

				{/* Tools Sheet */}
				<ToolsSheet
					open={toolsSheetOpen}
					onOpenChange={setToolsSheetOpen}
					organizationId={organizationId}
					selectedTools={selectedTools}
					onSelectionChange={setSelectedTools}
					selectedSkillIds={selectedSkillIds}
					onSkillSelectionChange={setSelectedSkillIds}
					availableSkills={catalogSkills}
					suggestedTools={[]}
					toolConfigs={toolConfigs}
					onToolConfigsChange={setToolConfigs}
				/>

				{/* Triggers Sheet */}
				<TriggersSheet
					open={triggersSheetOpen}
					onOpenChange={setTriggersSheetOpen}
					triggers={triggers}
					onTriggersChange={setTriggers}
					configuredIntegrations={configuredIntegrations.map(
						(i) => i.provider,
					)}
					integrationsUrl={integrationsSettingsUrl}
					organizationId={organizationId ?? null}
				/>
			</SidekickFormProvider>
		</SidekickSuggestionsProvider>
	);
}
