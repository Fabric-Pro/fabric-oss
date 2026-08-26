"use client";

import { useContextPath } from "@saas/organizations/hooks";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	AlertTriangleIcon,
	BrainCircuitIcon,
	CheckCircleIcon,
	CloudIcon,
	CodeIcon,
	ImageIcon,
	InfoIcon,
	LoaderIcon,
	MessageSquareIcon,
	MicIcon,
	NetworkIcon,
	SaveIcon,
	SettingsIcon,
	SparklesIcon,
	WrenchIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

// Task type definitions with icons and descriptions
const TASK_TYPES = [
	{
		id: "SIMPLE",
		label: "Simple Tasks",
		description:
			"Fast, lightweight tasks like title generation and quick summaries",
		icon: ZapIcon,
		color: "text-success",
	},
	{
		id: "COMPLEX",
		label: "Complex Tasks",
		description:
			"Detailed analysis, document generation, and comprehensive responses",
		icon: BrainCircuitIcon,
		color: "text-primary",
	},
	{
		id: "REASONING",
		label: "Reasoning",
		description: "Deep thinking, problem-solving, and multi-step reasoning",
		icon: SparklesIcon,
		color: "text-secondary",
	},
	{
		id: "CHAT",
		label: "Chat",
		description: "Interactive conversations and dialogue",
		icon: MessageSquareIcon,
		color: "text-cyan-500",
	},
	{
		id: "TOOL_CALLING",
		label: "Tool Calling",
		description: "Function/tool calling for agents and orchestrators",
		icon: WrenchIcon,
		color: "text-orange-500",
	},
	{
		id: "EMBEDDING",
		label: "Embeddings",
		description: "Text embeddings for semantic search and RAG",
		icon: CodeIcon,
		color: "text-indigo-500",
	},
	{
		id: "IMAGE",
		label: "Image Generation",
		description: "Creating images from text prompts",
		icon: ImageIcon,
		color: "text-pink-500",
	},
	{
		id: "AUDIO",
		label: "Audio",
		description: "Speech-to-text transcription",
		icon: MicIcon,
		color: "text-highlight",
	},
	{
		id: "EVAL",
		label: "Evaluations",
		description: "LLM-as-judge evaluation of generated content quality",
		icon: CheckCircleIcon,
		color: "text-emerald-500",
	},
] as const;

type TaskTypeId = (typeof TASK_TYPES)[number]["id"];

interface ModelOption {
	id: string;
	canonicalName: string;
	displayName: string;
	family: string;
	vendor: string;
	speedTier: string;
	qualityTier: string;
	capabilities?: string[];
}

// Capability requirements for each task type
// Maps task type to required capabilities (model must have ALL listed capabilities)
const TASK_CAPABILITY_REQUIREMENTS: Record<
	string,
	{
		requiredCapabilities?: string[];
		preferredCapabilities?: string[];
		excludeCapabilities?: string[];
		preferredSpeedTier?: string[];
		preferredQualityTier?: string[];
	}
> = {
	SIMPLE: {
		// Simple tasks should prefer fast, lightweight models
		preferredSpeedTier: ["FAST"],
		preferredQualityTier: ["BASIC", "STANDARD"],
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
	},
	COMPLEX: {
		// Complex tasks need capable models, but not necessarily reasoning
		preferredQualityTier: ["STANDARD", "PREMIUM"],
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
	},
	REASONING: {
		// Reasoning tasks REQUIRE REASONING capability
		requiredCapabilities: ["REASONING"],
		preferredQualityTier: ["PREMIUM"],
	},
	CHAT: {
		// Chat tasks just need text capability
		preferredCapabilities: ["TEXT"],
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
	},
	TOOL_CALLING: {
		// Tool calling tasks REQUIRE TOOL_CALLING capability
		requiredCapabilities: ["TOOL_CALLING"],
	},
	EMBEDDING: {
		// Embedding tasks REQUIRE EMBEDDING capability
		requiredCapabilities: ["EMBEDDING"],
	},
	IMAGE: {
		// Image tasks REQUIRE IMAGE capability
		requiredCapabilities: ["IMAGE"],
	},
	AUDIO: {
		// Audio tasks REQUIRE AUDIO capability
		requiredCapabilities: ["AUDIO"],
	},
	EVAL: {
		// Evaluation tasks REQUIRE REASONING capability
		requiredCapabilities: ["REASONING"],
		preferredQualityTier: ["STANDARD", "PREMIUM"],
	},
};

