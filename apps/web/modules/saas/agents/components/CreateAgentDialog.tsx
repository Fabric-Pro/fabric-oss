"use client";

import type { AgentFramework } from "@repo/database/prisma/generated/client";

type CreatableAgentFramework = Exclude<AgentFramework, "FABRIC_NATIVE">;

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import {
	getProviderDisplayName,
	useAvailableModels,
} from "@shared/hooks/use-available-models";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	BookOpenIcon,
	BrainIcon,
	CalendarIcon,
	CheckCircle2,
	ChevronDownIcon,
	ChevronRightIcon,
	ClockIcon,
	GlobeIcon,
	LayoutTemplateIcon,
	LightbulbIcon,
	Loader2Icon,
	LockIcon,
	PlayIcon,
	PlusIcon,
	ScaleIcon,
	SearchIcon,
	SettingsIcon,
	SparklesIcon,
	TagIcon,
	Trash2Icon,
	UsersIcon,
	WebhookIcon,
	WrenchIcon,
	X,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RetrievalStrategyCallout } from "../../data-connections/components/RetrievalStrategyCallout";
import {
	getCustomAgentTypes,
	getSystemAgentTypes,
} from "../config/agent-types";
import {
	buildAgentBuilderSuggestions,
	getSuggestedDescription,
	getSuggestedSystemPrompt,
} from "../lib/builder-suggestions";
import {
	getAgentSelectionSummary,
	getBuiltInCapabilitiesByType,
} from "../lib/builtin-capabilities";
import { AgentCapabilitiesPickerDialog } from "./AgentCapabilitiesPickerDialog";
import { AgentInsightsSheet } from "./AgentInsightsSheet";
import type { ReasoningMode } from "./ReasoningModeSelector";

/** Emoji options for agent avatar */
const EMOJI_OPTIONS = [
	"🤖",
	"🧠",
	"💡",
	"🔍",
	"📊",
	"💬",
	"🎯",
	"⚡",
	"🛠️",
	"📝",
	"🎨",
	"🔧",
	"📈",
	"🌟",
	"🚀",
	"💻",
	"📱",
	"🔮",
	"🎭",
	"🌈",
	"🦾",
	"🤝",
	"💼",
	"📚",
	"🔬",
	"🎪",
	"🎓",
	"🏆",
	"💎",
	"🌍",
];

/**
 * AI models are now loaded dynamically from the database via useAvailableModels hook
 * This ensures models are always in sync with the user's configured providers
 */

/** Reasoning mode configurations for display */
const REASONING_MODES = [
	{
		id: "lite" as ReasoningMode,
		label: "Fast",
		icon: ZapIcon,
		description: "Quick responses, minimal analysis",
	},
	{
		id: "balanced" as ReasoningMode,
		label: "Balanced",
		icon: ScaleIcon,
		description: "Good balance of speed and depth",
	},
	{
		id: "deep" as ReasoningMode,
		label: "Thorough",
		icon: BrainIcon,
		description: "Deep analysis with verification",
	},
] as const;

type TriggerKind = "manual" | "schedule" | "webhook";

interface Trigger {
	id: string;
	kind: TriggerKind;
	name: string;
	cronExpression?: string;
	timezone?: string;
	webhookUrl?: string;
	enabled: boolean;
}

interface CreateAgentDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	editingAgent?: any;
}

