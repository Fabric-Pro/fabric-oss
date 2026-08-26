"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import {
	findMatchingMcpConfigs,
	getMcpConfigDisplayName,
	normalizeKey,
} from "@saas/reports/lib/mcp-utils";
import {
	humanizeReportError,
	type ReportErrorContext,
} from "@saas/reports/lib/report-error-messages";
import { computeReportReadiness } from "@saas/reports/lib/report-readiness";
import {
	type ReportInstanceTab,
	resolveActiveReportTab,
} from "@saas/reports/lib/resolve-active-report-tab";
import {
	OPERATION_PARAMS,
	PROVIDER_CONTEXT_FIELDS,
} from "@saas/shared/components/DataSourceDefinitionBuilder";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@ui/components/accordion";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Separator } from "@ui/components/separator";
import { Switch } from "@ui/components/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	BrainCircuitIcon,
	CalendarClockIcon,
	CheckIcon,
	ChevronDownIcon,
	CodeIcon,
	DownloadIcon,
	ExpandIcon,
	EyeIcon,
	FileTextIcon,
	HistoryIcon,
	LayoutListIcon,
	Loader2Icon,
	Minimize2Icon,
	PencilIcon,
	PlayIcon,
	SaveIcon,
	SendIcon,
	ServerIcon,
	SettingsIcon,
	SparklesIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { type AiTask, AiTaskPromptEditor } from "./AiTaskPromptEditor";
import { ArtifactDeliveryHistoryDialog } from "./ArtifactDeliveryHistoryDialog";
import { CancelExecutionButton } from "./CancelExecutionButton";
import {
	DataSourceConfigGrid,
	DataSourceConfigTile,
	type ConnectionBinding as TileConnectionBinding,
} from "./DataSourceConfigTile";
import type { ConnectionOption, ResourceOption } from "./DataSourceTile";
import { ExecutionStatusBadge } from "./ExecutionStatusBadge";
import { InfoHint } from "./InfoHint";
import {
	getIntegrationTypeFromDataSource,
	IntegrationSetupGuide,
	type IntegrationType,
} from "./IntegrationSetupGuide";
import { ReportConfigBanner } from "./ReportConfigBanner";
import { ReportReadinessRail } from "./ReportReadinessRail";
import { RunDiagnosticsPanel } from "./RunDiagnosticsPanel";
import { SendArtifactEmailDialog } from "./SendArtifactEmailDialog";
import {
	type ParameterSchema,
	SmartParameterInput,
} from "./SmartParameterInput";
import type {
	ScheduleFrequency,
	ScheduleMode,
} from "./schedule-update-builder";
import { buildScheduleUpdate } from "./schedule-update-builder";

// Computed once at module load — ~600 entries, no need to reallocate every render.
// Feature-detected: Intl.supportedValuesOf is ES2022+; on an older runtime fall back to
// an empty list rather than throwing at module load (the stored timezone is still shown
// via the prepend-if-absent path below).
const TIMEZONE_OPTIONS: string[] =
	typeof Intl.supportedValuesOf === "function"
		? Intl.supportedValuesOf("timeZone")
		: [];

type RequiredDataSource = {
	key: string;
	name: string;
	description?: string;
	required: boolean;
};

type ConnectionBinding = {
	type: "mcp" | "integration";
	id: string;
	// Optional resource selection (board, channel, repo, etc.)
	resourceId?: string;
	resourceName?: string;
	resourceType?: string;
};

type FetchedResource = {
	id: string;
	name: string;
	description?: string | null;
	metadata?: Record<string, unknown> | null;
};

type FetchedResourceGroup = {
	resourceType: string;
	items: FetchedResource[];
};

type Props = {
	instanceId: string;
	organizationId?: string;
	basePath?: string;
};

/**
 * Surface a report error as plain-language, persistent (manually-dismissed)
 * copy — never the raw server `error.message`. Connection/generation failures
 * are actionable and must not auto-dismiss before the user can read and act on
 * them.
 */
function showReportError(
	raw: string | undefined | null,
	ctx: ReportErrorContext,
) {
	toast.error(humanizeReportError(raw, ctx), {
		duration: Number.POSITIVE_INFINITY,
		closeButton: true,
	});
}