// Provider display names for better UX (includes both gateways and direct providers)
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	GROQ: "Groq",
	OPENAI_DIRECT: "OpenAI",
	ANTHROPIC_DIRECT: "Anthropic",
	DEEPSEEK: "DeepSeek",
	MISTRAL_AI: "Mistral AI",
	TOGETHER_AI: "Together AI",
	COHERE: "Cohere",
	PERPLEXITY: "Perplexity",
	XAI: "xAI",
	VERCEL_GATEWAY: "Vercel AI Gateway",
	CLOUDFLARE_AI: "Cloudflare AI",
	OPENROUTER: "OpenRouter",
	AZURE_AI_FOUNDRY: "Azure AI Foundry",
	AWS_BEDROCK: "AWS Bedrock",
	GOOGLE_VERTEX_AI: "Google Vertex AI",
	DATABRICKS: "Databricks",
};

export function AiModelPreferencesForm() {
	const queryClient = useQueryClient();
	const aiProvidersSettingsUrl = useContextPath("settings/ai-providers");
	// Track model changes for each task type
	// Provider is included to differentiate the same model from different providers
	const [pendingChanges, setPendingChanges] = useState<
		Record<string, { modelCanonicalName: string; provider?: string | null }>
	>({});
	const [isSaving, setIsSaving] = useState(false);

	// Track a version to force refetch when needed
	const [modelsFetchVersion, _setModelsFetchVersion] = useState(0);

	// Query available models (filtered by configured providers)
	// The query key includes version to force refetch when default provider changes
	const { data: availableModelsData, isLoading: isLoadingModels } = useQuery({
		queryKey: ["aiAvailableModels", modelsFetchVersion],
		queryFn: async () => {
			return await orpcClient.aiConfig.models.listAvailable({
				organizationId: null,
			});
		},
		// Cache for 2 minutes - provider changes are infrequent
		// Use modelsFetchVersion in queryKey to force refresh when needed
		staleTime: 2 * 60 * 1000,
		gcTime: 5 * 60 * 1000,
	});

	const models = availableModelsData?.models ?? [];
	const modelsByProvider = availableModelsData?.modelsByProvider ?? {};
	// New hierarchical structure: Gateway → Provider → Models
	const modelsByGatewayAndProvider =
		availableModelsData?.modelsByGatewayAndProvider ?? {};
	// New dynamic structure: configuredProviders from database
	const configuredProviders = availableModelsData?.configuredProviders ?? [];
	const defaultProvider = availableModelsData?.defaultProvider ?? null;
	const _providerIds = availableModelsData?.providerIds ?? [];
	const hasNoProviders = configuredProviders.length === 0;

	// Query system defaults (filtered by user's default provider)
	// Include defaultProvider in query key so it refetches when provider changes
	const { data: taskDefaults = [], isLoading: isLoadingDefaults } = useQuery({
		queryKey: ["aiTaskDefaults", defaultProvider],
		queryFn: async () => {
			return await orpcClient.aiConfig.preferences.getTaskDefaults({
				organizationId: null,
			});
		},
		// Only fetch after we know the default provider
		enabled: !isLoadingModels,
		// Cache defaults for 5 minutes - they rarely change
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	// Query user preferences (scoped to current default provider)
	const { data: userPreferences = [], isLoading: isLoadingPrefs } = useQuery({
		queryKey: ["aiUserPreferences", defaultProvider],
		queryFn: async () => {
			return await orpcClient.aiConfig.preferences.getUser({
				organizationId: null,
			});
		},
		enabled: !isLoadingModels,
		// Cache user preferences for 1 minute
		staleTime: 60 * 1000,
		gcTime: 5 * 60 * 1000,
	});

	// Set user preference mutation
	const setPreferenceMutation = useMutation({
		mutationFn: async (data: {
			taskType: string;
			modelCanonicalName: string;
			overrideProvider?: string;
		}) => {
			return await orpcClient.aiConfig.preferences.setUser({
				taskType: data.taskType as TaskTypeId,
				modelCanonicalName: data.modelCanonicalName,
				organizationId: null,
				overrideProvider: data.overrideProvider,
			});
		},
		onSuccess: () => {
			// Invalidate with prefix matching - includes all variants like ["aiUserPreferences", defaultProvider]
			queryClient.invalidateQueries({ queryKey: ["aiUserPreferences"] });
			// Also invalidate task defaults to ensure UI refreshes properly
			queryClient.invalidateQueries({ queryKey: ["aiTaskDefaults"] });
		},
	});

	// Delete user preference mutation
	const deletePreferenceMutation = useMutation({
		mutationFn: async (taskType: string) => {
			return await orpcClient.aiConfig.preferences.deleteUser({
				taskType: taskType as TaskTypeId,
				organizationId: null,
			});
		},
		onSuccess: () => {
			// Invalidate with prefix matching - includes all variants
			queryClient.invalidateQueries({ queryKey: ["aiUserPreferences"] });
			queryClient.invalidateQueries({ queryKey: ["aiTaskDefaults"] });
		},
	});

	const isLoading = isLoadingModels || isLoadingDefaults || isLoadingPrefs;

	// Memoize hierarchical models computation for all task types
	// This is expensive (O(n³) complexity) so we compute it once when data changes
	const memoizedHierarchicalModels = useMemo(() => {
		const result: Record<
			string,
			Array<{
				gateway: string;
				gatewayDisplayName: string;
				isDefault: boolean;
				providers: Array<{
					provider: string;
					providerDisplayName: string;
					models: Array<{
						id: string;
						canonicalName: string;
						displayName: string;
						providerModelId: string;
						speedTier: string;
						qualityTier: string;
						capabilities?: string[];
					}>;
				}>;
			}>
		> = {};

		// Pre-compute for all task types
		for (const taskType of TASK_TYPES) {
			const requirements =
				TASK_CAPABILITY_REQUIREMENTS[taskType.id] || {};
			const hierarchical: Array<{
				gateway: string;
				gatewayDisplayName: string;
				isDefault: boolean;
				providers: Array<{
					provider: string;
					providerDisplayName: string;
					models: Array<{
						id: string;
						canonicalName: string;
						displayName: string;
						providerModelId: string;
						speedTier: string;
						qualityTier: string;
						capabilities?: string[];
					}>;
				}>;
			}> = [];

			for (const [gateway, gatewayData] of Object.entries(
				modelsByGatewayAndProvider,
			)) {
				const providers: Array<{
					provider: string;
					providerDisplayName: string;
					models: Array<{
						id: string;
						canonicalName: string;
						displayName: string;
						providerModelId: string;
						speedTier: string;
						qualityTier: string;
						capabilities?: string[];
					}>;
				}> = [];

				for (const [provider, providerData] of Object.entries(
					gatewayData.providers,
				)) {
					const filteredModels = providerData.models.filter(
						(model) => {
							const capabilities = model.capabilities || [];
							if (requirements.requiredCapabilities) {
								const hasAllRequired =
									requirements.requiredCapabilities.every(
										(cap) => capabilities.includes(cap),
									);
								if (!hasAllRequired) {
									return false;
								}
							}
							if (requirements.excludeCapabilities) {
								const hasExcluded =
									requirements.excludeCapabilities.some(
										(cap) => capabilities.includes(cap),
									);
								if (hasExcluded) {
									return false;
								}
							}
							return true;
						},
					);

					const seenCanonicalNames = new Set<string>();
					const dedupedModels = filteredModels.filter((model) => {
						if (seenCanonicalNames.has(model.canonicalName)) {
							return false;
						}
						seenCanonicalNames.add(model.canonicalName);
						return true;
					});

					if (dedupedModels.length > 0) {
						providers.push({
							provider,
							providerDisplayName:
								providerData.providerDisplayName,
							models: dedupedModels,
						});
					}
				}

				if (providers.length > 0) {
					hierarchical.push({
						gateway,
						gatewayDisplayName: gatewayData.gatewayDisplayName,
						isDefault: gatewayData.isDefault,
						providers,
					});
				}
			}

			result[taskType.id] = hierarchical.sort(
				(a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0),
			);
		}

		return result;
	}, [modelsByGatewayAndProvider]);

	// Memoize current models map for all task types
	const currentModelsMap = useMemo(() => {
		const result: Record<string, ModelOption | null> = {};
		for (const taskType of TASK_TYPES) {
			const pending = pendingChanges[taskType.id];
			if (pending) {
				const model = models.find(
					(m) => m.canonicalName === pending.modelCanonicalName,
				);
				if (model) {
					result[taskType.id] = model;
					continue;
				}
			}
			const userPref = userPreferences.find(
				(p) => p.taskType === taskType.id,
			);
			if (userPref) {
				result[taskType.id] = userPref.model;
				continue;
			}
			const systemDefault = taskDefaults.find(
				(d) => d.taskType === taskType.id,
			);
			if (systemDefault) {
				result[taskType.id] = systemDefault.model;
				continue;
			}
			result[taskType.id] = null;
		}
		return result;
	}, [pendingChanges, models, userPreferences, taskDefaults]);

	// Get the current model for a task type (now uses memoized map)
	const getCurrentModel = useCallback(
		(taskType: string): ModelOption | null => {
			return currentModelsMap[taskType] ?? null;
		},
		[currentModelsMap],
	);

	// Memoize provider info map for all task types
	const modelProviderInfoMap = useMemo(() => {
		const result: Record<
			string,
			{ provider: string | null; isFallback: boolean }
		> = {};
		for (const taskType of TASK_TYPES) {
			const userPref = userPreferences.find(
				(p) => p.taskType === taskType.id,
			);
			if (userPref) {
				result[taskType.id] = {
					provider: userPref.provider || null,
					isFallback: userPref.provider !== defaultProvider,
				};
				continue;
			}
			const systemDefault = taskDefaults.find(
				(d) => d.taskType === taskType.id,
			);
			if (systemDefault) {
				result[taskType.id] = {
					provider: systemDefault.provider,
					isFallback: systemDefault.provider !== defaultProvider,
				};
				continue;
			}
			result[taskType.id] = { provider: null, isFallback: false };
		}
		return result;
	}, [userPreferences, taskDefaults, defaultProvider]);

	// Get the provider for the current model (uses memoized map)
	const getCurrentModelProvider = useCallback(
		(
			taskType: string,
		): { provider: string | null; isFallback: boolean } => {
			return (
				modelProviderInfoMap[taskType] ?? {
					provider: null,
					isFallback: false,
				}
			);
		},
		[modelProviderInfoMap],
	);

	// Get hierarchical models for task (uses memoized map)
	const getHierarchicalModelsForTask = useCallback(
		(taskType: string) => {
			return memoizedHierarchicalModels[taskType] ?? [];
		},
		[memoizedHierarchicalModels],
	);

	// Check if user has a custom preference for this task
	const hasUserPreference = (taskType: string): boolean => {
		return userPreferences.some((p) => p.taskType === taskType);
	};

	// Get models suitable for a task type, grouped by provider
	// Uses capability-based filtering to ensure models can actually perform the task
	const _getModelsForTaskByProvider = (
		taskType: string,
	): Record<
		string,
		Array<{
			id: string;
			canonicalName: string;
			displayName: string;
			providerModelId: string;
			speedTier: string;
			qualityTier: string;
			capabilities?: string[];
		}>
	> => {
		const result: Record<
			string,
			Array<{
				id: string;
				canonicalName: string;
				displayName: string;
				providerModelId: string;
				speedTier: string;
				qualityTier: string;
				capabilities?: string[];
			}>
		> = {};

		const requirements = TASK_CAPABILITY_REQUIREMENTS[taskType] || {};

		// Group by provider from modelsByProvider and filter by capabilities
		for (const [provider, providerModels] of Object.entries(
			modelsByProvider,
		)) {
			const filteredModels = providerModels.filter((model) => {
				const capabilities = model.capabilities || [];

				// Check required capabilities - model must have ALL of them
				if (requirements.requiredCapabilities) {
					const hasAllRequired =
						requirements.requiredCapabilities.every((cap) =>
							capabilities.includes(cap),
						);
					if (!hasAllRequired) {
						return false;
					}
				}

				// Check excluded capabilities - model must NOT have ANY of them
				if (requirements.excludeCapabilities) {
					const hasExcluded = requirements.excludeCapabilities.some(
						(cap) => capabilities.includes(cap),
					);
					if (hasExcluded) {
						return false;
					}
				}

				return true;
			});

			// Sort models: preferred tiers first, then by quality
			const sortedModels = filteredModels.sort((a, b) => {
				// Prioritize preferred speed tier
				if (requirements.preferredSpeedTier) {
					const aSpeedMatch =
						requirements.preferredSpeedTier.includes(a.speedTier)
							? 0
							: 1;
					const bSpeedMatch =
						requirements.preferredSpeedTier.includes(b.speedTier)
							? 0
							: 1;
					if (aSpeedMatch !== bSpeedMatch) {
						return aSpeedMatch - bSpeedMatch;
					}
				}

				// Prioritize preferred quality tier
				if (requirements.preferredQualityTier) {
					const aQualityMatch =
						requirements.preferredQualityTier.includes(
							a.qualityTier,
						)
							? 0
							: 1;
					const bQualityMatch =
						requirements.preferredQualityTier.includes(
							b.qualityTier,
						)
							? 0
							: 1;
					if (aQualityMatch !== bQualityMatch) {
						return aQualityMatch - bQualityMatch;
					}
				}

				// Default: sort by quality tier (PREMIUM > STANDARD > BASIC)
				const qualityOrder: Record<string, number> = {
					PREMIUM: 0,
					STANDARD: 1,
					BASIC: 2,
				};
				return (
					(qualityOrder[a.qualityTier] || 2) -
					(qualityOrder[b.qualityTier] || 2)
				);
			});

			if (sortedModels.length > 0) {
				result[provider] = sortedModels;
			}
		}

		return result;
	};

	// Find which gateway a model appears under in the hierarchical structure
	// This is needed to match currentValue with SelectItem values
	const findGatewayForModel = (
		taskType: string,
		modelCanonicalName: string,
	): string | null => {
		const hierarchicalModels = getHierarchicalModelsForTask(taskType);
		for (const gateway of hierarchicalModels) {
			for (const provider of gateway.providers) {
				if (
					provider.models.some(
						(m) => m.canonicalName === modelCanonicalName,
					)
				) {
					return gateway.gateway;
				}
			}
		}
		return null;
	};

	// Get flat list of models for task (uses capability-based filtering)
	const _getModelsForTask = (taskType: string): ModelOption[] => {
		const requirements = TASK_CAPABILITY_REQUIREMENTS[taskType] || {};

		// Get all models with their capabilities from modelsByProvider
		const modelsWithCapabilities: ModelOption[] = [];
		for (const providerModels of Object.values(modelsByProvider)) {
			for (const pm of providerModels) {
				// Only add if not already in list (avoid duplicates across providers)
				if (
					!modelsWithCapabilities.some(
						(m) => m.canonicalName === pm.canonicalName,
					)
				) {
					const baseModel = models.find(
						(m) => m.canonicalName === pm.canonicalName,
					);
					if (baseModel) {
						modelsWithCapabilities.push({
							...baseModel,
							capabilities: pm.capabilities,
						});
					}
				}
			}
		}

		return modelsWithCapabilities.filter((model) => {
			const capabilities = model.capabilities || [];

			// Check required capabilities
			if (requirements.requiredCapabilities) {
				const hasAllRequired = requirements.requiredCapabilities.every(
					(cap) => capabilities.includes(cap),
				);
				if (!hasAllRequired) {
					return false;
				}
			}

			// Check excluded capabilities
			if (requirements.excludeCapabilities) {
				const hasExcluded = requirements.excludeCapabilities.some(
					(cap) => capabilities.includes(cap),
				);
				if (hasExcluded) {
					return false;
				}
			}

			return true;
		});
	};

	// Handle model change - value format is "provider:canonicalName"
	const handleModelChange = (taskType: string, value: string) => {
		// Parse provider and model from value (format: "PROVIDER:canonicalName")
		const [provider, modelCanonicalName] = value.includes(":")
			? [value.split(":")[0], value.split(":").slice(1).join(":")]
			: [null, value];

		setPendingChanges((prev) => ({
			...prev,
			[taskType]: { modelCanonicalName, provider },
		}));
	};

	const handleSaveAll = async () => {
		setIsSaving(true);
		try {
			const changes = Object.entries(pendingChanges);
			for (const [
				taskType,
				{ modelCanonicalName, provider },
			] of changes) {
				await setPreferenceMutation.mutateAsync({
					taskType,
					modelCanonicalName,
					// Include provider for specialized models (IMAGE/AUDIO from non-default providers)
					overrideProvider: provider || undefined,
				});
			}
			setPendingChanges({});
			toast.success("Preferences saved", {
				description: `Updated ${changes.length} task preference(s)`,
			});
		} catch (error) {
			toast.error("Failed to save preferences", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetToDefault = async (taskType: string) => {
		try {
			await deletePreferenceMutation.mutateAsync(taskType);
			// Also clear any pending change for this task
			setPendingChanges((prev) => {
				const next = { ...prev };
				delete next[taskType];
				return next;
			});
			toast.success("Reset to default", {
				description: `${taskType} now uses the system default model`,
			});
		} catch (_error) {
			toast.error("Failed to reset preference");
		}
	};

	const hasPendingChanges = Object.keys(pendingChanges).length > 0;

	return (
		<SettingsItem
			title="AI Model Preferences"
			description="Configure which AI models to use for different types of tasks. Your preferences override the system defaults."
		>
			<div className="space-y-6">
				{/* No Providers Warning */}
				{hasNoProviders && (
					<div className="rounded-md border border-highlight/20 bg-highlight/5 p-4">
						<div className="flex gap-3">
							<AlertTriangleIcon className="size-5 shrink-0 text-highlight" />
							<div className="space-y-2 text-sm">
								<p className="font-medium text-foreground">
									No AI Providers Configured
								</p>
								<p className="text-highlight/80">
									You need to configure at least one AI
									provider before you can select models.
									Configure an AI gateway (like Vercel,
									OpenRouter) or a direct provider API key.
								</p>
								<Link
									href={aiProvidersSettingsUrl}
									className="inline-flex items-center gap-1 text-highlight/80 underline hover:text-highlight"
								>
									<SettingsIcon className="size-4" />
									Configure AI Providers
								</Link>
							</div>
						</div>
					</div>
				)}

				{/* Configured Providers */}
				{!hasNoProviders && (
					<div className="rounded-md border border-success/20 bg-success/5 p-4">
						<div className="flex gap-3">
							<CheckCircleIcon className="size-5 shrink-0 text-success" />
							<div className="space-y-3 text-sm w-full">
								<p className="font-medium text-foreground">
									AI Configuration
								</p>

								{/* Configured Providers */}
								<div className="flex flex-wrap gap-2">
									{configuredProviders.map((provider) => (
										<Badge
											key={provider.id}
											variant="outline"
											className={`${
												provider.isDefault
													? "border-success bg-success/10 text-success"
													: "border-success/40 text-success bg-background"
											}`}
										>
											{provider.displayName ||
												PROVIDER_DISPLAY_NAMES[
													provider.provider
												] ||
												provider.provider}
											{provider.isDefault && (
												<span className="ml-1 text-xs opacity-75">
													(Default)
												</span>
											)}
										</Badge>
									))}
								</div>

								<p className="text-success/80 pt-1">
									{models.length} models available through
									your configuration.
								</p>
							</div>
						</div>
					</div>
				)}

				{/* Info Banner */}
				<div className="rounded-md border border-border bg-muted/40 p-4">
					<div className="flex gap-3">
						<InfoIcon className="size-5 shrink-0 text-muted-foreground" />
						<div className="space-y-1 text-sm">
							<p className="font-medium text-foreground">
								Task-Based Model Selection
							</p>
							<p className="text-muted-foreground">
								Different tasks benefit from different models.
								Fast models are great for simple tasks, while
								more capable models excel at reasoning and
								complex analysis. The system will automatically
								use the appropriate model based on these
								preferences.
							</p>
						</div>
					</div>
				</div>

				{/* Save Button */}
				{hasPendingChanges && (
					<div className="flex flex-col gap-3 rounded-md border border-highlight/20 bg-highlight/5 p-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex items-center gap-2">
							<AlertCircleIcon className="size-4 text-highlight" />
							<span className="text-sm text-foreground">
								You have {Object.keys(pendingChanges).length}{" "}
								unsaved change(s)
							</span>
						</div>
						<Button
							onClick={handleSaveAll}
							disabled={isSaving}
							size="sm"
						>
							{isSaving ? (
								<>
									<LoaderIcon className="mr-2 size-4 animate-spin" />
									Saving...
								</>
							) : (
								<>
									<SaveIcon className="mr-2 size-4" />
									Save Changes
								</>
							)}
						</Button>
					</div>
				)}

				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<LoaderIcon className="size-6 animate-spin text-muted-foreground" />
					</div>
				) : (
					<div className="space-y-4">
						{TASK_TYPES.map((taskType) => {
							const currentModel = getCurrentModel(taskType.id);
							const modelProviderInfo = getCurrentModelProvider(
								taskType.id,
							);
							const hierarchicalModels =
								getHierarchicalModelsForTask(taskType.id);
							const hasCustomPref = hasUserPreference(
								taskType.id,
							);
							const hasPendingChange =
								!!pendingChanges[taskType.id];
							const Icon = taskType.icon;
							const hasModels = hierarchicalModels.some((g) =>
								g.providers.some((p) => p.models.length > 0),
							);

							// Build the current value - format is "gateway:canonicalName"
							// Must match SelectItem values which use gateway.gateway
							const pendingSelection =
								pendingChanges[taskType.id];

							// Find which gateway/provider the model was saved with
							// This ensures currentValue matches SelectItem values
							const getGatewayForCurrentModel = () => {
								if (pendingSelection) {
									// For pending selection, use the stored provider/gateway
									return (
										pendingSelection.provider ||
										defaultProvider
									);
								}
								// For saved preferences, use the saved provider directly
								// This is critical for IMAGE/AUDIO which use overrideProvider
								if (modelProviderInfo.provider) {
									return modelProviderInfo.provider;
								}
								if (currentModel) {
									// Fallback: find the gateway this model appears under
									const gateway = findGatewayForModel(
										taskType.id,
										currentModel.canonicalName,
									);
									return gateway || defaultProvider;
								}
								return defaultProvider;
							};

							const effectiveGateway =
								getGatewayForCurrentModel();

							const currentValue = pendingSelection
								? `${pendingSelection.provider || defaultProvider}:${pendingSelection.modelCanonicalName}`
								: currentModel
									? `${effectiveGateway}:${currentModel.canonicalName}`
									: "";

							return (
								<Card key={taskType.id} className="p-4">
									<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
										{/* Task Type Info */}
										<div className="flex items-start gap-3">
											<div
												className={`rounded-lg bg-muted p-2 ${taskType.color}`}
											>
												<Icon className="size-5" />
											</div>
											<div className="flex-1">
												<div className="flex items-center gap-2">
													<h4 className="font-semibold">
														{taskType.label}
													</h4>
													{hasCustomPref &&
														!hasPendingChange && (
															<Badge
																variant="secondary"
																className="text-xs"
															>
																Custom
															</Badge>
														)}
													{hasPendingChange && (
														<Badge
															variant="outline"
															className="text-xs border-yellow-500 text-highlight"
														>
															Unsaved
														</Badge>
													)}
												</div>
												<p className="text-muted-foreground text-xs">
													{taskType.description}
												</p>
											</div>
										</div>

										{/* Model Selection - Hierarchical Dropdown */}
										<div className="flex items-center gap-2">
											<Select
												value={currentValue}
												onValueChange={(value) =>
													handleModelChange(
														taskType.id,
														value,
													)
												}
												disabled={
													hasNoProviders || !hasModels
												}
											>
												<SelectTrigger
													className={cn(
														"w-full sm:w-[320px]",
														!hasModels &&
															!hasNoProviders &&
															"border-highlight/30 bg-highlight/5",
													)}
												>
													<SelectValue
														placeholder={
															hasNoProviders
																? "Configure providers first"
																: !hasModels
																	? "No models available"
																	: "Select a model"
														}
													>
														{currentModel ? (
															<span className="truncate flex items-center gap-1.5">
																{
																	currentModel.displayName
																}
																{modelProviderInfo.isFallback &&
																	modelProviderInfo.provider && (
																		<span className="text-xs text-highlight dark:text-orange-400">
																			(via{" "}
																			{PROVIDER_DISPLAY_NAMES[
																				modelProviderInfo
																					.provider
																			] ||
																				modelProviderInfo.provider}
																			)
																		</span>
																	)}
															</span>
														) : hasNoProviders ? (
															"Configure providers first"
														) : !hasModels ? (
															<span className="text-highlight">
																No models
																available
															</span>
														) : (
															"Select a model"
														)}
													</SelectValue>
												</SelectTrigger>
												<SelectContent className="max-h-[500px] w-[calc(100vw-1.5rem)] max-w-[420px]">
													{!hasModels ? (
														<div className="px-3 py-4 text-center text-sm text-muted-foreground space-y-2">
															<p className="font-medium">
																No models
																available for
																this task type
															</p>
															{[
																"EMBEDDING",
																"IMAGE",
																"AUDIO",
															].includes(
																taskType.id,
															) ? (
																<p className="text-xs">
																	{taskType.id ===
																		"EMBEDDING" &&
																		"Embeddings require OpenAI or Vercel Gateway."}
																	{taskType.id ===
																		"IMAGE" &&
																		"Image generation requires OpenAI or Vercel Gateway."}
																	{taskType.id ===
																		"AUDIO" &&
																		"Audio transcription requires OpenAI, Groq, or Vercel Gateway."}{" "}
																	Configure
																	one of these
																	providers in
																	AI Providers
																	settings.
																</p>
															) : (
																<p className="text-xs">
																	Your current
																	provider
																	doesn't have
																	models for
																	this task.
																</p>
															)}
														</div>
													) : (
														hierarchicalModels.map(
															(gateway) => (
																<div
																	key={
																		gateway.gateway
																	}
																>
																	{/* Gateway Header */}
																	<div className="flex items-center gap-2 px-2 py-2 bg-muted/50 sticky top-0">
																		<CloudIcon className="size-4 text-muted-foreground" />
																		<span className="font-semibold text-sm">
																			{
																				gateway.gatewayDisplayName
																			}
																		</span>
																		{gateway.isDefault && (
																			<Badge
																				variant="secondary"
																				className="text-xs"
																			>
																				Default
																			</Badge>
																		)}
																	</div>
																	{/* Providers under this gateway */}
																	{gateway.providers.map(
																		(
																			provider,
																		) => (
																			<SelectGroup
																				key={`${gateway.gateway}-${provider.provider}`}
																			>
																				<SelectLabel className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground py-1 pl-6">
																					<NetworkIcon className="size-3" />
																					{
																						provider.providerDisplayName
																					}
																					<span className="text-muted-foreground/60">
																						(
																						{
																							provider
																								.models
																								.length
																						}
																						)
																					</span>
																				</SelectLabel>
																				{provider.models.map(
																					(
																						model,
																					) => (
																						<SelectItem
																							key={`${gateway.gateway}-${provider.provider}-${model.canonicalName}`}
																							value={`${gateway.gateway}:${model.canonicalName}`}
																							className="py-2 pl-8"
																						>
																							<div className="flex flex-col gap-0.5">
																								<div className="flex items-center gap-2">
																									<span className="font-medium">
																										{
																											model.displayName
																										}
																									</span>
																									{model.speedTier ===
																										"FAST" && (
																										<ZapIcon className="size-3 text-success" />
																									)}
																									{model.qualityTier ===
																										"PREMIUM" && (
																										<SparklesIcon className="size-3 text-secondary" />
																									)}
																								</div>
																								<span className="text-xs text-muted-foreground font-mono">
																									{
																										model.providerModelId
																									}
																								</span>
																							</div>
																						</SelectItem>
																					),
																				)}
																			</SelectGroup>
																		),
																	)}
																</div>
															),
														)
													)}
												</SelectContent>
											</Select>

											{hasCustomPref && (
												<Button
													variant="ghost"
													size="sm"
													onClick={() =>
														handleResetToDefault(
															taskType.id,
														)
													}
													className="text-muted-foreground hover:text-foreground"
												>
													Reset
												</Button>
											)}
										</div>
									</div>

									{/* No Models Available Helper Text */}
									{!hasModels && !hasNoProviders && (
										<div className="mt-3 rounded-md border border-highlight/20 bg-highlight/5 px-3 py-2">
											<p className="text-xs text-highlight/80">
												{taskType.id === "EMBEDDING" &&
													"Embeddings require OpenAI, Cohere, Together AI, Fireworks, Mistral, or a Gateway provider (Vercel, OpenRouter)."}
												{taskType.id === "IMAGE" &&
													"Image generation requires OpenAI, Replicate, or a Gateway provider."}
												{taskType.id === "AUDIO" &&
													"Audio transcription requires OpenAI, Groq, or a Gateway provider."}
												{![
													"EMBEDDING",
													"IMAGE",
													"AUDIO",
												].includes(taskType.id) &&
													"Your configured providers don't have models for this task type."}{" "}
												<a
													href={
														aiProvidersSettingsUrl
													}
													className="font-medium underline hover:text-highlight"
												>
													Configure AI Providers
												</a>
											</p>
										</div>
									)}

									{/* Current Model Details */}
									{currentModel && (
										<div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
											{/* Show fallback provider badge */}
											{modelProviderInfo.isFallback &&
												modelProviderInfo.provider && (
													<Badge
														variant="outline"
														className="text-xs border-orange-500 bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300"
													>
														via{" "}
														{PROVIDER_DISPLAY_NAMES[
															modelProviderInfo
																.provider
														] ||
															modelProviderInfo.provider}
													</Badge>
												)}
											<Badge
												variant="secondary"
												className="text-xs"
											>
												{currentModel.family}
											</Badge>
											<Badge
												variant="outline"
												className={`text-xs ${
													currentModel.speedTier ===
													"FAST"
														? "border-green-500 text-success"
														: currentModel.speedTier ===
																"BALANCED"
															? "border-primary text-primary"
															: "border-secondary text-secondary"
												}`}
											>
												{currentModel.speedTier}
											</Badge>
											<Badge
												variant="outline"
												className={`text-xs ${
													currentModel.qualityTier ===
													"BASIC"
														? "border-gray-500 text-gray-600"
														: currentModel.qualityTier ===
																"STANDARD"
															? "border-primary text-primary"
															: "border-secondary text-secondary"
												}`}
											>
												{currentModel.qualityTier}
											</Badge>
										</div>
									)}
								</Card>
							);
						})}
					</div>
				)}
			</div>
		</SettingsItem>
	);
}