export function CreateAgentDialog({
	open,
	onOpenChange,
	editingAgent,
}: CreateAgentDialogProps) {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();
	const agentTemplatesPath = useContextPath("agent-templates");

	const [formData, setFormData] = useState({
		displayName: "",
		description: "",
		systemPrompt: "",
		scope: "USER" as "USER" | "ORGANIZATION",
		capabilityIds: [] as string[],
		skillIds: [] as string[],
		mcpServers: [] as string[],
		knowledgeSources: [] as string[], // Workspace IDs for knowledge
		// Agent type configuration
		agentCategory: "Custom" as "System" | "Custom",
		framework: "LANGGRAPH" as CreatableAgentFramework,
		// Model configuration - default to Groq's fast model
		model: "groq/llama-3.3-70b-versatile" as string,
		temperature: 0.7,
		maxTokens: 4096,
		maxIterations: 10,
		reasoningMode: "balanced" as ReasoningMode,
		// UI enhancements
		emoji: "🤖" as string,
		tags: [] as string[],
	});

	const [newTag, setNewTag] = useState("");
	const [showEmojiPicker, setShowEmojiPicker] = useState(false);
	const [capabilitiesDialogOpen, setCapabilitiesDialogOpen] = useState(false);
	const [insightsOpen, setInsightsOpen] = useState(false);

	// #6 — Live preview state
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewInput, setPreviewInput] = useState("");
	const [previewResponse, setPreviewResponse] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [hasPreviewed, setHasPreviewed] = useState(false);

	// #7 — Triggers state
	const [triggers, setTriggers] = useState<Trigger[]>([]);

	// Load available models dynamically from database
	// organizationId is auto-injected from context
	const {
		modelsByProvider,
		sortedProviders,
		isLoading: modelsLoading,
	} = useAvailableModels();

	useEffect(() => {
		if (editingAgent) {
			const selectionSummary = getAgentSelectionSummary(editingAgent);
			setFormData({
				displayName: editingAgent.displayName ?? "",
				description: editingAgent.description ?? "",
				systemPrompt: editingAgent.config?.systemPromptKey ?? "",
				scope: editingAgent.scope ?? "USER",
				capabilityIds: selectionSummary.capabilityIds,
				skillIds: selectionSummary.skillIds,
				mcpServers: editingAgent.config?.mcpServers ?? [],
				knowledgeSources: editingAgent.config?.knowledgeSources ?? [],
				agentCategory:
					editingAgent.scope === "SYSTEM" ? "System" : "Custom",
				framework: editingAgent.framework ?? "LANGGRAPH",
				model:
					editingAgent.config?.model ??
					"groq/llama-3.3-70b-versatile",
				temperature: editingAgent.config?.temperature ?? 0.7,
				maxTokens: editingAgent.config?.maxTokens ?? 4096,
				maxIterations: editingAgent.config?.maxIterations ?? 10,
				reasoningMode: editingAgent.config?.reasoningMode ?? "balanced",
				emoji: editingAgent.metadata?.emoji ?? "🤖",
				tags: editingAgent.metadata?.tags ?? [],
			});
			// Initialize triggers from config
			try {
				const rawTriggers = editingAgent.config?.triggers;
				if (rawTriggers) {
					setTriggers(
						typeof rawTriggers === "string"
							? JSON.parse(rawTriggers)
							: rawTriggers,
					);
				} else {
					setTriggers([]);
				}
			} catch {
				setTriggers([]);
			}
		} else {
			resetForm();
			setTriggers([]);
		}
		// Reset preview when dialog opens
		setPreviewOpen(false);
		setPreviewInput("");
		setPreviewResponse(null);
		setHasPreviewed(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editingAgent]);

	// Auto-generate agent name from display name (slugified)
	const generateAgentName = (displayName: string): string => {
		return (
			displayName
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 50) || "agent"
		);
	};

	// Fetch configured MCP servers based on agent scope
	const { data: mcpConfigs = [], isLoading: loadingMcpServers } = useQuery({
		queryKey: [
			"mcp-configs",
			formData.scope === "ORGANIZATION" ? "org" : "user",
			formData.scope === "ORGANIZATION" ? organizationId : undefined,
		],
		queryFn: async () => {
			if (formData.scope === "ORGANIZATION") {
				if (!organizationId) {
					return [];
				}
				return await orpcClient.mcp.configs.list({
					organizationId,
				});
			}
			// User scope - no organizationId needed
			return await orpcClient.mcp.configs.list();
		},
		enabled: open && (formData.scope === "USER" || !!organizationId),
	});

	// Filter only enabled configs
	const mcpServers = mcpConfigs.filter((config: any) => config.enabled);

	// Fetch skills for Dust-style capabilities picker
	const { data: skillsCatalogData, isLoading: loadingSkills } = useQuery({
		queryKey: [
			"skills",
			"catalog",
			formData.scope,
			formData.scope === "ORGANIZATION" ? organizationId : null,
		],
		queryFn: async () => {
			return await orpcClient.skills.list({
				organizationId:
					formData.scope === "ORGANIZATION" ? organizationId : null,
				limit: 100,
				isPublished: true,
			});
		},
		enabled: open,
	});

	// Fetch workspaces for knowledge sources
	// Use null for USER scope to explicitly signal personal context (not undefined which falls back to session)
	const { data: workspacesData, isLoading: loadingWorkspaces } = useQuery({
		queryKey: ["workspaces", organizationId, formData.scope],
		queryFn: async () => {
			return await orpcClient.documentWorkspaces.list({
				organizationId:
					formData.scope === "ORGANIZATION" ? organizationId : null,
				limit: 50,
				status: "ACTIVE",
			});
		},
		enabled: open,
	});

	const workspaces = workspacesData?.workspaces ?? [];
	const catalogSkills = skillsCatalogData?.skills ?? [];
	const selectedSkillDetails = useMemo(() => {
		return catalogSkills.filter((skill) =>
			formData.skillIds.includes(skill.id),
		);
	}, [catalogSkills, formData.skillIds]);
	const selectedCapabilityDetails = useMemo(() => {
		const tools = getBuiltInCapabilitiesByType("tool");
		return tools.filter((capability) =>
			formData.capabilityIds.includes(capability.id),
		);
	}, [formData.capabilityIds]);
	const builderReadiness = useMemo(
		() => [
			{
				label: "Knowledge",
				value: formData.knowledgeSources.length,
			},
			{
				label: "Capabilities",
				value:
					formData.skillIds.length +
					formData.capabilityIds.length +
					formData.mcpServers.length,
			},
			{
				label: "Triggers",
				value: triggers.filter((trigger) => trigger.enabled).length,
			},
		],
		[
			formData.capabilityIds.length,
			formData.knowledgeSources.length,
			formData.mcpServers.length,
			formData.skillIds.length,
			triggers,
		],
	);
	const builderSuggestions = useMemo(
		() =>
			buildAgentBuilderSuggestions({
				displayName: formData.displayName,
				description: formData.description,
				systemPrompt: formData.systemPrompt,
				knowledgeSourceCount: formData.knowledgeSources.length,
				capabilityCount:
					formData.skillIds.length +
					formData.capabilityIds.length +
					formData.mcpServers.length,
				hasPreviewed,
			}),
		[
			formData.capabilityIds.length,
			formData.description,
			formData.displayName,
			formData.knowledgeSources.length,
			formData.mcpServers.length,
			formData.skillIds.length,
			formData.systemPrompt,
			hasPreviewed,
		],
	);

	// Create/update agent mutation (instant - no deployment needed)
	const saveMutation = useMutation({
		mutationFn: async () => {
			const selectedSkillsForConfig = selectedSkillDetails.map(
				(skill) => ({
					id: skill.id,
					name: skill.name,
					description: skill.description,
				}),
			);
			const selectedCapabilitiesForMetadata =
				selectedCapabilityDetails.map((capability) => ({
					id: capability.id,
					name: capability.name,
					description: capability.description,
					type: capability.type,
				}));
			if (editingAgent) {
				return await orpcClient.agents.registry.update({
					id: editingAgent.id,
					displayName: formData.displayName,
					description: formData.description,
					config: {
						...(editingAgent.config ?? {}),
						model: formData.model,
						temperature: formData.temperature,
						maxTokens: formData.maxTokens,
						maxIterations: formData.maxIterations,
						reasoningMode: formData.reasoningMode,
						systemPromptKey: formData.systemPrompt,
						mcpServers: formData.mcpServers,
						knowledgeSources: formData.knowledgeSources,
						tools: formData.capabilityIds,
						capabilityIds: formData.capabilityIds,
						skillIds: formData.skillIds,
						skills: selectedSkillsForConfig,
						triggers: JSON.stringify(triggers),
					},
					metadata: {
						...(editingAgent.metadata ?? {}),
						updatedVia: "ui",
						emoji: formData.emoji,
						tags: formData.tags,
						selectedCapabilities: selectedCapabilitiesForMetadata,
						selectedSkills: selectedSkillsForConfig,
					},
				});
			}

			const agentName = generateAgentName(formData.displayName);
			return await orpcClient.agents.registry.create({
				name: agentName,
				displayName: formData.displayName,
				description: formData.description,
				framework: formData.framework,
				scope: formData.scope,
				organizationId:
					formData.scope === "ORGANIZATION" && organizationId
						? organizationId
						: undefined,
				config: {
					model: formData.model,
					temperature: formData.temperature,
					maxTokens: formData.maxTokens,
					maxIterations: formData.maxIterations,
					reasoningMode: formData.reasoningMode,
					systemPromptKey: formData.systemPrompt,
					mcpServers: formData.mcpServers,
					knowledgeSources: formData.knowledgeSources,
					tools: formData.capabilityIds,
					capabilityIds: formData.capabilityIds,
					skillIds: formData.skillIds,
					skills: selectedSkillsForConfig,
					predictiveStates: [],
					triggers: JSON.stringify(triggers),
				},
				metadata: {
					createdVia: "ui",
					version: "1.0.0",
					agentCategory: formData.agentCategory,
					emoji: formData.emoji,
					tags: formData.tags,
					selectedCapabilities: selectedCapabilitiesForMetadata,
					selectedSkills: selectedSkillsForConfig,
				},
			});
		},
		onSuccess: (agent) => {
			toast.success(
				`Agent "${agent.displayName}" ${
					editingAgent ? "updated" : "created"
				} successfully!`,
				{ duration: 5000 },
			);
			queryClient.invalidateQueries({
				queryKey: ["agents", "registry", "list"],
			});
			onOpenChange(false);
			resetForm();
		},
		onError: (error: Error) => {
			toast.error(`Failed to create agent: ${error.message}`, {
				duration: 7000,
			});
		},
	});

	const resetForm = () => {
		setFormData({
			displayName: "",
			description: "",
			systemPrompt: "",
			scope: "USER",
			capabilityIds: [],
			skillIds: [],
			mcpServers: [],
			knowledgeSources: [],
			agentCategory: "Custom",
			framework: "LANGGRAPH",
			// Default to Groq's fast model
			model: "groq/llama-3.3-70b-versatile",
			temperature: 0.7,
			maxTokens: 4096,
			maxIterations: 10,
			reasoningMode: "balanced",
			emoji: "🤖",
			tags: [],
		});
		setNewTag("");
	};

	const addTag = () => {
		if (newTag.trim() && !formData.tags.includes(newTag.trim())) {
			setFormData((prev) => ({
				...prev,
				tags: [...prev.tags, newTag.trim()],
			}));
			setNewTag("");
		}
	};

	const removeTag = (tag: string) => {
		setFormData((prev) => ({
			...prev,
			tags: prev.tags.filter((t) => t !== tag),
		}));
	};

	const removeMcpServer = (serverId: string) => {
		setFormData((prev) => ({
			...prev,
			mcpServers: prev.mcpServers.filter((id) => id !== serverId),
		}));
	};

	const removeSkill = (skillId: string) => {
		setFormData((prev) => ({
			...prev,
			skillIds: prev.skillIds.filter((id) => id !== skillId),
		}));
	};

	const removeCapability = (capabilityId: string) => {
		setFormData((prev) => ({
			...prev,
			capabilityIds: prev.capabilityIds.filter(
				(id) => id !== capabilityId,
			),
		}));
	};

	const toggleWorkspace = (workspaceId: string) => {
		setFormData((prev) => ({
			...prev,
			knowledgeSources: prev.knowledgeSources.includes(workspaceId)
				? prev.knowledgeSources.filter((id) => id !== workspaceId)
				: [...prev.knowledgeSources, workspaceId],
		}));
	};

	const removeWorkspace = (workspaceId: string) => {
		setFormData((prev) => ({
			...prev,
			knowledgeSources: prev.knowledgeSources.filter(
				(id) => id !== workspaceId,
			),
		}));
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		saveMutation.mutate();
	};

	// #6 — Live preview: run the agent with a test message using inline config
	// Uses previewDraft endpoint (no registry lookup) — works for unsaved drafts
	// and org-scoped agents alike.
	const handleRunPreview = async () => {
		if (!previewInput.trim() || previewLoading) {
			return;
		}
		setPreviewLoading(true);
		setPreviewResponse(null);
		try {
			const result = await orpcClient.agents.previewDraft({
				systemPrompt: formData.systemPrompt,
				userMessage: previewInput,
				model: formData.model || undefined,
				capabilityIds: formData.capabilityIds,
				mcpConfigIds: formData.mcpServers,
				maxIterations: 5,
				organizationId: organizationId ?? null,
			});
			setPreviewResponse(
				result.success
					? result.response || "No response returned."
					: result.error || "Agent preview failed.",
			);
			setHasPreviewed(true);
		} catch (err) {
			setPreviewResponse(
				`Preview failed: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
		} finally {
			setPreviewLoading(false);
		}
	};

	// #7 — Trigger helpers
	const addTrigger = () => {
		setTriggers((prev) => [
			...prev,
			{
				id: crypto.randomUUID(),
				kind: "manual",
				name: "",
				enabled: true,
			},
		]);
	};

	const updateTrigger = (
		id: string,
		patch: Partial<{
			kind: TriggerKind;
			name: string;
			cronExpression: string;
			timezone: string;
			webhookUrl: string;
			enabled: boolean;
		}>,
	) => {
		setTriggers((prev) =>
			prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
		);
	};

	const removeTrigger = (id: string) => {
		setTriggers((prev) => prev.filter((t) => t.id !== id));
	};

	const handleBuilderSuggestionAction = (
		action:
			| "seed-description"
			| "seed-system-prompt"
			| "open-capabilities"
			| "open-preview"
			| "review-knowledge",
	) => {
		switch (action) {
			case "seed-description":
				setFormData((prev) => ({
					...prev,
					description: prev.description.trim()
						? prev.description
						: getSuggestedDescription(prev.displayName),
				}));
				return;
			case "seed-system-prompt":
				setFormData((prev) => ({
					...prev,
					systemPrompt: prev.systemPrompt.trim()
						? prev.systemPrompt
						: getSuggestedSystemPrompt(prev.displayName),
				}));
				return;
			case "open-capabilities":
				setCapabilitiesDialogOpen(true);
				return;
			case "open-preview":
				setPreviewOpen(true);
				setPreviewInput((current) =>
					current.trim()
						? current
						: `What should I use ${formData.displayName || "this agent"} for?`,
				);
				return;
			case "review-knowledge":
				document
					.getElementById("agent-builder-knowledge")
					?.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[95vw] w-full h-[90vh] flex flex-col p-0">
				{/* Header */}
				<DialogHeader className="px-6 pt-5 pb-4 border-b shrink-0">
					<div className="flex items-start justify-between">
						<div>
							<DialogTitle className="text-xl font-semibold">
								{editingAgent
									? "Edit Agent"
									: "Create New Agent"}
							</DialogTitle>
							<DialogDescription className="text-sm text-muted-foreground mt-1">
								{editingAgent
									? "Update your agent's configuration and capabilities"
									: "Build a custom AI agent with tools, knowledge, and specific behaviors"}
							</DialogDescription>
						</div>
						<div className="flex items-center gap-2">
							{editingAgent?.id && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setInsightsOpen(true)}
								>
									<SparklesIcon className="mr-1.5 h-3.5 w-3.5" />
									Agent insights
								</Button>
							)}
							<Link
								href={agentTemplatesPath}
								className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors border rounded-lg px-3 py-2 bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-900/20 dark:to-indigo-900/20 border-purple-200 dark:border-purple-800"
								onClick={() => onOpenChange(false)}
							>
								<LayoutTemplateIcon className="h-4 w-4 text-purple-500" />
								<span>Start from Template</span>
								<SparklesIcon className="h-3 w-3 text-purple-400" />
							</Link>
						</div>
					</div>
				</DialogHeader>

				{/* Two-column layout */}
				<div className="flex flex-1 overflow-hidden">
					{/* Main Content Area */}
					<form
						onSubmit={handleSubmit}
						className="flex-1 overflow-y-auto px-6 py-5 space-y-6"
					>
						{/* Settings Section */}
						<div className="space-y-4">
							<div className="flex items-center gap-2">
								<SettingsIcon className="h-4 w-4 text-slate-500" />
								<h3 className="text-sm font-semibold">
									Settings
								</h3>
							</div>

							{/* Name with Emoji Picker */}
							<div className="space-y-3">
								<Label className="text-sm font-medium">
									Name
								</Label>
								<div className="flex gap-3">
									{/* Emoji Picker */}
									<Popover
										open={showEmojiPicker}
										onOpenChange={setShowEmojiPicker}
									>
										<PopoverTrigger asChild>
											<button
												type="button"
												className="w-14 h-14 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-900 flex items-center justify-center text-2xl hover:shadow-md transition-all border-2 border-transparent hover:border-primary/20"
											>
												{formData.emoji}
											</button>
										</PopoverTrigger>
										<PopoverContent
											className="w-64 p-3"
											align="start"
										>
											<div className="grid grid-cols-6 gap-2">
												{EMOJI_OPTIONS.map((emoji) => (
													<button
														key={emoji}
														type="button"
														onClick={() => {
															setFormData(
																(prev) => ({
																	...prev,
																	emoji,
																}),
															);
															setShowEmojiPicker(
																false,
															);
														}}
														className={cn(
															"w-9 h-9 rounded-lg flex items-center justify-center text-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors",
															formData.emoji ===
																emoji &&
																"bg-primary/10 ring-2 ring-primary",
														)}
													>
														{emoji}
													</button>
												))}
											</div>
										</PopoverContent>
									</Popover>

									<Input
										placeholder="My Custom Agent"
										value={formData.displayName}
										onChange={(e) =>
											setFormData({
												...formData,
												displayName: e.target.value,
											})
										}
										className="flex-1 h-14 text-lg rounded-xl bg-slate-100 dark:bg-slate-900 border-0"
										required
									/>
								</div>
							</div>
						</div>

						{/* Agent Type Selection - Compact */}
						<div className="space-y-3">
							<Label className="text-sm font-medium">
								Agent Type
							</Label>
							<div className="grid grid-cols-3 gap-3">
								{/* System Agents */}
								{getSystemAgentTypes().map((agentType) => (
									<button
										key={agentType.framework}
										type="button"
										onClick={() =>
											setFormData({
												...formData,
												agentCategory: "System",
												framework:
													agentType.framework as CreatableAgentFramework,
											})
										}
										className={cn(
											"relative p-3 border-2 rounded-xl text-left transition-all hover:border-primary/50",
											formData.agentCategory ===
												"System" &&
												formData.framework ===
													agentType.framework
												? "border-primary bg-primary/5"
												: "border-border",
										)}
									>
										{formData.agentCategory === "System" &&
											formData.framework ===
												agentType.framework && (
												<CheckCircle2 className="absolute top-2 right-2 h-4 w-4 text-primary" />
											)}
										<div className="flex items-center gap-2">
											<span className="text-xl">
												{agentType.emoji}
											</span>
											<span className="font-medium text-sm">
												{agentType.displayName}
											</span>
										</div>
										<p className="text-xs text-muted-foreground mt-1 line-clamp-1">
											{agentType.description}
										</p>
									</button>
								))}
								{/* Custom Agent */}
								<button
									type="button"
									onClick={() =>
										setFormData({
											...formData,
											agentCategory: "Custom",
											framework: "LANGGRAPH",
										})
									}
									className={cn(
										"relative p-3 border-2 rounded-xl text-left transition-all hover:border-primary/50",
										formData.agentCategory === "Custom"
											? "border-primary bg-primary/5"
											: "border-border",
									)}
								>
									{formData.agentCategory === "Custom" && (
										<CheckCircle2 className="absolute top-2 right-2 h-4 w-4 text-primary" />
									)}
									<div className="flex items-center gap-2">
										<span className="text-xl">🤖</span>
										<span className="font-medium text-sm">
											Custom
										</span>
									</div>
									<p className="text-xs text-muted-foreground mt-1 line-clamp-1">
										Custom agent with your logic
									</p>
								</button>
							</div>

							{/* Framework Selection (only for Custom agents) */}
							{formData.agentCategory === "Custom" && (
								<div className="space-y-2 pl-4 border-l-2 border-primary/30">
									<Label className="text-xs">Framework</Label>
									<Select
										value={formData.framework}
										onValueChange={(
											value: CreatableAgentFramework,
										) =>
											setFormData({
												...formData,
												framework: value,
											})
										}
									>
										<SelectTrigger className="rounded-lg">
											<SelectValue placeholder="Select framework" />
										</SelectTrigger>
										<SelectContent>
											{getCustomAgentTypes().map(
												(agentType) => (
													<SelectItem
														key={
															agentType.framework
														}
														value={
															agentType.framework
														}
													>
														{agentType.emoji}{" "}
														{agentType.displayName}
													</SelectItem>
												),
											)}
										</SelectContent>
									</Select>
								</div>
							)}
						</div>

						{/* Description */}
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<Label className="text-sm font-medium">
									Description
								</Label>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-primary"
								>
									<SparklesIcon className="h-3 w-3" />
									Generate
								</Button>
							</div>
							<Textarea
								placeholder="A helpful agent that can assist with..."
								value={formData.description}
								onChange={(e) =>
									setFormData({
										...formData,
										description: e.target.value,
									})
								}
								rows={2}
								className="rounded-xl bg-slate-100 dark:bg-slate-900 border-0 resize-none"
								required
							/>
						</div>

						{/* Instructions Section */}
						<div className="space-y-3">
							<Label className="text-sm font-medium">
								Instructions
							</Label>
							<div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700">
								<Textarea
									placeholder="You are a helpful AI assistant that specializes in..."
									value={formData.systemPrompt}
									onChange={(e) =>
										setFormData({
											...formData,
											systemPrompt: e.target.value,
										})
									}
									rows={12}
									className="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border-0 rounded-none font-mono text-sm placeholder:text-slate-400"
									required
								/>
							</div>
							<p className="text-xs text-muted-foreground">
								Define your agent's behavior, expertise, and
								response style
							</p>
						</div>

						{/* Editors & Access Section */}
						<div
							id="agent-builder-knowledge"
							className="space-y-4 border-t pt-5"
						>
							<div className="flex items-center gap-2">
								<UsersIcon className="h-4 w-4 text-slate-500" />
								<h3 className="text-sm font-semibold">
									Editors & Access
								</h3>
							</div>

							{/* Visibility */}
							<div className="space-y-3">
								<Label className="text-xs text-muted-foreground">
									Visibility
								</Label>
								<div className="flex gap-2">
									<button
										type="button"
										onClick={() =>
											setFormData({
												...formData,
												scope: "USER",
											})
										}
										className={cn(
											"flex-1 flex items-center gap-2 p-3 rounded-xl border-2 transition-all",
											formData.scope === "USER"
												? "border-primary bg-primary/5"
												: "border-border hover:border-primary/30",
										)}
									>
										<LockIcon className="h-4 w-4 text-highlight" />
										<div className="text-left">
											<p className="text-sm font-medium">
												Personal
											</p>
											<p className="text-xs text-muted-foreground">
												Only visible to you
											</p>
										</div>
									</button>
									<button
										type="button"
										onClick={() =>
											setFormData({
												...formData,
												scope: "ORGANIZATION",
											})
										}
										className={cn(
											"flex-1 flex items-center gap-2 p-3 rounded-xl border-2 transition-all",
											formData.scope === "ORGANIZATION"
												? "border-primary bg-primary/5"
												: "border-border hover:border-primary/30",
										)}
									>
										<GlobeIcon className="h-4 w-4 text-blue-500" />
										<div className="text-left">
											<p className="text-sm font-medium">
												Organization
											</p>
											<p className="text-xs text-muted-foreground">
												Visible to all members
											</p>
										</div>
									</button>
								</div>
							</div>
						</div>

						{/* Tags Section */}
						<div className="space-y-3 border-t pt-5">
							<div className="flex items-center gap-2">
								<TagIcon className="h-4 w-4 text-slate-500" />
								<h3 className="text-sm font-semibold">Tags</h3>
							</div>
							<div className="flex flex-wrap gap-2">
								{formData.tags.map((tag) => (
									<Badge
										key={tag}
										variant="secondary"
										className="flex items-center gap-1 rounded-full px-3 py-1"
									>
										{tag}
										<X
											className="h-3 w-3 cursor-pointer hover:text-destructive"
											onClick={() => removeTag(tag)}
										/>
									</Badge>
								))}
								<div className="flex items-center gap-1">
									<Input
										placeholder="Add tag..."
										value={newTag}
										onChange={(e) =>
											setNewTag(e.target.value)
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addTag();
											}
										}}
										className="h-7 w-24 text-xs rounded-full bg-slate-100 dark:bg-slate-800 border-0"
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="h-7 w-7"
										onClick={addTag}
									>
										<PlusIcon className="h-3 w-3" />
									</Button>
								</div>
							</div>
						</div>

						{/* Model Configuration Section - Compact */}
						<div className="space-y-4 border-t pt-5">
							<div className="flex items-center gap-2">
								<BrainIcon className="h-4 w-4 text-purple-500" />
								<h3 className="text-sm font-semibold">
									Model Configuration
								</h3>
							</div>

							{/* Model & Settings Row */}
							<div className="grid grid-cols-2 gap-4">
								{/* AI Model */}
								<div className="space-y-2">
									<Label className="text-xs text-muted-foreground">
										AI Model
									</Label>
									<Select
										value={formData.model}
										onValueChange={(value) =>
											setFormData({
												...formData,
												model: value,
											})
										}
										disabled={modelsLoading}
									>
										<SelectTrigger className="rounded-lg">
											<SelectValue
												placeholder={
													modelsLoading
														? "Loading models..."
														: "Select model..."
												}
											/>
										</SelectTrigger>
										<SelectContent>
											{modelsLoading ? (
												<SelectItem
													value="loading"
													disabled
												>
													Loading models...
												</SelectItem>
											) : sortedProviders.length === 0 ? (
												<SelectItem
													value="no-models"
													disabled
												>
													No models available.
													Configure an AI provider in
													Settings.
												</SelectItem>
											) : (
												sortedProviders.map(
													(provider) => {
														const providerModels =
															modelsByProvider[
																provider
															] || [];
														if (
															providerModels.length ===
															0
														) {
															return null;
														}

														return (
															<div key={provider}>
																{/* Provider group label */}
																<div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
																	{getProviderDisplayName(
																		provider,
																	)}
																</div>
																{/* Models for this provider */}
																{providerModels.map(
																	(model) => {
																		// Format model value as provider/providerModelId
																		const providerPrefix =
																			provider
																				.toLowerCase()
																				.replace(
																					"_direct",
																					"",
																				);
																		const modelValue = `${providerPrefix}/${model.providerModelId}`;

																		return (
																			<SelectItem
																				key={
																					model.id
																				}
																				value={
																					modelValue
																				}
																			>
																				<div className="flex items-center gap-2">
																					<span>
																						{
																							model.displayName
																						}
																					</span>
																					<Badge
																						variant="outline"
																						className="text-xs"
																					>
																						{getProviderDisplayName(
																							provider,
																						)}
																					</Badge>
																				</div>
																			</SelectItem>
																		);
																	},
																)}
															</div>
														);
													},
												)
											)}
										</SelectContent>
									</Select>
								</div>

								{/* Max Tokens */}
								<div className="space-y-2">
									<Label className="text-xs text-muted-foreground">
										Max Tokens
									</Label>
									<Select
										value={formData.maxTokens.toString()}
										onValueChange={(value) =>
											setFormData({
												...formData,
												maxTokens: Number.parseInt(
													value,
													10,
												),
											})
										}
									>
										<SelectTrigger className="rounded-lg">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="1024">
												1,024 (Short)
											</SelectItem>
											<SelectItem value="2048">
												2,048 (Medium)
											</SelectItem>
											<SelectItem value="4096">
												4,096 (Standard)
											</SelectItem>
											<SelectItem value="8192">
												8,192 (Long)
											</SelectItem>
											<SelectItem value="16384">
												16,384 (Extended)
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
							</div>

							{/* Temperature Slider */}
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label className="text-xs text-muted-foreground">
										Temperature
									</Label>
									<span className="text-xs font-mono text-muted-foreground">
										{formData.temperature.toFixed(1)}
									</span>
								</div>
								<Slider
									value={[formData.temperature]}
									onValueChange={([value]) =>
										setFormData({
											...formData,
											temperature: value,
										})
									}
									min={0}
									max={1}
									step={0.1}
									className="w-full"
								/>
								<div className="flex justify-between text-xs text-muted-foreground">
									<span>Focused</span>
									<span>Creative</span>
								</div>
							</div>

							{/* Max Steps per Run Slider */}
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label className="text-xs text-muted-foreground">
										Max Steps per Run
									</Label>
									<span className="text-xs font-mono text-muted-foreground">
										{formData.maxIterations} step
										{formData.maxIterations === 1
											? ""
											: "s"}
									</span>
								</div>
								<Slider
									value={[formData.maxIterations]}
									onValueChange={([value]) =>
										setFormData({
											...formData,
											maxIterations: value,
										})
									}
									min={1}
									max={20}
									step={1}
									className="w-full"
								/>
								<div className="flex justify-between text-xs text-muted-foreground">
									<span>1 step</span>
									<span>20 steps</span>
								</div>
								<p className="text-xs text-muted-foreground">
									Maximum tool-use steps per agent run. Lower
									= faster, Higher = more thorough.
								</p>
							</div>

							{/* Reasoning Mode - Compact */}
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">
									Reasoning Mode
								</Label>
								<div className="flex gap-2">
									{REASONING_MODES.map((mode) => {
										const Icon = mode.icon;
										const isSelected =
											formData.reasoningMode === mode.id;
										return (
											<button
												key={mode.id}
												type="button"
												onClick={() =>
													setFormData({
														...formData,
														reasoningMode: mode.id,
													})
												}
												className={cn(
													"flex-1 flex items-center justify-center gap-2 p-2 rounded-xl border-2 transition-all",
													isSelected
														? "border-primary bg-primary/5"
														: "border-border hover:border-primary/50",
												)}
											>
												<Icon
													className={cn(
														"h-4 w-4",
														isSelected
															? "text-primary"
															: "text-muted-foreground",
													)}
												/>
												<span
													className={cn(
														"text-sm font-medium",
														isSelected &&
															"text-primary",
													)}
												>
													{mode.label}
												</span>
											</button>
										);
									})}
								</div>
							</div>
						</div>

						{/* Knowledge & Capabilities Section */}
						<div className="space-y-4 border-t pt-5">
							<div className="flex items-center gap-2">
								<SparklesIcon className="h-4 w-4 text-indigo-500" />
								<h3 className="text-sm font-semibold">
									Knowledge & Capabilities
								</h3>
							</div>

							{/* Two-column layout for Knowledge and Capabilities */}
							<div className="grid grid-cols-2 gap-4">
								{/* Searchable knowledge */}
								<div className="space-y-3">
									<RetrievalStrategyCallout />
									<div className="flex items-center justify-between">
										<Label className="text-xs text-muted-foreground flex items-center gap-1.5">
											<BookOpenIcon className="h-3.5 w-3.5 text-indigo-500" />
											Searchable Knowledge
										</Label>
										<Badge
											variant="outline"
											className="text-xs"
										>
											{formData.knowledgeSources.length}{" "}
											selected
										</Badge>
									</div>

									{/* Selected badges */}
									{formData.knowledgeSources.length > 0 && (
										<div className="flex flex-wrap gap-1.5">
											{formData.knowledgeSources
												.slice(0, 3)
												.map((workspaceId) => {
													const workspace =
														workspaces.find(
															(ws: any) =>
																ws.id ===
																workspaceId,
														);
													return (
														<Badge
															key={workspaceId}
															variant="secondary"
															className="flex items-center gap-1 bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300 text-xs"
														>
															{workspace?.name ||
																"Workspace"}
															<X
																className="h-2.5 w-2.5 cursor-pointer"
																onClick={() =>
																	removeWorkspace(
																		workspaceId,
																	)
																}
															/>
														</Badge>
													);
												})}
											{formData.knowledgeSources.length >
												3 && (
												<Badge
													variant="outline"
													className="text-xs"
												>
													+
													{formData.knowledgeSources
														.length - 3}
												</Badge>
											)}
										</div>
									)}

									{/* Workspace List */}
									<div className="border rounded-xl max-h-40 overflow-y-auto bg-white dark:bg-slate-800">
										{loadingWorkspaces ? (
											<div className="p-3 text-center text-xs text-muted-foreground">
												Loading...
											</div>
										) : workspaces.length === 0 ? (
											<div className="p-4 text-center">
												<BookOpenIcon className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
												<p className="text-xs text-muted-foreground">
													No workspaces
												</p>
											</div>
										) : (
											<div className="divide-y">
												{workspaces.map(
													(workspace: any) => (
														<label
															key={workspace.id}
															htmlFor={`ws-${workspace.id}`}
															className="flex items-center gap-2 p-2.5 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/10 cursor-pointer transition-colors"
														>
															<Checkbox
																id={`ws-${workspace.id}`}
																checked={formData.knowledgeSources.includes(
																	workspace.id,
																)}
																onCheckedChange={() =>
																	toggleWorkspace(
																		workspace.id,
																	)
																}
															/>
															<span className="text-sm truncate">
																{workspace.name}
															</span>
														</label>
													),
												)}
											</div>
										)}
									</div>
								</div>

								{/* Capabilities */}
								<div className="space-y-3">
									<div className="flex items-center justify-between">
										<Label className="text-xs text-muted-foreground flex items-center gap-1.5">
											<WrenchIcon className="h-3.5 w-3.5 text-success" />
											Capabilities
										</Label>
										<Badge
											variant="outline"
											className="text-xs"
										>
											{formData.skillIds.length +
												formData.capabilityIds.length +
												formData.mcpServers.length}{" "}
											selected
										</Badge>
									</div>

									{formData.skillIds.length > 0 && (
										<div className="space-y-2">
											<div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
												Skills
											</div>
											<div className="flex flex-wrap gap-1.5">
												{selectedSkillDetails.map(
													(skill) => (
														<Badge
															key={skill.id}
															variant="secondary"
															className="flex items-center gap-1 bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300 text-xs"
														>
															{skill.name}
															<X
																className="h-2.5 w-2.5 cursor-pointer"
																onClick={() =>
																	removeSkill(
																		skill.id,
																	)
																}
															/>
														</Badge>
													),
												)}
											</div>
										</div>
									)}

									{formData.capabilityIds.length > 0 && (
										<div className="space-y-2">
											<div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
												Built-in tools
											</div>
											<div className="flex flex-wrap gap-1.5">
												{selectedCapabilityDetails.map(
													(capability) => (
														<Badge
															key={capability.id}
															variant="secondary"
															className="flex items-center gap-1 bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 text-xs"
														>
															{capability.name}
															<X
																className="h-2.5 w-2.5 cursor-pointer"
																onClick={() =>
																	removeCapability(
																		capability.id,
																	)
																}
															/>
														</Badge>
													),
												)}
											</div>
										</div>
									)}

									{formData.mcpServers.length > 0 && (
										<div className="space-y-2">
											<div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
												Connected tools
											</div>
											<div className="flex flex-wrap gap-1.5">
												{formData.mcpServers.map(
													(configId) => {
														const config =
															mcpServers.find(
																(c: any) =>
																	c.id ===
																	configId,
															);
														const displayName =
															config?.displayName ||
															config?.mcpServer
																?.name ||
															"Tool";
														return (
															<Badge
																key={configId}
																variant="secondary"
																className="flex items-center gap-1 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 text-xs"
															>
																{displayName}
																<X
																	className="h-2.5 w-2.5 cursor-pointer"
																	onClick={() =>
																		removeMcpServer(
																			configId,
																		)
																	}
																/>
															</Badge>
														);
													},
												)}
											</div>
										</div>
									)}

									<div className="rounded-xl border bg-white p-4 dark:bg-slate-800">
										<div className="flex items-start justify-between gap-3">
											<div>
												<div className="font-medium text-sm">
													Add capabilities
												</div>
												<p className="mt-1 text-xs text-muted-foreground">
													Choose from Dust-style
													skills, built-in tools, and
													connected MCP servers.
												</p>
											</div>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() =>
													setCapabilitiesDialogOpen(
														true,
													)
												}
											>
												<PlusIcon className="mr-1.5 h-3.5 w-3.5" />
												Add capabilities
											</Button>
										</div>

										<div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
											<SearchIcon className="h-3.5 w-3.5" />
											{loadingSkills || loadingMcpServers
												? "Loading skills and tools..."
												: `${catalogSkills.length} skills, ${mcpServers.length} connected tools, ${getBuiltInCapabilitiesByType("tool").length} built-in tools available`}
										</div>
									</div>
								</div>
							</div>
						</div>

						{/* #7 — Triggers (edit mode only) */}
						{editingAgent && (
							<div className="space-y-4 border-t pt-5">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<CalendarIcon className="h-4 w-4 text-slate-500" />
										<h3 className="text-sm font-semibold">
											Triggers
										</h3>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={addTrigger}
									>
										<PlusIcon className="mr-1.5 h-3.5 w-3.5" />
										Add Trigger
									</Button>
								</div>

								{triggers.length === 0 && (
									<p className="text-xs text-muted-foreground">
										No triggers configured. Add one to
										automate this agent.
									</p>
								)}

								<div className="space-y-3">
									{triggers.map((trigger) => (
										<div
											key={trigger.id}
											className="rounded-xl border bg-card p-4 space-y-3"
										>
											{/* Header row */}
											<div className="flex items-center justify-between gap-2">
												<div className="flex gap-1">
													{(
														[
															"manual",
															"schedule",
															"webhook",
														] as TriggerKind[]
													).map((k) => (
														<button
															key={k}
															type="button"
															onClick={() =>
																updateTrigger(
																	trigger.id,
																	{ kind: k },
																)
															}
															className={cn(
																"px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors",
																trigger.kind ===
																	k
																	? "border-primary bg-primary/10 text-primary"
																	: "border-border text-muted-foreground hover:border-primary/40",
															)}
														>
															{k === "manual" && (
																<ZapIcon className="inline h-3 w-3 mr-1" />
															)}
															{k ===
																"schedule" && (
																<ClockIcon className="inline h-3 w-3 mr-1" />
															)}
															{k ===
																"webhook" && (
																<WebhookIcon className="inline h-3 w-3 mr-1" />
															)}
															{k}
														</button>
													))}
												</div>
												<div className="flex items-center gap-2">
													<Switch
														checked={
															trigger.enabled
														}
														onCheckedChange={(
															enabled,
														) =>
															updateTrigger(
																trigger.id,
																{ enabled },
															)
														}
													/>
													<button
														type="button"
														onClick={() =>
															removeTrigger(
																trigger.id,
															)
														}
														className="text-muted-foreground hover:text-destructive transition-colors"
													>
														<Trash2Icon className="h-4 w-4" />
													</button>
												</div>
											</div>

											{/* Name */}
											<Input
												placeholder="Trigger name"
												value={trigger.name}
												onChange={(e) =>
													updateTrigger(trigger.id, {
														name: e.target.value,
													})
												}
												className="h-8 text-sm rounded-lg"
											/>

											{/* Schedule fields */}
											{trigger.kind === "schedule" && (
												<div className="grid grid-cols-2 gap-2">
													<Input
														placeholder="0 9 * * 1-5"
														value={
															trigger.cronExpression ??
															""
														}
														onChange={(e) =>
															updateTrigger(
																trigger.id,
																{
																	cronExpression:
																		e.target
																			.value,
																},
															)
														}
														className="h-8 text-sm rounded-lg font-mono"
													/>
													<Input
														placeholder="America/New_York"
														value={
															trigger.timezone ??
															""
														}
														onChange={(e) =>
															updateTrigger(
																trigger.id,
																{
																	timezone:
																		e.target
																			.value,
																},
															)
														}
														className="h-8 text-sm rounded-lg"
													/>
												</div>
											)}

											{/* Webhook URL */}
											{trigger.kind === "webhook" && (
												<Input
													readOnly
													value={
														trigger.webhookUrl ?? ""
													}
													placeholder="Webhook URL generated on save"
													className="h-8 text-sm rounded-lg bg-muted font-mono"
												/>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* #6 — Live Preview / Test Agent */}
						<div className="space-y-3 border-t pt-5">
							<button
								type="button"
								onClick={() => setPreviewOpen((v) => !v)}
								className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors"
							>
								{previewOpen ? (
									<ChevronDownIcon className="h-4 w-4" />
								) : (
									<ChevronRightIcon className="h-4 w-4" />
								)}
								<PlayIcon className="h-4 w-4 text-secondary" />
								Test Agent
							</button>

							{previewOpen && (
								<div className="space-y-3">
									<Textarea
										placeholder="Send a test message..."
										value={previewInput}
										onChange={(e) =>
											setPreviewInput(e.target.value)
										}
										rows={3}
										className="resize-none rounded-xl bg-muted border-0"
									/>
									<Button
										type="button"
										size="sm"
										disabled={
											previewLoading ||
											!previewInput.trim()
										}
										onClick={handleRunPreview}
										className="gap-1.5"
									>
										{previewLoading ? (
											<>
												<Loader2Icon className="h-3.5 w-3.5 motion-safe:animate-spin" />
												Running...
											</>
										) : (
											<>
												<PlayIcon className="h-3.5 w-3.5" />
												Run Test
											</>
										)}
									</Button>
									{previewResponse !== null && (
										<div className="rounded-xl bg-muted border p-4 text-sm text-muted-foreground whitespace-pre-wrap">
											{previewResponse}
										</div>
									)}
								</div>
							)}
						</div>
					</form>

					<AgentCapabilitiesPickerDialog
						open={capabilitiesDialogOpen}
						onOpenChange={setCapabilitiesDialogOpen}
						selectedSkillIds={formData.skillIds}
						selectedCapabilityIds={formData.capabilityIds}
						selectedMcpServerIds={formData.mcpServers}
						skills={catalogSkills}
						mcpServers={mcpServers}
						onApply={({
							skillIds,
							capabilityIds,
							mcpServerIds,
						}) => {
							setFormData((prev) => ({
								...prev,
								skillIds,
								capabilityIds,
								mcpServers: mcpServerIds,
							}));
						}}
					/>

					{/* Pro Tips Sidebar */}
					<div className="w-72 border-l bg-slate-50 dark:bg-slate-900/50 overflow-y-auto p-5 shrink-0 hidden lg:block">
						<div className="space-y-4">
							<div className="flex items-center gap-2">
								<LightbulbIcon className="h-4 w-4 text-highlight" />
								<h3 className="text-sm font-semibold">
									Pro Tips
								</h3>
							</div>

							<div className="rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-800">
								<div className="flex items-center justify-between gap-2">
									<div>
										<p className="text-sm font-semibold text-foreground">
											Builder snapshot
										</p>
										<p className="mt-1 text-xs text-muted-foreground">
											Use this to sanity-check whether the
											agent can answer from retrieval, act
											with tools, and run on a trigger.
										</p>
									</div>
									{editingAgent?.id && (
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() =>
												setInsightsOpen(true)
											}
										>
											Agent insights
										</Button>
									)}
								</div>
								<div className="mt-4 grid gap-2">
									{builderReadiness.map((item) => (
										<div
											key={item.label}
											className="flex items-center justify-between rounded-xl border border-border/60 px-3 py-2"
										>
											<span className="text-xs font-medium text-muted-foreground">
												{item.label}
											</span>
											<span className="text-sm font-semibold text-foreground">
												{item.value}
											</span>
										</div>
									))}
								</div>
							</div>

							<div className="rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-800">
								<p className="text-sm font-semibold text-foreground">
									Builder suggestions
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									These suggestions are advisory. Nothing
									changes unless you apply it.
								</p>
								<div className="mt-4 space-y-3">
									{builderSuggestions.length > 0 ? (
										builderSuggestions.map((suggestion) => (
											<div
												key={suggestion.id}
												className="rounded-xl border border-border/60 px-3 py-3"
											>
												<p className="text-sm font-medium text-foreground">
													{suggestion.title}
												</p>
												<p className="mt-1 text-xs leading-5 text-muted-foreground">
													{suggestion.description}
												</p>
												<Button
													type="button"
													variant="outline"
													size="sm"
													className="mt-3 h-8 rounded-lg"
													onClick={() =>
														handleBuilderSuggestionAction(
															suggestion.action,
														)
													}
												>
													{suggestion.actionLabel}
												</Button>
											</div>
										))
									) : (
										<div className="rounded-xl border border-dashed px-3 py-3 text-xs text-muted-foreground">
											The draft already covers the main
											areas. A final test run is the last
											useful check before saving.
										</div>
									)}
								</div>
							</div>

							<div className="space-y-3">
								{!formData.displayName && (
									<div className="p-3 rounded-xl bg-white dark:bg-slate-800 border shadow-sm">
										<p className="text-xs text-muted-foreground">
											<span className="font-medium text-foreground">
												Name your agent
											</span>
											<br />
											Choose a descriptive name that
											reflects what your agent does.
										</p>
									</div>
								)}

								{/* Static tips */}
								<div className="p-3 rounded-xl bg-white dark:bg-slate-800 border shadow-sm">
									<p className="text-xs text-muted-foreground">
										<span className="font-medium text-foreground">
											Reasoning modes
										</span>
										<br />
										Use "Fast" for quick responses,
										"Thorough" for complex analysis tasks.
									</p>
								</div>

								<div className="p-3 rounded-xl bg-white dark:bg-slate-800 border shadow-sm">
									<p className="text-xs text-muted-foreground">
										<span className="font-medium text-foreground">
											Temperature setting
										</span>
										<br />
										Lower values (0.0-0.3) for factual
										tasks, higher (0.7-1.0) for creative
										work.
									</p>
								</div>
							</div>
						</div>
					</div>
				</div>

				{editingAgent?.id && (
					<AgentInsightsSheet
						open={insightsOpen}
						onOpenChange={setInsightsOpen}
						agent={{
							id: editingAgent.id,
							displayName: editingAgent.displayName,
							description: editingAgent.description,
							scope: editingAgent.scope,
							status: editingAgent.status,
						}}
						organizationId={organizationId ?? null}
					/>
				)}

				{/* Footer */}
				<DialogFooter className="px-6 py-4 border-t shrink-0">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						className="rounded-xl"
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={saveMutation.isPending}
						onClick={handleSubmit}
						className="rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white"
					>
						{saveMutation.isPending
							? editingAgent
								? "Saving..."
								: "Creating Agent..."
							: editingAgent
								? "Save Changes"
								: "Create Agent"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