export function TemplateInstanceDetail({
	instanceId,
	organizationId,
	basePath = "/app/report-templates",
}: Props) {
	const tTooltips = useTranslations("tooltips.reports");
	const router = useRouter();

	// Viewer identity + org role — gate the per-execution Cancel control (R11):
	// the run's owner, or an admin/owner of its organization, may cancel it.
	const { user } = useSession();
	const { isOrganizationAdmin } = useActiveOrganization();

	// Settings URL based on context - uses hook to get correct path
	const _integrationsSettingsUrl = useContextPath("settings/integrations");
	// Used by the connection issue banner's "Reconnect" action.
	const mcpSettingsUrl = useContextPath("settings/mcp");

	const {
		data: instance,
		isLoading,
		refetch,
	} = useQuery(
		orpc.reports.instances.get.queryOptions({
			input: { id: instanceId, organizationId },
		}),
	);

	// Use the instance's organizationId for fetching related data
	// This ensures we fetch MCP configs from the correct tenant context
	// Important: MUST be string | null, never undefined
	// (undefined falls back to session, which can cause tenant isolation issues)
	const instanceOrgId: string | null = instance
		? (instance.organizationId ?? null) // Loaded: use its context (null = personal)
		: (organizationId ?? null); // Loading: use page context (convert undefined to null)

	// Fetch user's MCP configs and integrations for editing
	const { data: mcpConfigsData } = useQuery(
		orpc.mcp.configs.list.queryOptions({
			input: { organizationId: instanceOrgId },
		}),
	);

	const { data: integrationsData } = useQuery(
		orpc.workflows.integrations.list.queryOptions({
			input: { organizationId: instanceOrgId },
		}),
	);

	// Fetch inherited template skills (read-only display)
	const { data: templateSkillsData } = useQuery({
		...orpc.reports.templates.skills.list.queryOptions({
			input: {
				templateId: instance?.template.id ?? "",
				organizationId: instanceOrgId,
			},
		}),
		enabled: !!instance?.template.id,
	});
	const inheritedSkills = templateSkillsData?.skills ?? [];

	// MCP configs API returns array directly, integrations returns { integrations: [] }
	const userMcpConfigs = Array.isArray(mcpConfigsData)
		? mcpConfigsData
		: (mcpConfigsData?.configs ?? []);
	const userIntegrations = integrationsData?.integrations ?? [];

	// Config ids the user can actually access in this tenant context — the SAME
	// set the backend validates against (listMcpConfigsForTenant / getMcpConfigById).
	// A bound data source whose config id isn't here no longer resolves: a run
	// fails fast with CONFIG_NOT_FOUND and a save is rejected with "No access to
	// MCP config". We use it to show "Reconnect required" instead of a misleading
	// "Connected". Gated on the configs query having loaded so a valid binding
	// doesn't flash "unavailable" before the list arrives.
	const mcpConfigsLoaded = mcpConfigsData !== undefined;
	const accessibleConfigIds = useMemo(
		() => (userMcpConfigs as Array<{ id: string }>).map((c) => c.id),
		[userMcpConfigs],
	);
	const accessibleConfigIdSet = useMemo(
		() => new Set(accessibleConfigIds),
		[accessibleConfigIds],
	);

	// State for editing bindings
	const [bindings, setBindings] = useState<Record<string, ConnectionBinding>>(
		{},
	);
	// State for data source operation parameters (project, team, iteration, etc.)
	const [dataSourceParams, setDataSourceParams] = useState<
		Record<string, Record<string, string>>
	>({});
	const [hasChanges, setHasChanges] = useState(false);

	// Scheduling state
	const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("INHERITED");
	const [scheduleFrequency, setScheduleFrequency] =
		useState<ScheduleFrequency>("weekly");
	const [scheduleDayOfWeek, setScheduleDayOfWeek] = useState(1);
	const [scheduleDayOfMonth, setScheduleDayOfMonth] = useState(1);
	const [scheduleHour, setScheduleHour] = useState(9);
	const [scheduleMinute, setScheduleMinute] = useState(0);
	const [scheduleTimezone, setScheduleTimezone] = useState("UTC");
	const [scheduleDirty, setScheduleDirty] = useState(false);
	const [tzPopoverOpen, setTzPopoverOpen] = useState(false);

	// State for instance settings
	const [instanceName, setInstanceName] = useState("");
	const [instanceDescription, setInstanceDescription] = useState("");

	// State for Fabric AI config override
	const [fabricStrategy, setFabricStrategy] = useState<string>("");
	const [fabricContext, setFabricContext] = useState<string>("");
	const [fabricPattern, setFabricPattern] = useState<string>("");
	const [fabricAutoDetect, setFabricAutoDetect] = useState<boolean>(true);

	// State for parameter defaults
	const [parameterDefaults, setParameterDefaults] = useState<
		Record<string, string>
	>({});

	// State for viewing report
	const [viewingArtifact, setViewingArtifact] = useState<{
		id: string;
		name: string;
		content: string;
	} | null>(null);
	const [loadingArtifact, setLoadingArtifact] = useState<string | null>(null);
	const [isViewerFullscreen, setIsViewerFullscreen] = useState(false);

	// State for artifact email send / delivery history dialogs. Exactly one of
	// (send | history) is "open" at a time per the popover/dialog pattern.
	const [artifactDialog, setArtifactDialog] = useState<{
		artifactId: string;
		artifactName: string;
		mode: "send" | "history";
	} | null>(null);

	// Active tab is derived from the `?tab` query param — the URL is the single
	// source of truth. Notification deep links carry an explicit tab
	// (failure → `?tab=history`, success → `?tab=overview`) and every tab change
	// writes `?tab` back via `goToTab`, so URL and view can never diverge — a
	// success notification reliably lands on Overview even after a manual History
	// click on the same instance.
	const searchParams = useSearchParams();
	const pathname = usePathname();
	const activeTab = resolveActiveReportTab(searchParams.get("tab"));

	const goToTab = useCallback(
		(tab: ReportInstanceTab) => {
			const params = new URLSearchParams(searchParams.toString());
			params.set("tab", tab);
			router.replace(`${pathname}?${params.toString()}`, {
				scroll: false,
			});
		},
		[router, pathname, searchParams],
	);

	// Refs so the issue banner can scroll the user straight to the card that
	// needs attention (connection problems / missing parameters).
	const connectionCardRef = useRef<HTMLDivElement>(null);
	const parametersCardRef = useRef<HTMLDivElement>(null);

	// State to force polling after execution starts
	const [executionInProgress, setExecutionInProgress] = useState(false);

	// State for AI prompt customization
	const [customAiTasks, setCustomAiTasks] = useState<Record<string, string>>(
		{},
	);

	// State for custom system prompt
	const [customSystemPrompt, setCustomSystemPrompt] = useState<string>("");

	// State for user prompt / instructions (from template or instance override)
	const [userPrompt, setUserPrompt] = useState<string>("");

	// State for max iterations
	const [maxIterations, setMaxIterations] = useState<number | undefined>(
		undefined,
	);

	// State for context values (project, team, etc. for AI-driven data gathering)
	const [contextValues, setContextValues] = useState<Record<string, string>>(
		{},
	);

	// State for fetched resources from MCP servers
	const [fetchedResources, setFetchedResources] = useState<
		Record<string, FetchedResourceGroup[]>
	>({});
	const [fetchingResourcesFor, setFetchingResourcesFor] = useState<
		string | null
	>(null);

	// Mutation to fetch resources from MCP servers
	const fetchResourcesMutation = useMutation({
		mutationFn: async (configId: string) => {
			return await orpcClient.mcp.resources.fetch({ configId });
		},
		onSuccess: (data, configId) => {
			if (data.success && data.resources) {
				setFetchedResources((prev) => ({
					...prev,
					[configId]: data.resources,
				}));
			}
			setFetchingResourcesFor(null);
		},
		onError: () => {
			setFetchingResourcesFor(null);
		},
	});

	// Fetch resources when an MCP connection is selected
	const fetchResourcesForConnection = (configId: string) => {
		if (!fetchedResources[configId] && fetchingResourcesFor !== configId) {
			setFetchingResourcesFor(configId);
			fetchResourcesMutation.mutate(configId);
		}
	};

	// Initialize all editable fields when instance loads.
	// Skip re-seeding while the user has unsaved edits: the page refetches the
	// instance every 2s during an active run, and without this guard each poll
	// would stomp in-progress edits. Still seeds on first load and re-syncs
	// after a save (both leave hasChanges === false).
	useEffect(() => {
		if (instance && !hasChanges) {
			// Initialize instance settings
			setInstanceName(instance.name);
			setInstanceDescription(instance.description || "");

			// Initialize connection bindings
			const conn = instance.connections as {
				mcpBindings?: Record<string, string>;
				integrationBindings?: Record<string, string>;
				resourceBindings?: Record<
					string,
					{
						resourceId: string;
						resourceName: string;
						resourceType: string;
					}
				>;
				parameterBindings?: Record<string, Record<string, string>>;
				context?: Record<string, string>;
			} | null;

			const initialBindings: Record<string, ConnectionBinding> = {};
			if (conn?.mcpBindings) {
				// Get template data sources to map data source IDs to provider keys
				const templateDataSources = (
					instance.template.definition as {
						dataSources?: Array<{
							id: string;
							provider?: string;
						}>;
					} | null
				)?.dataSources;

				for (const [key, id] of Object.entries(conn.mcpBindings)) {
					const resourceBinding = conn.resourceBindings?.[key];

					// Normalize key: if it's a data source ID (ds-xxx), convert to provider key
					let normalizedKey = key;
					if (key.startsWith("ds-") && templateDataSources) {
						const ds = templateDataSources.find(
							(d) => d.id === key,
						);
						if (ds?.provider) {
							normalizedKey = ds.provider;
						}
					}

					initialBindings[normalizedKey] = {
						type: "mcp",
						id,
						resourceId: resourceBinding?.resourceId,
						resourceName: resourceBinding?.resourceName,
						resourceType: resourceBinding?.resourceType,
					};
					// Fetch resources for existing MCP connections
					fetchResourcesForConnection(id);
				}
			}
			if (conn?.integrationBindings) {
				for (const [key, id] of Object.entries(
					conn.integrationBindings,
				)) {
					initialBindings[key] = { type: "integration", id };
				}
			}
			setBindings(initialBindings);

			// Initialize data source operation parameters (project, team, etc.)
			if (conn?.parameterBindings) {
				setDataSourceParams(conn.parameterBindings);
			}

			// Initialize context values (project, team for AI-driven gathering)
			if (conn?.context) {
				setContextValues(conn.context);
			}

			// Initialize user prompt from connections override or template definition
			const promptOverride = (conn as { promptOverride?: string } | null)
				?.promptOverride;
			const templateUserPrompt = (
				instance.template.definition as { userPrompt?: string } | null
			)?.userPrompt;
			setUserPrompt(promptOverride || templateUserPrompt || "");

			// Initialize max iterations from connections
			const savedMaxIterations = (
				conn as { maxIterations?: number } | null
			)?.maxIterations;
			setMaxIterations(savedMaxIterations);

			// Initialize parameter defaults
			const defaults = instance.parameterDefaults as Record<
				string,
				unknown
			> | null;
			if (defaults) {
				const stringDefaults: Record<string, string> = {};
				for (const [key, value] of Object.entries(defaults)) {
					stringDefaults[key] = String(value ?? "");
				}
				setParameterDefaults(stringDefaults);
			}

			// Initialize Fabric AI config from instance overrides
			const fabricConfig = instance.fabricConfig as {
				strategy?: string;
				context?: string;
				pattern?: string;
				enableAutoDetection?: boolean;
				customAiTasks?: Record<string, string>;
				customSystemPrompt?: string;
			} | null;
			if (fabricConfig) {
				setFabricStrategy(fabricConfig.strategy || "");
				setFabricContext(fabricConfig.context || "");
				setFabricPattern(fabricConfig.pattern || "");
				setFabricAutoDetect(fabricConfig.enableAutoDetection ?? true);
				if (fabricConfig.customAiTasks) {
					setCustomAiTasks(fabricConfig.customAiTasks);
				}
				if (fabricConfig.customSystemPrompt) {
					setCustomSystemPrompt(fabricConfig.customSystemPrompt);
				}
			}

			// Initialize scheduling state
			setScheduleMode(
				(instance.scheduleMode ?? "INHERITED") as ScheduleMode,
			);
			const s = instance.schedule as null | {
				frequency?: ScheduleFrequency;
				dayOfWeek?: number;
				dayOfMonth?: number;
				hour?: number;
				minute?: number;
				timezone?: string;
			};
			if (s) {
				if (s.frequency) {
					setScheduleFrequency(s.frequency);
				}
				if (typeof s.dayOfWeek === "number") {
					setScheduleDayOfWeek(s.dayOfWeek);
				}
				if (typeof s.dayOfMonth === "number") {
					setScheduleDayOfMonth(s.dayOfMonth);
				}
				if (typeof s.hour === "number") {
					setScheduleHour(s.hour);
				}
				if (typeof s.minute === "number") {
					setScheduleMinute(s.minute);
				}
				if (s.timezone) {
					setScheduleTimezone(s.timezone);
				}
			}
			setScheduleDirty(false);
		}
	}, [instance, hasChanges]);

	const updateMutation = useMutation(
		orpc.reports.instances.update.mutationOptions({
			onSuccess: () => {
				toast.success("Instance updated successfully");
				setHasChanges(false);
				refetch();
			},
			onError: (error) => {
				showReportError(error.message, "save");
			},
		}),
	);

	const executeMutation = useMutation(
		orpc.reports.instances.execute.mutationOptions({
			onSuccess: () => {
				toast.success("Report generation started!");
				// Start polling immediately
				setExecutionInProgress(true);
				refetch();
				// Switch to execution history tab to show the new execution
				goToTab("history");
			},
			onError: (error) => {
				showReportError(error.message, "generate");
			},
		}),
	);

	// Auto-refresh when there are running or pending executions
	const executions = instance?.executions || [];
	const hasActiveExecution = executions.some(
		(e) => e.status === "RUNNING" || e.status === "PENDING",
	);

	// Clear executionInProgress flag when we detect the execution is no longer active
	useEffect(() => {
		if (
			executionInProgress &&
			!hasActiveExecution &&
			executions.length > 0
		) {
			// Wait a tick to ensure the final state is rendered
			const timeout = setTimeout(
				() => setExecutionInProgress(false),
				1000,
			);
			return () => clearTimeout(timeout);
		}
	}, [executionInProgress, hasActiveExecution, executions.length]);

	useEffect(() => {
		// Poll when there's an active execution OR we just triggered an execution
		if (!hasActiveExecution && !executionInProgress) {
			return;
		}

		const interval = setInterval(() => {
			refetch();
		}, 2000); // Refresh every 2 seconds for faster feedback

		return () => clearInterval(interval);
	}, [hasActiveExecution, executionInProgress, refetch]);

	const deleteMutation = useMutation(
		orpc.reports.instances.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Instance deleted");
				router.push(basePath);
			},
			onError: (error) => {
				showReportError(error.message, "delete");
			},
		}),
	);

	const testConnections = useMutation({
		mutationFn: () =>
			orpcClient.reports.instances.testConnections({
				instanceId,
				organizationId: instanceOrgId,
			}),
		onSuccess: (res) => {
			const bad = res.diagnostics.filter(
				(d) => d.outcome !== "connected",
			);
			if (bad.length) {
				toast.warning(
					`${bad.length} data source${bad.length === 1 ? "" : "s"} need attention`,
				);
			} else {
				toast.success("All data sources connected");
			}
		},
		onError: (e) => showReportError(e.message, "test"),
	});

	const _handleBindingChange = (reqKey: string, value: string) => {
		if (!value) {
			setBindings((prev) => {
				const next = { ...prev };
				delete next[reqKey];
				return next;
			});
		} else {
			const [type, id] = value.split(":");
			setBindings((prev) => ({
				...prev,
				[reqKey]: { type: type as "mcp" | "integration", id },
			}));
			// Fetch resources for MCP connections
			if (type === "mcp") {
				fetchResourcesForConnection(id);
			}
		}
		setHasChanges(true);
	};

	const handleResourceChange = (
		reqKey: string,
		resourceId: string,
		resourceName: string,
		resourceType: string,
		resourceMetadata?: Record<string, unknown> | null,
	) => {
		setBindings((prev) => ({
			...prev,
			[reqKey]: {
				...prev[reqKey],
				resourceId,
				resourceName,
				resourceType,
			},
		}));

		// Auto-fill related parameters based on resource data
		// This is generic and works for any resource type (board, channel, repo, project, etc.)
		setParameterDefaults((prev) => {
			const updated = { ...prev };
			const templateParamKeys = Object.keys(
				templateParams?.properties || {},
			);

			for (const paramKey of templateParamKeys) {
				const paramLower = paramKey.toLowerCase();
				const resourceTypeLower = resourceType.toLowerCase();

				// Match patterns like "boardId", "channelId", "repoId", "projectId"
				if (
					paramLower === `${resourceTypeLower}id` ||
					paramLower === `${resourceTypeLower}_id`
				) {
					updated[paramKey] = resourceId;
					continue;
				}

				// Match patterns like "boardName", "channelName", "repoName", "projectName"
				if (
					paramLower === `${resourceTypeLower}name` ||
					paramLower === `${resourceTypeLower}_name`
				) {
					updated[paramKey] = resourceName;
					continue;
				}

				// Match patterns like "boardKey", "projectKey" - use id or metadata.key
				if (
					paramLower === `${resourceTypeLower}key` ||
					paramLower === `${resourceTypeLower}_key`
				) {
					const keyValue =
						resourceMetadata?.key ??
						resourceMetadata?.slug ??
						resourceId;
					updated[paramKey] = String(keyValue);
					continue;
				}

				// Match generic patterns using data source key (e.g., "fizzy" -> fizzyBoardId)
				const dataSourceKey = reqKey.toLowerCase();
				if (paramLower === `${dataSourceKey}${resourceTypeLower}id`) {
					updated[paramKey] = resourceId;
					continue;
				}
				if (paramLower === `${dataSourceKey}${resourceTypeLower}name`) {
					updated[paramKey] = resourceName;
					continue;
				}

				// Try to match parameter with metadata fields
				if (resourceMetadata) {
					// Direct match: paramKey exists in metadata
					if (
						paramKey in resourceMetadata &&
						resourceMetadata[paramKey] != null
					) {
						updated[paramKey] = String(resourceMetadata[paramKey]);
						continue;
					}

					// Case-insensitive match in metadata
					const metadataKey = Object.keys(resourceMetadata).find(
						(k) => k.toLowerCase() === paramLower,
					);
					if (metadataKey && resourceMetadata[metadataKey] != null) {
						updated[paramKey] = String(
							resourceMetadata[metadataKey],
						);
						continue;
					}

					// Match common metadata patterns
					// e.g., "accountSlug" param could match "_accountSlug" in metadata
					const underscoreKey = Object.keys(resourceMetadata).find(
						(k) => k.toLowerCase().replace(/^_/, "") === paramLower,
					);
					if (
						underscoreKey &&
						resourceMetadata[underscoreKey] != null
					) {
						updated[paramKey] = String(
							resourceMetadata[underscoreKey],
						);
					}
				}
			}

			return updated;
		});

		setHasChanges(true);
	};

	const handleParameterChange = (key: string, value: string) => {
		setParameterDefaults((prev) => ({
			...prev,
			[key]: value,
		}));
		setHasChanges(true);
	};

	// Handle data source operation parameter changes (project, team, iteration)
	const handleDataSourceParamChange = (
		dataSourceKey: string,
		paramKey: string,
		value: string,
	) => {
		setDataSourceParams((prev) => ({
			...prev,
			[dataSourceKey]: {
				...prev[dataSourceKey],
				[paramKey]: value,
			},
		}));
		setHasChanges(true);
	};

	// Handle context value changes (project, team for AI-driven data gathering)
	const handleContextChange = (key: string, value: string) => {
		setContextValues((prev) => ({
			...prev,
			[key]: value,
		}));
		setHasChanges(true);
	};

	const handleSave = () => {
		const mcpBindings: Record<string, string> = {};
		const integrationBindings: Record<string, string> = {};
		const resourceBindings: Record<
			string,
			{ resourceId: string; resourceName: string; resourceType: string }
		> = {};

		for (const [key, binding] of Object.entries(bindings)) {
			if (binding.type === "mcp") {
				mcpBindings[key] = binding.id;
				// Include resource binding if selected
				if (
					binding.resourceId &&
					binding.resourceName &&
					binding.resourceType
				) {
					resourceBindings[key] = {
						resourceId: binding.resourceId,
						resourceName: binding.resourceName,
						resourceType: binding.resourceType,
					};
				}
			} else {
				integrationBindings[key] = binding.id;
			}
		}

		// Build fabric config if any values are set
		const hasCustomAiTasks = Object.keys(customAiTasks).length > 0;
		const hasCustomSystemPrompt = customSystemPrompt.trim().length > 0;
		const fabricConfig =
			fabricStrategy ||
			fabricContext ||
			fabricPattern ||
			!fabricAutoDetect ||
			hasCustomAiTasks ||
			hasCustomSystemPrompt
				? {
						strategy: fabricStrategy || undefined,
						context: fabricContext || undefined,
						pattern: fabricPattern || undefined,
						enableAutoDetection: fabricAutoDetect,
						customAiTasks: hasCustomAiTasks
							? customAiTasks
							: undefined,
						customSystemPrompt: hasCustomSystemPrompt
							? customSystemPrompt.trim()
							: undefined,
					}
				: undefined;

		// Filter out empty context values
		const filteredContext: Record<string, string> = {};
		for (const [key, value] of Object.entries(contextValues)) {
			if (value?.trim()) {
				filteredContext[key] = value.trim();
			}
		}

		const scheduleUpdate = buildScheduleUpdate({
			dirty: scheduleDirty,
			mode: scheduleMode,
			frequency: scheduleFrequency,
			dayOfWeek: scheduleDayOfWeek,
			dayOfMonth: scheduleDayOfMonth,
			hour: scheduleHour,
			minute: scheduleMinute,
			timezone: scheduleTimezone,
		});

		updateMutation.mutate({
			id: instanceId,
			organizationId: instanceOrgId,
			name: instanceName.trim() || undefined,
			description: instanceDescription.trim() || undefined,
			connections: {
				mcpConfigs: Object.values(mcpBindings),
				mcpBindings,
				integrations: Object.values(integrationBindings),
				integrationBindings,
				resourceBindings:
					Object.keys(resourceBindings).length > 0
						? resourceBindings
						: undefined,
				parameterBindings:
					Object.keys(dataSourceParams).length > 0
						? dataSourceParams
						: undefined,
				context:
					Object.keys(filteredContext).length > 0
						? filteredContext
						: undefined,
				promptOverride: userPrompt.trim() || undefined,
				maxIterations: maxIterations || undefined,
				workflows: [],
				agents: [],
				workspaces: [],
			},
			parameterDefaults:
				Object.keys(parameterDefaults).length > 0
					? parameterDefaults
					: undefined,
			fabricConfig,
			...(scheduleUpdate && { scheduleUpdate }),
		});
	};

	const handleNameChange = (value: string) => {
		setInstanceName(value);
		setHasChanges(true);
	};

	const handleDescriptionChange = (value: string) => {
		setInstanceDescription(value);
		setHasChanges(true);
	};

	const handleFabricChange = (
		field: "strategy" | "context" | "pattern",
		value: string,
	) => {
		if (field === "strategy") {
			setFabricStrategy(value);
		}
		if (field === "context") {
			setFabricContext(value);
		}
		if (field === "pattern") {
			setFabricPattern(value);
		}
		setHasChanges(true);
	};

	const handleFabricAutoDetectChange = (enabled: boolean) => {
		setFabricAutoDetect(enabled);
		setHasChanges(true);
	};

	const handleSystemPromptChange = (value: string) => {
		setCustomSystemPrompt(value);
		setHasChanges(true);
	};

	const handleExecute = () => {
		executeMutation.mutate({ instanceId, organizationId: instanceOrgId });
	};

	const handleDelete = () => {
		deleteMutation.mutate({
			id: instanceId,
			organizationId: instanceOrgId,
		});
	};

	const handleViewArtifact = async (
		artifactId: string,
		artifactName: string,
	) => {
		setLoadingArtifact(artifactId);
		try {
			const response = await fetch(
				`/api/reports/artifacts/${artifactId}/download`,
			);
			if (!response.ok) {
				throw new Error("Failed to fetch artifact");
			}
			const content = await response.text();
			setViewingArtifact({ id: artifactId, name: artifactName, content });
		} catch {
			toast.error("Failed to load report");
		} finally {
			setLoadingArtifact(null);
		}
	};

	// Helper: Check if a parameter is used in template sections
	const isUsedInTemplateOutput = (paramKey: string): boolean => {
		const sections = definition?.sections || [];
		return sections.some((s) => {
			if (s.type === "text" && typeof s.config?.template === "string") {
				return s.config.template.includes(`{{${paramKey}}}`);
			}
			return false;
		});
	};

	// Get template requirements (before conditional returns for hook consistency)
	// Template connections define what data sources the template NEEDS
	const templateConnections = instance?.template.connections as {
		mcpServers?: RequiredDataSource[];
		workflows?: string[];
		agents?: string[];
		workspaces?: { enabled: boolean };
		integrations?: RequiredDataSource[];
	} | null;

	// Combine MCP servers and integrations into a single list with source type
	const requiredMcpServers = (templateConnections?.mcpServers || []).map(
		(ds) => ({
			...ds,
			sourceType: "mcp" as const,
		}),
	);
	const requiredIntegrations = (templateConnections?.integrations || []).map(
		(ds) => ({
			...ds,
			sourceType: "integration" as const,
		}),
	);
	const requiredDataSources = [
		...requiredMcpServers,
		...requiredIntegrations,
	];

	// Check which data source categories the template requires
	const templateRequiresMcp = requiredMcpServers.length > 0;
	const templateRequiresWorkflows =
		(templateConnections?.workflows?.length ?? 0) > 0;
	const templateRequiresAgents =
		(templateConnections?.agents?.length ?? 0) > 0;
	const templateRequiresWorkspaces =
		templateConnections?.workspaces?.enabled === true;
	const templateRequiresIntegrations = requiredIntegrations.length > 0;
	const hasAnyDataSources =
		templateRequiresMcp ||
		templateRequiresWorkflows ||
		templateRequiresAgents ||
		templateRequiresWorkspaces ||
		templateRequiresIntegrations;

	// Get unique integration types from data sources for showing setup guides
	// Must be before conditional returns to maintain hook order
	const requiredIntegrationTypes = useMemo(() => {
		const types = new Set<IntegrationType>();
		for (const ds of requiredDataSources) {
			const intType = getIntegrationTypeFromDataSource(ds.key);
			if (intType) {
				types.add(intType);
			}
		}
		return Array.from(types);
	}, [requiredDataSources]);

	// Get template definition for display (declared early for context fields calculation)
	const definition = instance?.template.definition as {
		dataSources?: Array<{
			id: string;
			type: string;
			provider?: string;
			operation?: string;
			config?: Record<string, unknown>;
		}>;
		aiAgents?: Array<{
			agentId: string;
			task: string;
			outputVariable?: string;
		}>;
		sections?: Array<{
			id: string;
			title: string;
			type: string;
			config?: Record<string, unknown>;
		}>;
	} | null;

	// Get template parameters schema
	const templateParams = instance?.template.parameters as {
		required?: string[];
		properties?: Record<
			string,
			{ type: string; description?: string; default?: unknown }
		>;
	} | null;

	// MCP Config type for type safety
	type McpConfigItem = {
		id: string;
		displayName?: string | null;
		enabled: boolean;
		authType: string;
		encryptedApiKey?: string | null;
		encryptedAccessToken?: string | null;
		tokenExpiresAt?: string | Date | null;
		mcpServer?: {
			id: string;
			key?: string | null;
			name?: string | null;
		} | null;
	};

	// Check if MCP config has valid authentication
	const isMcpConfigAuthenticated = (config: McpConfigItem): boolean => {
		if (!config.enabled) {
			return false;
		}
		if (config.authType === "NONE") {
			return true;
		}
		if (config.authType === "API_KEY") {
			return !!config.encryptedApiKey;
		}
		if (config.authType === "OAUTH2") {
			if (!config.encryptedAccessToken) {
				return false;
			}
			if (config.tokenExpiresAt) {
				const expiresAt = new Date(config.tokenExpiresAt);
				return expiresAt > new Date();
			}
			return true;
		}
		return false;
	};

	// Find matching MCP configs for a required key (using shared utility)
	const getMatchingMcpConfigs = (key: string) => {
		return findMatchingMcpConfigs(userMcpConfigs as McpConfigItem[], key);
	};

	// A data source is "resolvable" when the report can connect to its STORED
	// connection as the running user (the bound config id is still accessible). The
	// self-heal fallback (match the server by key) is DISABLED for now — see
	// FABRIC_REPORTS_CONNECTION_SELF_HEAL in resolveReportMcpConfig — so a removed
	// connection is "unavailable" and surfaces as "Reconnect required" rather than
	// silently substituting another connection. Only meaningful once the configs
	// query has loaded — until then we never flag "unavailable" (avoids a false flash).
	const isDataSourceResolvable = (dsKey: string): boolean => {
		if (!mcpConfigsLoaded) {
			return true;
		}
		const b = bindings[dsKey];
		if (!b || b.type !== "mcp" || !b.id) {
			// Unbound or non-MCP: handled by the "not_configured" path, not here.
			return true;
		}
		// Stored config still resolves → connected. When re-enabling self-heal,
		// restore the fallback: `|| getMatchingMcpConfigs(dsKey).length > 0`.
		return accessibleConfigIdSet.has(b.id);
	};

	const findMatchingIntegrations = (key: string) => {
		const normalizedKey = normalizeKey(key);
		return userIntegrations.filter(
			(integration: {
				id: string;
				provider: string;
				name: string;
				isActive: boolean;
			}) =>
				normalizeKey(integration.provider) === normalizedKey ||
				normalizeKey(integration.name).includes(normalizedKey),
		);
	};

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	if (!instance) {
		return (
			<div className="text-center py-12">
				<p className="text-muted-foreground">Instance not found</p>
				<Button asChild variant="outline" className="mt-4">
					<Link href={basePath}>Back to Templates</Link>
				</Button>
			</div>
		);
	}

	const emoji = instance.template.heroEmojis?.[0] || "📊";

	// ── Readiness model ────────────────────────────────────────────────────────
	// One source of truth behind the issue banner, the connection status pill and
	// the readiness rail. Cheap + pure, so we compute it inline each render.
	const humanizeParamKey = (k: string) =>
		k
			.replace(/[_-]/g, " ")
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/\b\w/g, (c) => c.toUpperCase())
			.trim();
	const requiredParamKeys = templateParams?.required ?? [];
	// Recovery step 2: a required data source is connected, but its project/
	// resource hasn't been (re-)selected even though the connection offers
	// resources to pick — surfaces "re-select your project" guidance.
	const dataSourcesMissingProject = requiredDataSources
		.filter((d) => d.required)
		.filter((d) => {
			const b = bindings[d.key];
			if (b?.type !== "mcp" || !b.id || b.resourceId) {
				return false;
			}
			const groups = fetchedResources[b.id] ?? [];
			return groups.some((g) => g.items.length > 0);
		})
		.map((d) => d.name);

	const reportReadiness = computeReportReadiness({
		templateNeedsDataSource: hasAnyDataSources,
		requiredDataSources: requiredDataSources.map((d) => ({
			key: d.key,
			name: d.name,
			required: d.required,
		})),
		bindings,
		dataSourcesMissingProject,
		diagnostics: testConnections.data?.diagnostics,
		// Required data sources bound to a config that can't resolve for this user
		// (not the stored id, not a self-heal fallback) → surfaced as "Reconnect
		// required". Gated on the configs query so nothing flashes while loading.
		unresolvableDataSources: mcpConfigsLoaded
			? requiredDataSources
					.filter((d) => !isDataSourceResolvable(d.key))
					.map((d) => d.key)
			: undefined,
		requiredParams: requiredParamKeys.map((key) => {
			const def = templateParams?.properties?.[key]?.default;
			return {
				key,
				label: humanizeParamKey(key),
				value: parameterDefaults[key],
				hasDefault: def != null && def !== "",
			};
		}),
		skillsCount: inheritedSkills.length,
		outputFormat: instance.template.outputFormat,
		dataSourceLabel:
			requiredDataSources.map((d) => d.name).join(", ") ||
			instance.template.name,
	});

	const scrollToConnection = () =>
		connectionCardRef.current?.scrollIntoView({
			behavior: "smooth",
			block: "start",
		});
	const scrollToParameters = () =>
		parametersCardRef.current?.scrollIntoView({
			behavior: "smooth",
			block: "start",
		});

	const latestExecution = executions[0];

	return (
		<div className="space-y-6">
			{/* Config issue banner — surfaces any blocking problem up front */}
			<ReportConfigBanner
				readiness={reportReadiness}
				onTest={() => testConnections.mutate()}
				onScrollToConnection={scrollToConnection}
				onScrollToParams={scrollToParameters}
				reconnectHref={mcpSettingsUrl}
			/>

			{/* Header */}
			<div className="flex items-start justify-between">
				<div>
					<div className="flex items-center gap-2">
						<span className="text-2xl">{emoji}</span>
						<h1 className="text-2xl font-bold">{instance.name}</h1>
					</div>
					<p className="text-muted-foreground mt-1">
						{instance.template.description ||
							`Based on ${instance.template.name}`}
					</p>
				</div>
				<div className="flex items-center gap-2">
					{hasChanges && (
						<Button
							variant="outline"
							onClick={handleSave}
							disabled={updateMutation.isPending}
						>
							{updateMutation.isPending ? (
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<SaveIcon className="mr-2 h-4 w-4" />
							)}
							Save Changes
						</Button>
					)}
					<Button
						onClick={handleExecute}
						disabled={
							executeMutation.isPending ||
							reportReadiness.hardBlocked
						}
						title={
							reportReadiness.hardBlocked
								? reportReadiness.blockReason
								: undefined
						}
					>
						{executeMutation.isPending ? (
							<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<PlayIcon className="mr-2 h-4 w-4" />
						)}
						Generate Report
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => testConnections.mutate()}
						disabled={testConnections.isPending}
					>
						Test connections
					</Button>
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								disabled={deleteMutation.isPending}
								aria-label="Delete report instance"
							>
								<TrashIcon className="h-4 w-4 text-muted-foreground" />
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									Delete this report instance?
								</AlertDialogTitle>
								<AlertDialogDescription>
									This permanently deletes “{instance.name}”
									and its execution history. This can’t be
									undone.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									onClick={handleDelete}
									className="bg-destructive text-white hover:bg-destructive/90"
								>
									Delete instance
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			</div>

			{testConnections.data?.diagnostics &&
				testConnections.data.diagnostics.length > 0 && (
					<div className="rounded-md border bg-muted/30 p-3">
						<p className="mb-1 text-xs font-medium text-muted-foreground">
							Connection test
						</p>
						<RunDiagnosticsPanel
							diagnostics={
								testConnections.data.diagnostics as Parameters<
									typeof RunDiagnosticsPanel
								>[0]["diagnostics"]
							}
						/>
					</div>
				)}

			{/* Stats row */}
			<div className="flex gap-4 text-sm">
				{(() => {
					const latestExec = executions[0];
					const latestStatus = latestExec?.status;
					if (latestStatus === "PENDING") {
						return (
							<span className="text-muted-foreground flex items-center gap-1">
								<Loader2Icon className="h-3 w-3 animate-spin" />
								Queued
							</span>
						);
					}
					if (latestStatus === "RUNNING") {
						const startTime = latestExec?.startedAt;
						return (
							<span className="text-muted-foreground flex items-center gap-1">
								<Loader2Icon className="h-3 w-3 animate-spin" />
								{startTime
									? `Running now (started ${formatDistanceToNow(new Date(startTime), { addSuffix: true })})`
									: "Running now"}
							</span>
						);
					}
					const lastRun = instance.lastRunAt;
					if (lastRun) {
						return (
							<span className="text-muted-foreground">
								Last run{" "}
								{formatDistanceToNow(new Date(lastRun), {
									addSuffix: true,
								})}
							</span>
						);
					}
					return null;
				})()}
				{(instance.executionCount ?? 0) > 0 && (
					<Badge variant="secondary">
						{instance.executionCount} runs
					</Badge>
				)}
			</div>

			<Separator />

			{/* Tabbed Interface */}
			<Tabs
				value={activeTab}
				onValueChange={(value) =>
					goToTab(resolveActiveReportTab(value))
				}
				className="w-full"
			>
				<TabsList className="mb-4">
					<TabsTrigger value="overview" className="gap-2">
						<SettingsIcon className="h-4 w-4" />
						Overview
					</TabsTrigger>
					<TabsTrigger value="history" className="gap-2">
						<HistoryIcon className="h-4 w-4" />
						Execution History
						{(hasActiveExecution || executionInProgress) && (
							<Loader2Icon className="h-3 w-3 animate-spin ml-1" />
						)}
						{(instance.executionCount ?? 0) > 0 && (
							<Badge variant="secondary" className="ml-1 text-xs">
								{instance.executionCount}
							</Badge>
						)}
					</TabsTrigger>
				</TabsList>

				<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
					<div className="min-w-0 space-y-6">
						<TabsContent
							value="overview"
							className="mt-0 space-y-6"
						>
							{/* What This Report Will Generate - Primary Info Card */}
							<Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
								<CardHeader className="pb-3">
									<CardTitle className="flex items-center gap-2">
										<BrainCircuitIcon className="h-5 w-5 text-primary" />
										What This Report Will Generate
									</CardTitle>
									<CardDescription>
										{instance.template.description ||
											`Automated report based on ${instance.template.name}`}
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									{/* AI Analysis Task - The Main Purpose */}
									{definition?.aiAgents &&
										definition.aiAgents.length > 0 && (
											<div className="space-y-2">
												<h4 className="text-sm font-medium flex items-center gap-2">
													<SparklesIcon className="h-4 w-4 text-purple-500" />
													AI Analysis
												</h4>
												{definition.aiAgents.map(
													(agent, i) => (
														<div
															key={i}
															className="bg-background/80 border rounded-lg p-3"
														>
															<p className="text-sm text-muted-foreground whitespace-pre-wrap">
																{agent.task
																	.length >
																500
																	? `${agent.task.slice(0, 500)}...`
																	: agent.task}
															</p>
														</div>
													),
												)}
											</div>
										)}

									{/* Data Sources - Where Data Comes From */}
									{definition?.dataSources &&
										definition.dataSources.length > 0 && (
											<div className="space-y-2">
												<h4 className="text-sm font-medium flex items-center gap-2">
													<ServerIcon className="h-4 w-4 text-blue-500" />
													Data Sources
												</h4>
												<div className="flex flex-wrap gap-2">
													{definition.dataSources.map(
														(ds) => (
															<Badge
																key={ds.id}
																variant="secondary"
																className="text-xs"
															>
																{ds.type ===
																"integration"
																	? `${ds.provider || ds.id} API`
																	: ds.type ===
																			"mcp"
																		? `${(ds.config?.mcpServerKey as string) || "MCP"} → ${(ds.config?.toolName as string) || ds.id}`
																		: ds.id}
															</Badge>
														),
													)}
												</div>
											</div>
										)}

									{/* Output Sections - What Gets Generated */}
									{definition?.sections &&
										definition.sections.length > 0 && (
											<div className="space-y-2">
												<h4 className="text-sm font-medium flex items-center gap-2">
													<LayoutListIcon className="h-4 w-4 text-success" />
													Output Sections
												</h4>
												<div className="flex flex-wrap gap-2">
													{definition.sections.map(
														(section) => (
															<Badge
																key={section.id}
																variant="outline"
																className="text-xs"
															>
																{section.title}
																{section.type ===
																	"ai-generated" && (
																	<SparklesIcon className="h-3 w-3 ml-1 text-purple-500" />
																)}
															</Badge>
														),
													)}
												</div>
											</div>
										)}

									{/* Output Format */}
									<div className="flex items-center gap-2 pt-2 border-t">
										<span className="text-xs text-muted-foreground">
											Output:
										</span>
										<Badge
											variant="outline"
											className="text-xs"
										>
											{instance.template.outputFormat}
										</Badge>
									</div>
								</CardContent>
							</Card>

							{/* Inherited Skills */}
							{inheritedSkills.length > 0 && (
								<Card>
									<CardHeader className="pb-3">
										<CardTitle className="flex items-center gap-2 text-lg">
											<SparklesIcon className="h-5 w-5 text-highlight" />
											Skills
										</CardTitle>
										<CardDescription>
											Skills inherited from the template,
											injected into the AI system prompt
										</CardDescription>
									</CardHeader>
									<CardContent>
										<div className="space-y-2">
											{inheritedSkills.map((ts) => (
												<div
													key={ts.id}
													className="flex items-center justify-between p-3 rounded-lg border bg-amber-50/30 border-amber-200/50 dark:bg-amber-950/10 dark:border-amber-900/30"
												>
													<div className="flex items-center gap-3 min-w-0">
														<SparklesIcon className="h-4 w-4 text-highlight shrink-0" />
														<div className="min-w-0">
															<span className="font-medium text-sm block truncate">
																{ts.skill.name}
															</span>
															<span className="text-xs text-muted-foreground line-clamp-1">
																{
																	ts.skill
																		.description
																}
															</span>
														</div>
													</div>
													{ts.isRequired && (
														<Badge
															variant="outline"
															className="text-xs shrink-0"
														>
															Required
														</Badge>
													)}
												</div>
											))}
										</div>
									</CardContent>
								</Card>
							)}

							{/* Instance Settings */}
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<PencilIcon className="h-4 w-4" />
										Instance Settings
									</CardTitle>
									<CardDescription>
										Customize this report instance with your
										own name and description
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="space-y-2">
										<Label htmlFor="instance-name">
											Instance Name
										</Label>
										<Input
											id="instance-name"
											value={instanceName}
											onChange={(e) =>
												handleNameChange(e.target.value)
											}
											placeholder="Enter a name for this report instance..."
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="instance-description">
											Description (optional)
										</Label>
										<Textarea
											id="instance-description"
											value={instanceDescription}
											onChange={(e) =>
												handleDescriptionChange(
													e.target.value,
												)
											}
											placeholder="Describe the purpose of this report instance..."
											rows={2}
										/>
									</div>
								</CardContent>
							</Card>

							{/* Scheduling */}
							<Card>
								<CardHeader className="pb-3">
									<CardTitle className="flex items-center gap-2">
										<CalendarClockIcon className="h-4 w-4" />
										Scheduling
									</CardTitle>
									<CardDescription>
										Control when this report runs
										automatically
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<RadioGroup
										value={scheduleMode}
										onValueChange={(v) => {
											setScheduleMode(v as ScheduleMode);
											setScheduleDirty(true);
											setHasChanges(true);
										}}
										aria-label="Schedule mode"
										className="flex flex-wrap gap-4"
									>
										<div className="flex items-center gap-2">
											<RadioGroupItem
												value="INHERITED"
												id="schedule-inherited"
											/>
											<Label
												htmlFor="schedule-inherited"
												className="cursor-pointer font-normal"
											>
												Inherit from template
											</Label>
										</div>
										<div className="flex items-center gap-2">
											<RadioGroupItem
												value="CUSTOM"
												id="schedule-custom"
											/>
											<Label
												htmlFor="schedule-custom"
												className="cursor-pointer font-normal"
											>
												Custom schedule
											</Label>
										</div>
										<div className="flex items-center gap-2">
											<RadioGroupItem
												value="OFF"
												id="schedule-off"
											/>
											<Label
												htmlFor="schedule-off"
												className="cursor-pointer font-normal"
											>
												Off
											</Label>
										</div>
									</RadioGroup>

									{scheduleMode === "CUSTOM" && (
										<div className="space-y-3 pt-2">
											<div className="space-y-1">
												<Label
													htmlFor="schedule-frequency"
													className="text-xs text-muted-foreground"
												>
													Frequency
												</Label>
												<Select
													value={scheduleFrequency}
													onValueChange={(v) => {
														setScheduleFrequency(
															v as ScheduleFrequency,
														);
														setScheduleDirty(true);
														setHasChanges(true);
													}}
												>
													<SelectTrigger
														id="schedule-frequency"
														className="w-[180px]"
													>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="daily">
															Daily
														</SelectItem>
														<SelectItem value="weekly">
															Weekly
														</SelectItem>
														<SelectItem value="biweekly">
															Biweekly
														</SelectItem>
														<SelectItem value="monthly">
															Monthly
														</SelectItem>
														<SelectItem value="quarterly">
															Quarterly
														</SelectItem>
													</SelectContent>
												</Select>
											</div>

											{(scheduleFrequency === "weekly" ||
												scheduleFrequency ===
													"biweekly") && (
												<div className="space-y-1">
													<Label
														htmlFor="schedule-dow"
														className="text-xs text-muted-foreground"
													>
														Day of week
													</Label>
													<Select
														value={String(
															scheduleDayOfWeek,
														)}
														onValueChange={(v) => {
															setScheduleDayOfWeek(
																Number(v),
															);
															setScheduleDirty(
																true,
															);
															setHasChanges(true);
														}}
													>
														<SelectTrigger
															id="schedule-dow"
															className="w-[160px]"
														>
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{[
																"Sunday",
																"Monday",
																"Tuesday",
																"Wednesday",
																"Thursday",
																"Friday",
																"Saturday",
															].map((day, i) => (
																<SelectItem
																	key={day}
																	value={String(
																		i,
																	)}
																>
																	{day}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												</div>
											)}

											{(scheduleFrequency === "monthly" ||
												scheduleFrequency ===
													"quarterly") && (
												<div className="space-y-1">
													<Label
														htmlFor="schedule-dom"
														className="text-xs text-muted-foreground"
													>
														Day of month
													</Label>
													<Select
														value={String(
															scheduleDayOfMonth,
														)}
														onValueChange={(v) => {
															setScheduleDayOfMonth(
																Number(v),
															);
															setScheduleDirty(
																true,
															);
															setHasChanges(true);
														}}
													>
														<SelectTrigger
															id="schedule-dom"
															className="w-[100px]"
														>
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{Array.from(
																{ length: 31 },
																(_, i) => i + 1,
															).map((d) => (
																<SelectItem
																	key={d}
																	value={String(
																		d,
																	)}
																>
																	{d}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												</div>
											)}

											<div className="flex items-end gap-3">
												<div className="space-y-1">
													<Label
														htmlFor="schedule-hour"
														className="text-xs text-muted-foreground"
													>
														Hour (0–23)
													</Label>
													<Input
														id="schedule-hour"
														type="number"
														min={0}
														max={23}
														value={scheduleHour}
														onChange={(e) => {
															setScheduleHour(
																Math.min(
																	23,
																	Math.max(
																		0,
																		Number(
																			e
																				.target
																				.value,
																		),
																	),
																),
															);
															setScheduleDirty(
																true,
															);
															setHasChanges(true);
														}}
														className="w-[80px]"
													/>
												</div>
												<div className="space-y-1">
													<Label
														htmlFor="schedule-minute"
														className="text-xs text-muted-foreground"
													>
														Minute (0–59)
													</Label>
													<Input
														id="schedule-minute"
														type="number"
														min={0}
														max={59}
														value={scheduleMinute}
														onChange={(e) => {
															setScheduleMinute(
																Math.min(
																	59,
																	Math.max(
																		0,
																		Number(
																			e
																				.target
																				.value,
																		),
																	),
																),
															);
															setScheduleDirty(
																true,
															);
															setHasChanges(true);
														}}
														className="w-[80px]"
													/>
												</div>
											</div>

											<div className="space-y-1">
												<Label
													id="timezone-label"
													className="block text-xs text-muted-foreground"
												>
													Timezone
												</Label>
												<Popover
													open={tzPopoverOpen}
													onOpenChange={
														setTzPopoverOpen
													}
												>
													<PopoverTrigger asChild>
														<Button
															variant="outline"
															role="combobox"
															aria-expanded={
																tzPopoverOpen
															}
															aria-labelledby="timezone-label"
															className="w-[260px] justify-between font-normal dark:bg-background dark:hover:bg-background"
														>
															{scheduleTimezone}
															<ChevronDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
														</Button>
													</PopoverTrigger>
													<PopoverContent
														className="w-[260px] p-0"
														align="start"
													>
														<Command>
															<CommandInput placeholder="Search timezone..." />
															<CommandList className="max-h-[200px]">
																<CommandEmpty>
																	No timezone
																	found.
																</CommandEmpty>
																<CommandGroup>
																	{(TIMEZONE_OPTIONS.includes(
																		scheduleTimezone,
																	)
																		? TIMEZONE_OPTIONS
																		: [
																				scheduleTimezone,
																				...TIMEZONE_OPTIONS,
																			]
																	).map(
																		(
																			tz,
																		) => (
																			<CommandItem
																				key={
																					tz
																				}
																				value={
																					tz
																				}
																				onSelect={() => {
																					setScheduleTimezone(
																						tz,
																					);
																					setScheduleDirty(
																						true,
																					);
																					setHasChanges(
																						true,
																					);
																					setTzPopoverOpen(
																						false,
																					);
																				}}
																			>
																				{
																					tz
																				}
																				{tz ===
																					scheduleTimezone && (
																					<CheckIcon className="ml-auto h-4 w-4" />
																				)}
																			</CommandItem>
																		),
																	)}
																</CommandGroup>
															</CommandList>
														</Command>
													</PopoverContent>
												</Popover>
											</div>
										</div>
									)}

									{scheduleMode === "OFF" && (
										<p className="text-sm text-muted-foreground">
											Scheduling is disabled for this
											report.
										</p>
									)}

									<div className="text-xs text-muted-foreground space-y-0.5">
										<p>
											Next run:{" "}
											{instance.nextRunAt
												? new Date(
														instance.nextRunAt,
													).toLocaleString()
												: "—"}{" "}
											· Last run:{" "}
											{instance.lastRunAt
												? new Date(
														instance.lastRunAt,
													).toLocaleString()
												: "—"}
										</p>
										{!instance.isActive && (
											<p className="text-xs text-muted-foreground/70 motion-safe:transition-opacity">
												Scheduling applies once this
												report is active.
											</p>
										)}
									</div>
								</CardContent>
							</Card>

							{/* AI Configuration — collapsed by default to keep the page scannable */}
							<Accordion
								type="single"
								collapsible
								className="rounded-xl border bg-card"
							>
								<AccordionItem
									value="ai-config"
									className="border-0 px-4"
								>
									<AccordionTrigger className="py-4 hover:no-underline">
										<span className="flex items-center gap-2 text-sm font-semibold">
											<SparklesIcon className="h-4 w-4 text-primary" />
											AI Configuration
											<InfoHint
												label="AI Configuration"
												content="Advanced controls for how the AI writes this report — reasoning strategy, persona, pattern, system prompt and iteration budget. Optional: leave untouched to use template defaults and auto-detection."
											/>
											<Badge
												variant="secondary"
												className="ml-1 text-[11px] font-normal"
											>
												Optional
											</Badge>
										</span>
									</AccordionTrigger>
									<AccordionContent className="space-y-6">
										{/* Fabric AI Configuration */}
										<Card>
											<CardHeader>
												<CardTitle className="flex items-center gap-2">
													<SparklesIcon className="h-4 w-4 text-purple-500" />
													Fabric AI Enhancement
												</CardTitle>
												<CardDescription>
													Configure how Fabric AI
													enhances the AI analysis in
													this report
												</CardDescription>
											</CardHeader>
											<CardContent className="space-y-6">
												{/* Template defaults info */}
												{instance?.template
													.fabricConfig && (
													<div className="bg-muted/50 rounded-lg p-3 text-sm">
														<p className="font-medium mb-2">
															Template Defaults:
														</p>
														<div className="flex flex-wrap gap-2">
															{(
																instance
																	.template
																	.fabricConfig as {
																	strategy?: string;
																}
															).strategy && (
																<Badge variant="outline">
																	Strategy:{" "}
																	{
																		(
																			instance
																				.template
																				.fabricConfig as {
																				strategy?: string;
																			}
																		)
																			.strategy
																	}
																</Badge>
															)}
															{(
																instance
																	.template
																	.fabricConfig as {
																	context?: string;
																}
															).context && (
																<Badge variant="outline">
																	Context:{" "}
																	{
																		(
																			instance
																				.template
																				.fabricConfig as {
																				context?: string;
																			}
																		)
																			.context
																	}
																</Badge>
															)}
															{(
																instance
																	.template
																	.fabricConfig as {
																	pattern?: string;
																}
															).pattern && (
																<Badge variant="outline">
																	Pattern:{" "}
																	{
																		(
																			instance
																				.template
																				.fabricConfig as {
																				pattern?: string;
																			}
																		)
																			.pattern
																	}
																</Badge>
															)}
														</div>
														<p className="text-xs text-muted-foreground mt-2">
															Override these
															settings below for
															this instance
														</p>
													</div>
												)}

												{/* Auto-detection toggle */}
												<div className="flex items-center justify-between">
													<div className="space-y-0.5">
														<Label htmlFor="fabric-autodetect">
															Auto-detect from
															task
														</Label>
														<p className="text-xs text-muted-foreground">
															Automatically select
															patterns based on
															report content
														</p>
													</div>
													<Switch
														id="fabric-autodetect"
														checked={
															fabricAutoDetect
														}
														onCheckedChange={
															handleFabricAutoDetectChange
														}
													/>
												</div>

												<Separator />

												{/* Manual overrides */}
												<div className="grid gap-4 sm:grid-cols-3">
													{/* Strategy */}
													<div className="space-y-2">
														<Label
															htmlFor="fabric-strategy"
															className="flex items-center gap-1.5"
														>
															Strategy
															<span className="text-xs text-muted-foreground">
																(How to think)
															</span>
															<InfoHint
																label="Strategy"
																content="How the AI reasons. Chain-of-Thought works step by step; Tree-of-Thoughts explores multiple paths; Reflexion self-corrects; ReAct interleaves reasoning with tool calls. Leave on Auto to let Fabric choose."
															/>
														</Label>
														<Select
															value={
																fabricStrategy ||
																"__none__"
															}
															onValueChange={(
																v,
															) =>
																handleFabricChange(
																	"strategy",
																	v ===
																		"__none__"
																		? ""
																		: v,
																)
															}
														>
															<SelectTrigger id="fabric-strategy">
																<SelectValue placeholder="Auto / None" />
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="__none__">
																	Auto / None
																</SelectItem>
																<SelectItem value="cot">
																	Chain-of-Thought
																	(Step by
																	step)
																</SelectItem>
																<SelectItem value="tot">
																	Tree-of-Thoughts
																	(Explore
																	paths)
																</SelectItem>
																<SelectItem value="reflexion">
																	Reflexion
																	(Self-correct)
																</SelectItem>
																<SelectItem value="react">
																	ReAct
																	(Reason +
																	Act)
																</SelectItem>
															</SelectContent>
														</Select>
													</div>

													{/* Context/Persona */}
													<div className="space-y-2">
														<Label
															htmlFor="fabric-context"
															className="flex items-center gap-1.5"
														>
															Context
															<span className="text-xs text-muted-foreground">
																(AI persona)
															</span>
															<InfoHint
																label="Context"
																content="The persona the AI adopts — e.g. Security Expert, Senior Developer, Product Manager. Shapes tone and what it emphasises. Leave on Auto to let Fabric choose."
															/>
														</Label>
														<Select
															value={
																fabricContext ||
																"__none__"
															}
															onValueChange={(
																v,
															) =>
																handleFabricChange(
																	"context",
																	v ===
																		"__none__"
																		? ""
																		: v,
																)
															}
														>
															<SelectTrigger id="fabric-context">
																<SelectValue placeholder="Auto / None" />
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="__none__">
																	Auto / None
																</SelectItem>
																<SelectItem value="security_expert">
																	Security
																	Expert
																</SelectItem>
																<SelectItem value="senior_dev">
																	Senior
																	Developer
																</SelectItem>
																<SelectItem value="technical_writer">
																	Technical
																	Writer
																</SelectItem>
																<SelectItem value="pm">
																	Product
																	Manager
																</SelectItem>
																<SelectItem value="data_scientist">
																	Data
																	Scientist
																</SelectItem>
															</SelectContent>
														</Select>
													</div>

													{/* Pattern */}
													<div className="space-y-2">
														<Label
															htmlFor="fabric-pattern"
															className="flex items-center gap-1.5"
														>
															Pattern
															<span className="text-xs text-muted-foreground">
																(What to do)
															</span>
															<InfoHint
																label="Pattern"
																content="The task pattern applied to the gathered data — summarise, analyse claims, extract wisdom, review code, and more. Leave on Auto to let Fabric pick one that fits the report."
															/>
														</Label>
														<Select
															value={
																fabricPattern ||
																"__none__"
															}
															onValueChange={(
																v,
															) =>
																handleFabricChange(
																	"pattern",
																	v ===
																		"__none__"
																		? ""
																		: v,
																)
															}
														>
															<SelectTrigger id="fabric-pattern">
																<SelectValue placeholder="Auto / None" />
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="__none__">
																	Auto / None
																</SelectItem>
																<SelectGroup>
																	<SelectLabel>
																		Analysis
																	</SelectLabel>
																	<SelectItem value="analyze_claims">
																		Analyze
																		Claims
																	</SelectItem>
																	<SelectItem value="find_vulnerabilities">
																		Find
																		Vulnerabilities
																	</SelectItem>
																	<SelectItem value="rate_content">
																		Rate
																		Content
																	</SelectItem>
																</SelectGroup>
																<SelectGroup>
																	<SelectLabel>
																		Extraction
																	</SelectLabel>
																	<SelectItem value="extract_wisdom">
																		Extract
																		Wisdom
																	</SelectItem>
																	<SelectItem value="extract_main_idea">
																		Extract
																		Main
																		Idea
																	</SelectItem>
																	<SelectItem value="summarize">
																		Summarize
																	</SelectItem>
																</SelectGroup>
																<SelectGroup>
																	<SelectLabel>
																		Code
																	</SelectLabel>
																	<SelectItem value="review_code">
																		Review
																		Code
																	</SelectItem>
																	<SelectItem value="explain_code">
																		Explain
																		Code
																	</SelectItem>
																	<SelectItem value="improve_code">
																		Improve
																		Code
																	</SelectItem>
																</SelectGroup>
																<SelectGroup>
																	<SelectLabel>
																		Planning
																	</SelectLabel>
																	<SelectItem value="create_design_document">
																		Create
																		Design
																		Document
																	</SelectItem>
																	<SelectItem value="agility_story">
																		Feature
																		Breakdown
																	</SelectItem>
																</SelectGroup>
															</SelectContent>
														</Select>
													</div>
												</div>

												<p className="text-xs text-muted-foreground">
													Fabric AI composes prompts
													in order: Strategy → Context
													→ Pattern. Leave fields
													empty to use auto-detection
													or template defaults.
												</p>
											</CardContent>
										</Card>

										{/* AI Analysis Task Customization */}
										{definition?.aiAgents &&
											definition.aiAgents.length > 0 && (
												<Card>
													<CardContent className="pt-6">
														<AiTaskPromptEditor
															tasks={
																definition.aiAgents as AiTask[]
															}
															customTasks={
																customAiTasks
															}
															onCustomTaskChange={(
																key,
																value,
															) => {
																if (
																	value ===
																	null
																) {
																	setCustomAiTasks(
																		(
																			prev,
																		) => {
																			const next =
																				{
																					...prev,
																				};
																			delete next[
																				key
																			];
																			return next;
																		},
																	);
																} else {
																	setCustomAiTasks(
																		(
																			prev,
																		) => ({
																			...prev,
																			[key]: value,
																		}),
																	);
																}
																setHasChanges(
																	true,
																);
															}}
														/>
													</CardContent>
												</Card>
											)}

										{/* System Prompt Customization */}
										<Card>
											<CardHeader>
												<CardTitle className="flex items-center gap-2">
													<CodeIcon className="h-4 w-4" />
													System Prompt
												</CardTitle>
												<CardDescription>
													Customize the AI's behavior
													and persona for this report
													instance
												</CardDescription>
											</CardHeader>
											<CardContent className="space-y-4">
												<div className="space-y-2">
													<div className="flex items-center justify-between">
														<Label htmlFor="system-prompt">
															Custom System Prompt
														</Label>
														{customSystemPrompt && (
															<Button
																variant="ghost"
																size="sm"
																className="h-7 text-xs"
																onClick={() => {
																	setCustomSystemPrompt(
																		"",
																	);
																	setHasChanges(
																		true,
																	);
																}}
															>
																Reset to Default
															</Button>
														)}
													</div>
													<Textarea
														id="system-prompt"
														value={
															customSystemPrompt
														}
														onChange={(e) =>
															handleSystemPromptChange(
																e.target.value,
															)
														}
														placeholder="You are an AI assistant helping to generate reports and analyze data. Be concise, accurate, and format your response in markdown when appropriate..."
														rows={5}
														className="font-mono text-sm"
													/>
													<p className="text-xs text-muted-foreground">
														The system prompt sets
														the AI's role and
														behavior. Leave empty to
														use the default prompt
														which instructs the AI
														to be concise, accurate,
														and cite specific data
														points.
													</p>
												</div>

												{/* Show default prompt as reference */}
												{!customSystemPrompt && (
													<div className="bg-muted/50 rounded-lg p-3 text-xs">
														<p className="font-medium mb-1">
															Default System
															Prompt:
														</p>
														<p className="text-muted-foreground italic">
															"You are an AI
															assistant helping to
															generate reports and
															analyze data. Be
															concise, accurate,
															and format your
															response in markdown
															when appropriate.
															Base your analysis
															only on the provided
															data context. Cite
															specific data points
															when making claims."
														</p>
													</div>
												)}

												{/* User Prompt / AI Instructions */}
												<div className="space-y-2 pt-4 border-t">
													<Label htmlFor="user-prompt">
														AI Instructions (User
														Prompt)
													</Label>
													<Textarea
														id="user-prompt"
														value={userPrompt}
														onChange={(e) => {
															setUserPrompt(
																e.target.value,
															);
															setHasChanges(true);
														}}
														placeholder="Describe what the AI should do with the gathered data..."
														rows={4}
														className="font-mono text-sm"
													/>
													<p className="text-xs text-muted-foreground">
														These instructions tell
														the AI what to do with
														the data gathered from
														your data sources. This
														is the main task prompt.
													</p>
												</div>

												{/* Max Iterations */}
												<div className="space-y-2 pt-4 border-t">
													<Label
														htmlFor="max-iterations"
														className="flex items-center gap-1.5"
													>
														Max Iterations
														<InfoHint
															label="Max Iterations"
															content="How many reasoning iterations the AI may use to gather data (1–50). Each iteration can call multiple tools. Higher = more thorough but slower and more costly. Default is 15."
														/>
													</Label>
													<Input
														id="max-iterations"
														type="number"
														min={1}
														max={50}
														value={
															maxIterations ?? ""
														}
														onChange={(e) => {
															const parsed =
																Number.parseInt(
																	e.target
																		.value,
																	10,
																);
															setMaxIterations(
																Number.isFinite(
																	parsed,
																)
																	? parsed
																	: undefined,
															);
															setHasChanges(true);
														}}
														placeholder="15 (default)"
														className="w-32"
													/>
													<p className="text-xs text-muted-foreground">
														Maximum number of AI
														reasoning iterations for
														data gathering. Each
														iteration can call
														multiple tools. Increase
														if your report needs
														more thorough data
														collection (1-50).
													</p>
												</div>
											</CardContent>
										</Card>
									</AccordionContent>
								</AccordionItem>
							</Accordion>

							{/* Data source connection — scroll target for the issue banner */}
							<div
								ref={connectionCardRef}
								className="scroll-mt-6"
							/>
							{/* Data Source Connections - Tile-based layout */}
							{/* Only show data sources that the template defines as required */}
							{hasAnyDataSources && (
								<Card>
									<CardHeader>
										<CardTitle className="flex items-center gap-2">
											<ServerIcon className="h-4 w-4" />
											Data Source Connections
											<InfoHint
												label="Data source connection"
												content="Connect the external data this report reads from. “Test connections” verifies access; the status shown here and in the readiness checklist reflect the latest test. Generation is blocked until a required source is connected."
											/>
											<Badge
												variant={
													reportReadiness.connectionTone ===
													"success"
														? "success"
														: reportReadiness.connectionTone ===
																"destructive"
															? "destructive"
															: "warning"
												}
												className="ml-auto shrink-0 gap-1"
											>
												<span className="inline-block size-1.5 rounded-full bg-current" />
												{
													reportReadiness.connectionLabel
												}
											</Badge>
										</CardTitle>
										<CardDescription>
											Connect your data sources to this
											report
										</CardDescription>
									</CardHeader>
									<CardContent>
										<DataSourceConfigGrid>
											{requiredDataSources.map((req) => {
												const matchingMcp =
													getMatchingMcpConfigs(
														req.key,
													);
												const matchingIntegrations =
													findMatchingIntegrations(
														req.key,
													);
												const currentBinding =
													bindings[req.key];

												// Resolvable when the stored config still works OR a self-
												// heal fallback exists. When neither, the tile shows
												// "Reconnect required" instead of "Connected".
												const bindingResolvable =
													isDataSourceResolvable(
														req.key,
													);

												// Build connection options based on the source type
												// Only show matching/recommended options to avoid confusion
												const isIntegrationSource =
													req.sourceType ===
													"integration";

												const connectionOptions: ConnectionOption[] =
													isIntegrationSource
														? [
																// For integration sources: show matching integrations only
																...matchingIntegrations.map(
																	(int: {
																		id: string;
																		name: string;
																		provider: string;
																		isActive: boolean;
																	}) => ({
																		id: int.id,
																		name: `${int.name} (${int.provider})`,
																		description:
																			"Integration",
																		type: "integration" as const,
																		isRecommended: true,
																		isAuthenticated:
																			int.isActive,
																	}),
																),
															]
														: [
																// For MCP sources: show matching MCP configs and integrations only
																...matchingMcp.map(
																	(
																		config,
																	) => ({
																		id: config.id,
																		name: getMcpConfigDisplayName(
																			config,
																		),
																		description:
																			"MCP Server",
																		type: "mcp" as const,
																		isRecommended: true,
																		isAuthenticated:
																			isMcpConfigAuthenticated(
																				config,
																			),
																	}),
																),
																...matchingIntegrations.map(
																	(int: {
																		id: string;
																		name: string;
																		provider: string;
																		isActive: boolean;
																	}) => ({
																		id: int.id,
																		name: `${int.name} (${int.provider})`,
																		description:
																			"Integration",
																		type: "integration" as const,
																		isRecommended: true,
																		isAuthenticated:
																			int.isActive,
																	}),
																),
															];

												// Get resources for the currently selected MCP connection
												const configResources =
													currentBinding?.type ===
														"mcp" &&
													currentBinding.id
														? fetchedResources[
																currentBinding
																	.id
															] || []
														: [];
												const isLoadingResources =
													currentBinding?.type ===
														"mcp" &&
													currentBinding.id ===
														fetchingResourcesFor;

												// Flatten resource groups into ResourceOption array
												const resourceOptions: ResourceOption[] =
													configResources.flatMap(
														(group) =>
															group.items.map(
																(item) => ({
																	id: item.id,
																	name: item.name,
																	type: group.resourceType,
																	description:
																		item.description ||
																		undefined,
																}),
															),
													);

												// Build binding for tile component
												const tileBinding:
													| TileConnectionBinding
													| undefined = currentBinding
													? {
															type: currentBinding.type,
															id: currentBinding.id,
															resourceId:
																currentBinding.resourceId,
															resourceName:
																currentBinding.resourceName,
															resourceType:
																currentBinding.resourceType,
														}
													: undefined;

												// Get context fields for this data source's provider
												const providerContextFields =
													PROVIDER_CONTEXT_FIELDS[
														req.key
													] || [];

												return (
													<div
														key={req.key}
														className="space-y-3"
													>
														<DataSourceConfigTile
															dataSourceKey={
																req.key
															}
															name={req.name}
															description={
																req.description
															}
															type={
																req.sourceType
															}
															required={
																req.required
															}
															binding={
																tileBinding
															}
															bindingResolvable={
																bindingResolvable
															}
															connectionOptions={
																connectionOptions
															}
															resources={
																resourceOptions
															}
															isLoadingResources={
																isLoadingResources
															}
															onConnectionChange={(
																connectionId,
																connectionType,
																_connectionName,
															) => {
																if (
																	!connectionId
																) {
																	setBindings(
																		(
																			prev,
																		) => {
																			const next =
																				{
																					...prev,
																				};
																			delete next[
																				req
																					.key
																			];
																			return next;
																		},
																	);
																} else {
																	setBindings(
																		(
																			prev,
																		) => ({
																			...prev,
																			[req.key]:
																				{
																					type: connectionType,
																					id: connectionId,
																				},
																		}),
																	);
																	// Fetch resources for MCP connections
																	if (
																		connectionType ===
																		"mcp"
																	) {
																		fetchResourcesForConnection(
																			connectionId,
																		);
																	}
																}
																setHasChanges(
																	true,
																);
															}}
															onResourceChange={(
																resourceId,
																resourceName,
																resourceType,
															) => {
																// Find the resource to get metadata
																const configResources =
																	fetchedResources[
																		currentBinding?.id ||
																			""
																	] || [];
																let resourceMetadata: Record<
																	string,
																	unknown
																> | null = null;
																for (const group of configResources) {
																	const resource =
																		group.items.find(
																			(
																				item,
																			) =>
																				item.id ===
																				resourceId,
																		);
																	if (
																		resource
																	) {
																		resourceMetadata =
																			resource.metadata ||
																			null;
																		break;
																	}
																}
																handleResourceChange(
																	req.key,
																	resourceId,
																	resourceName,
																	resourceType,
																	resourceMetadata,
																);
															}}
														/>

														{/* Context fields for this data source */}
														{providerContextFields.length >
															0 && (
															<div className="ml-4 pl-4 border-l-2 border-muted space-y-3">
																<p className="text-xs text-muted-foreground">
																	Provide
																	context for
																	AI to find
																	the right
																	data
																</p>
																<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
																	{providerContextFields.map(
																		(
																			field,
																		) => (
																			<div
																				key={
																					field.key
																				}
																				className="space-y-1"
																			>
																				<Label
																					htmlFor={`context-${req.key}-${field.key}`}
																					className="text-sm"
																				>
																					{
																						field.label
																					}
																					{field.required && (
																						<span className="text-destructive ml-1">
																							*
																						</span>
																					)}
																				</Label>
																				<Input
																					id={`context-${req.key}-${field.key}`}
																					value={
																						contextValues[
																							field
																								.key
																						] ||
																						""
																					}
																					onChange={(
																						e,
																					) =>
																						handleContextChange(
																							field.key,
																							e
																								.target
																								.value,
																						)
																					}
																					placeholder={
																						field.placeholder
																					}
																					className="h-9"
																				/>
																				<p className="text-[10px] text-muted-foreground">
																					{
																						field.helpText
																					}
																				</p>
																			</div>
																		),
																	)}
																</div>
															</div>
														)}
													</div>
												);
											})}
										</DataSourceConfigGrid>
									</CardContent>
								</Card>
							)}

							{/* Integration Setup Guides */}
							{requiredIntegrationTypes.length > 0 && (
								<div className="space-y-3">
									{requiredIntegrationTypes.map((intType) => (
										<IntegrationSetupGuide
											key={intType}
											integrationType={intType}
										/>
									))}
								</div>
							)}

							{/* Data Source Operation Parameters (project, team, iteration, etc.) */}
							{definition?.dataSources &&
								definition.dataSources.length > 0 &&
								definition.dataSources.some(
									(ds) =>
										ds.operation &&
										OPERATION_PARAMS[ds.operation]?.length >
											0,
								) && (
									<Card>
										<CardHeader>
											<CardTitle className="flex items-center gap-2">
												<SettingsIcon className="h-4 w-4" />
												Data Source Parameters
											</CardTitle>
											<CardDescription>
												Configure the parameters for
												each data source operation
												(e.g., project, team, sprint)
											</CardDescription>
										</CardHeader>
										<CardContent className="space-y-6">
											{definition.dataSources
												.filter(
													(ds) =>
														ds.operation &&
														OPERATION_PARAMS[
															ds.operation
														]?.length > 0,
												)
												.map((ds) => {
													const params =
														OPERATION_PARAMS[
															// biome-ignore lint/style/noNonNullAssertion: operation is guaranteed by filter above
															ds.operation!
														] || [];
													const dsParams =
														dataSourceParams[
															ds.id
														] || {};

													return (
														<div
															key={ds.id}
															className="space-y-3"
														>
															<div className="flex items-center gap-2">
																<Badge
																	variant="secondary"
																	className="text-xs"
																>
																	{ds.provider ||
																		"MCP"}
																</Badge>
																<span className="text-sm font-medium">
																	{ds.operation?.replace(
																		/_/g,
																		" ",
																	)}
																</span>
															</div>
															<div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-4 border-l-2 border-muted">
																{params.map(
																	(param) => (
																		<div
																			key={
																				param.key
																			}
																			className="space-y-1"
																		>
																			<Label
																				htmlFor={`${ds.id}-${param.key}`}
																				className="text-sm"
																			>
																				{
																					param.label
																				}
																				{param.required && (
																					<span className="text-destructive ml-1">
																						*
																					</span>
																				)}
																			</Label>
																			<Input
																				id={`${ds.id}-${param.key}`}
																				value={
																					dsParams[
																						param
																							.key
																					] ||
																					""
																				}
																				onChange={(
																					e,
																				) =>
																					handleDataSourceParamChange(
																						ds.id,
																						param.key,
																						e
																							.target
																							.value,
																					)
																				}
																				placeholder={
																					param.placeholder
																				}
																			/>
																		</div>
																	),
																)}
															</div>
														</div>
													);
												})}
										</CardContent>
									</Card>
								)}

							{/* Parameters — scroll target for the issue banner */}
							<div
								ref={parametersCardRef}
								className="scroll-mt-6"
							/>
							{/* Template Parameters */}
							{templateParams?.properties &&
								Object.keys(templateParams.properties).length >
									0 && (
									<Card>
										<CardHeader>
											<CardTitle className="flex items-center gap-2">
												<SettingsIcon className="h-4 w-4" />
												Parameters
											</CardTitle>
											<CardDescription>
												Configure the values this
												template needs to generate
												reports
											</CardDescription>
										</CardHeader>
										<CardContent>
											<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
												{Object.entries(
													templateParams.properties,
												).map(([key, schema]) => (
													<SmartParameterInput
														key={key}
														name={key}
														schema={
															schema as ParameterSchema
														}
														value={
															parameterDefaults[
																key
															] ?? ""
														}
														onChange={(value) =>
															handleParameterChange(
																key,
																value,
															)
														}
														isRequired={templateParams.required?.includes(
															key,
														)}
														isUsedInOutput={isUsedInTemplateOutput(
															key,
														)}
													/>
												))}
											</div>
										</CardContent>
									</Card>
								)}

							{/* Template Details — collapsed reference */}
							<Accordion
								type="single"
								collapsible
								className="rounded-xl border bg-card"
							>
								<AccordionItem
									value="template-details"
									className="border-0 px-4"
								>
									<AccordionTrigger className="py-4 hover:no-underline">
										<span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
											<FileTextIcon className="h-5 w-5" />
											Template Details
											<Badge
												variant="secondary"
												className="ml-1"
											>
												{instance.template.templateType.replace(
													/_/g,
													" ",
												)}
											</Badge>
											<span className="font-normal text-muted-foreground">
												{instance.template.name}
											</span>
										</span>
									</AccordionTrigger>
									<AccordionContent className="space-y-6">
										{/* Description */}
										{instance.template.description && (
											<div>
												<h4 className="text-sm font-medium mb-2">
													What This Report Does
												</h4>
												<p className="text-sm text-muted-foreground leading-relaxed">
													{
														instance.template
															.description
													}
												</p>
											</div>
										)}

										{/* AI Analysis Tasks */}
										{definition?.aiAgents &&
											definition.aiAgents.length > 0 && (
												<div>
													<h4 className="text-sm font-medium mb-3 flex items-center gap-2">
														<BrainCircuitIcon className="h-4 w-4 text-primary" />
														AI Analysis Tasks
													</h4>
													<div className="space-y-3">
														{definition.aiAgents.map(
															(agent, i) => (
																<div
																	key={i}
																	className="border rounded-lg p-3 bg-muted/30"
																>
																	<div className="flex items-start justify-between gap-2 mb-2">
																		<Badge
																			variant="outline"
																			className="text-xs"
																		>
																			{agent.agentId ===
																			"default"
																				? "Default AI"
																				: agent.agentId}
																		</Badge>
																		{agent.outputVariable && (
																			<Badge
																				variant="secondary"
																				className="text-xs"
																			>
																				Output:{" "}
																				{
																					agent.outputVariable
																				}
																			</Badge>
																		)}
																	</div>
																	<p className="text-sm text-muted-foreground">
																		{
																			agent.task
																		}
																	</p>
																</div>
															),
														)}
													</div>
												</div>
											)}

										{/* Template Variables */}
										{templateParams?.properties &&
											Object.keys(
												templateParams.properties,
											).length > 0 && (
												<div>
													<h4 className="text-sm font-medium mb-3 flex items-center gap-2">
														<CodeIcon className="h-4 w-4 text-primary" />
														Template Variables
													</h4>
													<div className="grid gap-2">
														{Object.entries(
															templateParams.properties,
														).map(
															([key, schema]) => (
																<div
																	key={key}
																	className="flex items-center gap-3 p-2 border rounded-lg bg-muted/20"
																>
																	<code className="bg-primary/10 text-primary px-2 py-0.5 rounded font-mono text-xs">
																		{`{{${key}}}`}
																	</code>
																	<span className="text-sm text-muted-foreground flex-1">
																		{schema.description ||
																			key}
																	</span>
																	{templateParams.required?.includes(
																		key,
																	) && (
																		<Badge
																			variant="secondary"
																			className="text-xs"
																		>
																			Required
																		</Badge>
																	)}
																</div>
															),
														)}
													</div>
												</div>
											)}

										{/* Report Sections */}
										{definition?.sections &&
											definition.sections.length > 0 && (
												<div>
													<h4 className="text-sm font-medium mb-3 flex items-center gap-2">
														<LayoutListIcon className="h-4 w-4 text-primary" />
														Report Sections
													</h4>
													<div className="space-y-2">
														{definition.sections.map(
															(section) => (
																<div
																	key={
																		section.id
																	}
																	className="flex items-center gap-3 p-2 border rounded-lg bg-muted/20"
																>
																	<Badge
																		variant="outline"
																		className="text-xs capitalize"
																	>
																		{section.type.replace(
																			/-/g,
																			" ",
																		)}
																	</Badge>
																	<span className="text-sm">
																		{
																			section.title
																		}
																	</span>
																	{section.type ===
																		"text" &&
																		typeof section
																			.config
																			?.template ===
																			"string" && (
																			<span className="text-xs text-muted-foreground ml-auto">
																				(includes
																				template
																				variables)
																			</span>
																		)}
																</div>
															),
														)}
													</div>
												</div>
											)}

										{/* Data Sources */}
										{definition?.dataSources &&
											definition.dataSources.length >
												0 && (
												<div>
													<h4 className="text-sm font-medium mb-3 flex items-center gap-2">
														<ServerIcon className="h-4 w-4 text-primary" />
														Data Sources
													</h4>
													<div className="space-y-2">
														{definition.dataSources.map(
															(ds) => (
																<div
																	key={ds.id}
																	className="flex items-center gap-3 p-2 border rounded-lg bg-muted/20"
																>
																	<Badge
																		variant="outline"
																		className="text-xs uppercase"
																	>
																		{
																			ds.type
																		}
																	</Badge>
																	<span className="text-sm">
																		{ds.type ===
																		"mcp" ? (
																			<>
																				{(ds
																					.config
																					?.mcpServerKey as string) ||
																					"MCP"}{" "}
																				→{" "}
																				{(ds
																					.config
																					?.toolName as string) ||
																					ds.id}
																			</>
																		) : (
																			ds.id
																		)}
																	</span>
																</div>
															),
														)}
													</div>
												</div>
											)}

										{/* Output Format */}
										<div className="flex items-center gap-2 pt-4 border-t">
											<span className="text-sm font-medium">
												Output Format:
											</span>
											<Badge variant="secondary">
												{instance.template.outputFormat}
											</Badge>
										</div>
									</AccordionContent>
								</AccordionItem>
							</Accordion>
						</TabsContent>

						{/* Execution History Tab */}
						<TabsContent value="history" className="space-y-4">
							<Card>
								<CardHeader>
									<CardTitle>Execution History</CardTitle>
									<CardDescription>
										Recent report generations
									</CardDescription>
								</CardHeader>
								<CardContent>
									{executions.length > 0 ? (
										<Table>
											<TableHeader>
												<TableRow>
													<TableHead>
														Status
													</TableHead>
													<TableHead>
														Started
													</TableHead>
													<TableHead>
														Duration
													</TableHead>
													<TableHead className="text-center">
														Artifacts
													</TableHead>
													<TableHead />
												</TableRow>
											</TableHeader>
											<TableBody>
												{executions.map((exec) => (
													<TableRow key={exec.id}>
														<TableCell>
															<div className="flex items-center gap-2">
																<ExecutionStatusBadge
																	status={
																		exec.status
																	}
																/>
																<CancelExecutionButton
																	executionId={
																		exec.id
																	}
																	executionStatus={
																		exec.status
																	}
																	executionUserId={
																		exec.userId
																	}
																	organizationId={
																		instanceOrgId
																	}
																	viewerUserId={
																		user?.id
																	}
																	viewerIsOrgAdmin={
																		isOrganizationAdmin
																	}
																	onCancelled={
																		refetch
																	}
																/>
															</div>
														</TableCell>
														<TableCell>
															{exec.startedAt
																? formatDistanceToNow(
																		new Date(
																			exec.startedAt,
																		),
																		{
																			addSuffix: true,
																		},
																	)
																: exec.createdAt
																	? formatDistanceToNow(
																			new Date(
																				exec.createdAt,
																			),
																			{
																				addSuffix: true,
																			},
																		)
																	: "-"}
														</TableCell>
														<TableCell>
															{exec.duration
																? `${(exec.duration / 1000).toFixed(1)}s`
																: "-"}
														</TableCell>
														<TableCell className="text-center">
															{exec.status !==
																"CANCELLED" &&
															exec.artifacts &&
															exec.artifacts
																.length > 0 ? (
																<div className="flex justify-center gap-1">
																	{exec.artifacts.map(
																		(artifact: {
																			id: string;
																			name: string;
																			artifactType: string;
																		}) => (
																			<div
																				key={
																					artifact.id
																				}
																				className="flex gap-0.5"
																			>
																				<Button
																					variant="ghost"
																					size="sm"
																					className="h-7 px-2 text-xs"
																					onClick={() =>
																						handleViewArtifact(
																							artifact.id,
																							artifact.name,
																						)
																					}
																					disabled={
																						loadingArtifact ===
																						artifact.id
																					}
																					aria-label={`View ${artifact.name}`}
																					title={`View ${artifact.name}`}
																				>
																					{loadingArtifact ===
																					artifact.id ? (
																						<Loader2Icon className="h-3 w-3 animate-spin" />
																					) : (
																						<EyeIcon className="h-3 w-3" />
																					)}
																				</Button>
																				<Button
																					variant="ghost"
																					size="sm"
																					className="h-7 px-2 text-xs"
																					onClick={() =>
																						window.open(
																							`/api/reports/artifacts/${artifact.id}/download`,
																							"_blank",
																						)
																					}
																					aria-label={`Download ${artifact.name}`}
																					title={`Download ${artifact.name}`}
																				>
																					<DownloadIcon className="h-3 w-3" />
																				</Button>
																				<Button
																					variant="ghost"
																					size="sm"
																					className="h-7 px-2 text-xs"
																					onClick={() =>
																						setArtifactDialog(
																							{
																								artifactId:
																									artifact.id,
																								artifactName:
																									artifact.name,
																								mode: "send",
																							},
																						)
																					}
																					title={`Send ${artifact.name} by email`}
																					aria-label={`Send ${artifact.name} by email`}
																				>
																					<SendIcon className="h-3 w-3" />
																				</Button>
																				<Button
																					variant="ghost"
																					size="sm"
																					className="h-7 px-2 text-xs"
																					onClick={() =>
																						setArtifactDialog(
																							{
																								artifactId:
																									artifact.id,
																								artifactName:
																									artifact.name,
																								mode: "history",
																							},
																						)
																					}
																					title={`Send history for ${artifact.name}`}
																					aria-label={`Send history for ${artifact.name}`}
																				>
																					<HistoryIcon className="h-3 w-3" />
																				</Button>
																			</div>
																		),
																	)}
																</div>
															) : exec.status ===
																"COMPLETED" ? (
																<span className="text-xs text-muted-foreground">
																	No artifacts
																</span>
															) : null}
														</TableCell>
														<TableCell className="max-w-[300px]">
															{exec.error && (
																<div className="flex items-start gap-1">
																	<AlertCircleIcon className="h-3 w-3 text-destructive flex-shrink-0 mt-0.5" />
																	{/* The message itself is already visible and
																		wraps in full, so the tooltip adds context
																		rather than repeating it. Not focusable, so
																		the copy also goes in an `sr-only` child —
																		`aria-label` would replace the visible
																		message in the accessible name. */}
																	<Tooltip>
																		<TooltipTrigger
																			asChild
																		>
																			<span className="text-xs text-destructive break-words">
																				{humanizeReportError(
																					exec.error,
																					"generate",
																				)}
																				<span className="sr-only">
																					{tTooltips(
																						"generationError",
																					)}
																				</span>
																			</span>
																		</TooltipTrigger>
																		<TooltipContent>
																			{tTooltips(
																				"generationError",
																			)}
																		</TooltipContent>
																	</Tooltip>
																</div>
															)}
															{Array.isArray(
																exec.mcpDiagnostics,
															) &&
																exec
																	.mcpDiagnostics
																	.length >
																	0 && (
																	<RunDiagnosticsPanel
																		diagnostics={
																			exec.mcpDiagnostics as Parameters<
																				typeof RunDiagnosticsPanel
																			>[0]["diagnostics"]
																		}
																	/>
																)}
														</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									) : (
										<p className="text-sm text-muted-foreground text-center py-8">
											No executions yet. Click "Generate
											Report" to create your first report.
										</p>
									)}
								</CardContent>
							</Card>
						</TabsContent>
					</div>
					<ReportReadinessRail
						readiness={reportReadiness}
						onGenerate={handleExecute}
						isGenerating={executeMutation.isPending}
						onTest={() => testConnections.mutate()}
						isTesting={testConnections.isPending}
						latestExecution={latestExecution}
						executionCount={
							instance.executionCount ?? executions.length
						}
						onViewHistory={() => goToTab("history")}
						meta={{
							template: instance.template.name,
							dataSource:
								requiredDataSources
									.map((d) => d.name)
									.join(", ") || "—",
							output: instance.template.outputFormat,
							skillsCount: inheritedSkills.length,
						}}
						onViewArtifact={handleViewArtifact}
						organizationId={instanceOrgId}
						viewerUserId={user?.id}
						viewerIsOrgAdmin={isOrganizationAdmin}
						onExecutionCancelled={refetch}
					/>
				</div>
			</Tabs>

			{/* Report Viewer Dialog */}
			<Dialog
				open={!!viewingArtifact}
				onOpenChange={() => {
					setViewingArtifact(null);
					setIsViewerFullscreen(false);
				}}
			>
				<DialogContent
					className={
						isViewerFullscreen
							? "max-w-[100vw] w-[100vw] h-[100vh] max-h-[100vh] m-0 rounded-none flex flex-col"
							: "max-w-4xl max-h-[90vh] flex flex-col"
					}
				>
					<DialogHeader className="flex-row items-center justify-between space-y-0">
						<div>
							<DialogTitle className="flex items-center gap-2">
								<FileTextIcon className="h-5 w-5" />
								{viewingArtifact?.name}
							</DialogTitle>
							<DialogDescription>
								Generated report preview
							</DialogDescription>
						</div>
						<Button
							variant="ghost"
							size="icon"
							onClick={() =>
								setIsViewerFullscreen(!isViewerFullscreen)
							}
							className="h-8 w-8"
							title={
								isViewerFullscreen
									? "Exit fullscreen"
									: "Expand to fullscreen"
							}
						>
							{isViewerFullscreen ? (
								<Minimize2Icon className="h-4 w-4" />
							) : (
								<ExpandIcon className="h-4 w-4" />
							)}
						</Button>
					</DialogHeader>
					<div className="flex-1 overflow-auto border rounded-lg bg-background">
						{viewingArtifact?.content && (
							<>
								{/* Detect if content is HTML (by file extension or content) */}
								{viewingArtifact.name
									.toLowerCase()
									.endsWith(".html") ||
								viewingArtifact.name
									.toLowerCase()
									.endsWith(".htm") ||
								viewingArtifact.content
									.trim()
									.startsWith("<!DOCTYPE") ||
								viewingArtifact.content
									.trim()
									.startsWith("<html") ? (
									<iframe
										srcDoc={viewingArtifact.content}
										className="w-full h-full min-h-[500px] border-0"
										title={viewingArtifact.name}
										sandbox="allow-same-origin"
									/>
								) : (
									<div className="p-6 prose prose-sm dark:prose-invert max-w-none">
										<Markdown
											remarkPlugins={[remarkGfm]}
											components={{
												h1: ({ children }) => (
													<h1 className="text-2xl font-bold mt-6 mb-4 pb-2 border-b">
														{children}
													</h1>
												),
												h2: ({ children }) => (
													<h2 className="text-xl font-semibold mt-5 mb-3">
														{children}
													</h2>
												),
												h3: ({ children }) => (
													<h3 className="text-lg font-medium mt-4 mb-2">
														{children}
													</h3>
												),
												p: ({ children }) => (
													<p className="mb-3 leading-relaxed">
														{children}
													</p>
												),
												ul: ({ children }) => (
													<ul className="list-disc pl-6 mb-3 space-y-1">
														{children}
													</ul>
												),
												ol: ({ children }) => (
													<ol className="list-decimal pl-6 mb-3 space-y-1">
														{children}
													</ol>
												),
												li: ({ children }) => (
													<li className="leading-relaxed">
														{children}
													</li>
												),
												blockquote: ({ children }) => (
													<blockquote className="border-l-4 border-muted-foreground/30 pl-4 italic text-muted-foreground my-4">
														{children}
													</blockquote>
												),
												code: ({
													className,
													children,
												}) => {
													const isInline = !className;
													if (isInline) {
														return (
															<code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">
																{children}
															</code>
														);
													}
													return (
														<pre className="bg-muted p-4 rounded-lg overflow-x-auto my-4">
															<code className="text-sm font-mono">
																{children}
															</code>
														</pre>
													);
												},
												table: ({ children }) => (
													<div className="overflow-x-auto my-4">
														<table className="min-w-full border-collapse border border-border">
															{children}
														</table>
													</div>
												),
												thead: ({ children }) => (
													<thead className="bg-muted">
														{children}
													</thead>
												),
												th: ({ children }) => (
													<th className="border border-border px-3 py-2 text-left font-medium">
														{children}
													</th>
												),
												td: ({ children }) => (
													<td className="border border-border px-3 py-2">
														{children}
													</td>
												),
												hr: () => (
													<hr className="my-6 border-border" />
												),
												strong: ({ children }) => (
													<strong className="font-semibold">
														{children}
													</strong>
												),
											}}
										>
											{viewingArtifact.content}
										</Markdown>
									</div>
								)}
							</>
						)}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								if (viewingArtifact) {
									window.open(
										`/api/reports/artifacts/${viewingArtifact.id}/download`,
										"_blank",
									);
								}
							}}
						>
							<DownloadIcon className="h-4 w-4 mr-2" />
							Download
						</Button>
						<Button onClick={() => setViewingArtifact(null)}>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{artifactDialog?.mode === "send" && (
				<SendArtifactEmailDialog
					artifactId={artifactDialog.artifactId}
					artifactName={artifactDialog.artifactName}
					organizationId={instanceOrgId}
					open
					onOpenChange={(open) => {
						if (!open) {
							setArtifactDialog(null);
						}
					}}
				/>
			)}
			{artifactDialog?.mode === "history" && (
				<ArtifactDeliveryHistoryDialog
					artifactId={artifactDialog.artifactId}
					artifactName={artifactDialog.artifactName}
					organizationId={instanceOrgId}
					open
					onOpenChange={(open) => {
						if (!open) {
							setArtifactDialog(null);
						}
					}}
				/>
			)}
		</div>
	);
}
