"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	BrainCircuitIcon,
	CheckCircleIcon,
	CodeIcon,
	ImageIcon,
	ListChecksIcon,
	MessageSquareIcon,
	MicIcon,
	SparklesIcon,
	WrenchIcon,
	ZapIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The organization's API model per task: the data, the per-task view and the
 * save paths behind both the legacy AI Models form and the API column of the
 * plan routing table (Fizzy #2770 F6). One home for the mutation logic.
 */

export const TASK_TYPES = [
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
	{
		id: "DECISION",
		label: "Decisions",
		description:
			"Bug or feature classification, with the regular AI model as fallback",
		icon: ListChecksIcon,
		color: "text-violet-500",
	},
] as const;

type TaskTypeId = (typeof TASK_TYPES)[number]["id"];

export interface ModelOption {
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
		preferredSpeedTier: ["FAST"],
		preferredQualityTier: ["BASIC", "STANDARD"],
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
	},
	COMPLEX: {
		preferredQualityTier: ["STANDARD", "PREMIUM"],
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
	},
	REASONING: {
		requiredCapabilities: ["REASONING"],
		preferredQualityTier: ["PREMIUM"],
	},
	CHAT: {
		preferredCapabilities: ["TEXT"],
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
	},
	TOOL_CALLING: {
		requiredCapabilities: ["TOOL_CALLING"],
	},
	EMBEDDING: {
		requiredCapabilities: ["EMBEDDING"],
	},
	IMAGE: {
		requiredCapabilities: ["IMAGE"],
	},
	AUDIO: {
		requiredCapabilities: ["AUDIO"],
	},
	EVAL: {
		requiredCapabilities: ["REASONING"],
		preferredQualityTier: ["STANDARD", "PREMIUM"],
	},
	DECISION: {
		requiredCapabilities: ["EVALUATION"],
	},
};

// Provider display names
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
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

// Sentinel for the DECISION "Disabled" choice. It is a UI value only: the
// Select needs a non-empty string, and `null` is what actually reaches the
// server as `modelCanonicalName`. It deliberately contains no ":" so the
// "GATEWAY:canonicalName" parser cannot mistake it for a model.
export const DECISION_DISABLED_VALUE = "__disabled__";

/**
 * The ChatGPT plan tab stores its per-task models in the same preferences
 * table. They are never this form's API choice.
 */
function withoutChatGptPlanRows<T extends { provider: string | null }>(
	rows: T[],
): T[] {
	return rows.filter((row) => row.provider !== "OPENAI_CHATGPT_PLAN");
}

interface PendingChange {
	// null = the organization chose to switch this task's model off.
	modelCanonicalName: string | null;
	provider?: string | null;
}

/**
 * Everything one task's API model select shows: the current choice, the
 * models it may pick from (gateway → provider → models), and its value.
 */
export interface ApiTaskView {
	currentModel: ModelOption | null;
	/** The model the task runs on without a choice of the organization's. */
	defaultModel: ModelOption | null;
	currentGateway: string | null;
	hierarchicalModels: ReturnType<
		ReturnType<
			typeof useOrgApiModelPreferences
		>["getHierarchicalModelsForTask"]
	>;
	hasCustomPref: boolean;
	hasPendingChange: boolean;
	isDisabledChoice: boolean;
	offersDisabledChoice: boolean;
	hasModels: boolean;
	currentValue: string;
}

/** A select value, "GATEWAY:canonicalName" or the decision off sentinel, as a preference change. */
function parseModelValue(value: string): PendingChange {
	// "Disabled" is offered for DECISION only and carries no model. It
	// is pinned to the Vercel gateway because that is the only provider
	// the server accepts a decision preference for.
	if (value === DECISION_DISABLED_VALUE) {
		return { modelCanonicalName: null, provider: "VERCEL_GATEWAY" };
	}
	const [provider, modelCanonicalName] = value.includes(":")
		? [value.split(":")[0], value.split(":").slice(1).join(":")]
		: [null, value];
	return { modelCanonicalName, provider };
}

export function useOrgApiModelPreferences({
	readOnly = false,
}: {
	readOnly?: boolean;
}) {
	const queryClient = useQueryClient();
	const { organizationId, organizationSlug, isOrgContext } =
		useOrganizationContext();
	const [pendingChanges, setPendingChanges] = useState<
		Record<string, PendingChange>
	>({});
	const [isSaving, setIsSaving] = useState(false);

	// Query available models with capabilities (filtered by configured providers)
	const { data: availableModelsData, isLoading: isLoadingModels } = useQuery({
		queryKey: ["aiAvailableModels", organizationId],
		queryFn: async () => {
			return await orpcClient.aiConfig.models.listAvailable({
				organizationId: organizationId ?? undefined,
			});
		},
		enabled: !!isOrgContext,
	});

	const generalModels = availableModelsData?.models ?? [];
	const _modelsByProvider = availableModelsData?.modelsByProvider ?? {};
	const modelsByGatewayAndProvider =
		availableModelsData?.modelsByGatewayAndProvider ?? {};
	const configuredProviders = availableModelsData?.configuredProviders ?? [];
	const defaultProvider = availableModelsData?.defaultProvider ?? null;

	// Decision evaluation models are an isolated SDK modality. Fetch them with
	// their task type so the API never returns them to language-model selectors.
	const { data: decisionModelsData, isLoading: isLoadingDecisionModels } =
		useQuery({
			queryKey: ["aiAvailableModels", organizationId, "DECISION"],
			queryFn: async () => {
				return await orpcClient.aiConfig.models.listAvailable({
					organizationId: organizationId ?? undefined,
					taskType: "DECISION",
				});
			},
			enabled: !!isOrgContext,
		});

	const decisionModels = decisionModelsData?.models ?? [];
	const models = [...generalModels, ...decisionModels];
	const decisionModelsByGatewayAndProvider =
		decisionModelsData?.modelsByGatewayAndProvider ?? {};
	const hasNoProviders = configuredProviders.length === 0;

	// Query system defaults (filtered by org's default provider)
	const { data: taskDefaults = [], isLoading: isLoadingDefaults } = useQuery({
		queryKey: ["aiTaskDefaults", organizationId, defaultProvider],
		queryFn: async () => {
			return await orpcClient.aiConfig.preferences.getTaskDefaults({
				organizationId: organizationId ?? undefined,
			});
		},
		select: withoutChatGptPlanRows,
		// Only fetch after we know the org's default provider
		enabled: !!isOrgContext && !isLoadingModels,
	});

	// Query organization preferences (scoped to current default provider)
	const { data: orgPreferences = [], isLoading: isLoadingPrefs } = useQuery({
		queryKey: ["aiOrgPreferences", organizationId, defaultProvider],
		queryFn: async () => {
			if (!organizationId) {
				return [];
			}
			return await orpcClient.aiConfig.preferences.getOrg({
				organizationId,
			});
		},
		select: withoutChatGptPlanRows,
		enabled: !!isOrgContext && !isLoadingModels,
	});

	// Set organization preference mutation
	const setPreferenceMutation = useMutation({
		mutationFn: async (data: {
			taskType: string;
			modelCanonicalName: string | null;
			overrideProvider?: string;
		}) => {
			if (!organizationId) {
				throw new Error("No organization");
			}
			return await orpcClient.aiConfig.preferences.setOrg({
				organizationId: organizationId,
				taskType: data.taskType as TaskTypeId,
				modelCanonicalName: data.modelCanonicalName,
				overrideProvider: data.overrideProvider,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["aiOrgPreferences", organizationId],
			});
		},
	});

	// Delete organization preference mutation
	const deletePreferenceMutation = useMutation({
		mutationFn: async (taskType: string) => {
			if (!organizationId) {
				throw new Error("No organization");
			}
			return await orpcClient.aiConfig.preferences.deleteOrg({
				organizationId: organizationId,
				taskType: taskType as TaskTypeId,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["aiOrgPreferences", organizationId],
			});
		},
	});

	const isLoading =
		isLoadingModels ||
		isLoadingDecisionModels ||
		isLoadingDefaults ||
		isLoadingPrefs;

	// Is this task's model switched off — either pending or already saved?
	// A saved preference row with no model is the organization's explicit
	// "off" choice, which is why it must not read as "no preference" and
	// show the system default.
	const isTaskDisabled = (taskType: string): boolean => {
		const pending = pendingChanges[taskType];
		if (pending) {
			return pending.modelCanonicalName === null;
		}

		const orgPref = orgPreferences.find((p) => p.taskType === taskType);
		return !!orgPref && orgPref.model === null;
	};

	// Get the current model for a task type
	const getCurrentModel = (taskType: string): ModelOption | null => {
		if (isTaskDisabled(taskType)) {
			return null;
		}

		const pending = pendingChanges[taskType];
		if (pending) {
			const model = models.find(
				(m) => m.canonicalName === pending.modelCanonicalName,
			);
			if (model) {
				return model;
			}
		}

		const orgPref = orgPreferences.find((p) => p.taskType === taskType);
		if (orgPref) {
			return orgPref.model;
		}

		const systemDefault = taskDefaults.find((d) => d.taskType === taskType);
		if (systemDefault) {
			return systemDefault.model;
		}

		return null;
	};

	// Get the provider for the current model (to show fallback info)
	const getCurrentModelProvider = (
		taskType: string,
	): { provider: string | null; isFallback: boolean } => {
		// Check org preferences first
		const orgPref = orgPreferences.find((p) => p.taskType === taskType);
		if (orgPref) {
			return {
				provider: orgPref.provider || null,
				isFallback: orgPref.provider !== defaultProvider,
			};
		}

		// Fall back to system default
		const systemDefault = taskDefaults.find((d) => d.taskType === taskType);
		if (systemDefault) {
			return {
				provider: systemDefault.provider,
				isFallback: systemDefault.provider !== defaultProvider,
			};
		}

		return { provider: null, isFallback: false };
	};

	// Get the current gateway for a task type (kept for backwards compatibility)
	const getCurrentGateway = (taskType: string): string | null => {
		const providerInfo = getCurrentModelProvider(taskType);
		return providerInfo.provider;
	};

	// Check if org has a custom preference for this task
	const hasOrgPreference = (taskType: string): boolean => {
		return orgPreferences.some((p) => p.taskType === taskType);
	};

	// Get hierarchical models for task: Gateway → Provider → Models
	const getHierarchicalModelsForTask = (
		taskType: string,
	): Array<{
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
	}> => {
		const requirements = TASK_CAPABILITY_REQUIREMENTS[taskType] || {};
		const result: Array<{
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

		const modelsForTask =
			taskType === "DECISION"
				? decisionModelsByGatewayAndProvider
				: modelsByGatewayAndProvider;

		for (const [gateway, gatewayData] of Object.entries(modelsForTask)) {
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
				const filteredModels = providerData.models.filter((model) => {
					const capabilities = model.capabilities || [];

					if (requirements.requiredCapabilities) {
						const hasAllRequired =
							requirements.requiredCapabilities.every((cap) =>
								capabilities.includes(cap),
							);
						if (!hasAllRequired) {
							return false;
						}
					}

					if (requirements.excludeCapabilities) {
						const hasExcluded =
							requirements.excludeCapabilities.some((cap) =>
								capabilities.includes(cap),
							);
						if (hasExcluded) {
							return false;
						}
					}

					return true;
				});

				// Deduplicate models by canonicalName
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
						providerDisplayName: providerData.providerDisplayName,
						models: dedupedModels,
					});
				}
			}

			if (providers.length > 0) {
				result.push({
					gateway,
					gatewayDisplayName: gatewayData.gatewayDisplayName,
					isDefault: gatewayData.isDefault,
					providers,
				});
			}
		}

		return result.sort(
			(a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0),
		);
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

	// Handle model change - value format: "provider:model"
	const handleModelChange = (taskType: string, value: string) => {
		if (readOnly) {
			return;
		}
		setPendingChanges((prev) => ({
			...prev,
			[taskType]: parseModelValue(value),
		}));
	};

	const handleSaveAll = async () => {
		if (readOnly) {
			return;
		}

		setIsSaving(true);
		try {
			const changes = Object.entries(pendingChanges);
			for (const [taskType, change] of changes) {
				await setPreferenceMutation.mutateAsync({
					taskType,
					modelCanonicalName: change.modelCanonicalName,
					// Include provider for specialized models (IMAGE/AUDIO from non-default providers)
					overrideProvider: change.provider || undefined,
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
		if (readOnly) {
			return;
		}

		try {
			await deletePreferenceMutation.mutateAsync(taskType);
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

	const getTaskView = (taskTypeId: string): ApiTaskView => {
		const currentModel = getCurrentModel(taskTypeId);
		const currentGateway = getCurrentGateway(taskTypeId);
		const hierarchicalModels = getHierarchicalModelsForTask(taskTypeId);
		const hasCustomPref = hasOrgPreference(taskTypeId);
		const hasPendingChange = !!pendingChanges[taskTypeId];
		const isDisabledChoice = isTaskDisabled(taskTypeId);
		// Only decisions can be switched off: every other
		// task falls back to the system default, so "off"
		// there has no meaning.
		const offersDisabledChoice = taskTypeId === "DECISION";
		const hasModels = hierarchicalModels.some((g) =>
			g.providers.some((p) => p.models.length > 0),
		);

		// Build the current value - format is "gateway:canonicalName"
		// Must match SelectItem values which use gateway.gateway
		const pendingSelection = pendingChanges[taskTypeId];

		// Find which gateway/provider the model was saved with
		// This ensures currentValue matches SelectItem values
		const getGatewayForCurrentModel = () => {
			if (pendingSelection) {
				// For pending selection, use the stored provider/gateway
				return pendingSelection.provider || defaultProvider;
			}
			// For saved preferences, use the saved provider directly
			// This is critical for IMAGE/AUDIO which use overrideProvider
			if (currentGateway) {
				return currentGateway;
			}
			if (currentModel) {
				// Fallback: find the gateway this model appears under
				const gateway = findGatewayForModel(
					taskTypeId,
					currentModel.canonicalName,
				);
				return gateway || defaultProvider;
			}
			return defaultProvider;
		};

		const effectiveGateway = getGatewayForCurrentModel();

		const currentValue = isDisabledChoice
			? DECISION_DISABLED_VALUE
			: pendingSelection?.modelCanonicalName
				? `${pendingSelection.provider || defaultProvider}:${pendingSelection.modelCanonicalName}`
				: currentModel
					? `${effectiveGateway}:${currentModel.canonicalName}`
					: "";

		return {
			currentModel,
			defaultModel:
				taskDefaults.find((d) => d.taskType === taskTypeId)?.model ??
				null,
			currentGateway,
			hierarchicalModels,
			hasCustomPref,
			hasPendingChange,
			isDisabledChoice,
			offersDisabledChoice,
			hasModels,
			currentValue,
		};
	};

	/** Saves one task's choice at once, for the routing table (no pending batch). */
	const saveModelChoice = async (taskType: string, value: string) => {
		if (readOnly) {
			return;
		}
		const change = parseModelValue(value);
		try {
			await setPreferenceMutation.mutateAsync({
				taskType,
				modelCanonicalName: change.modelCanonicalName,
				overrideProvider: change.provider || undefined,
			});
			toast.success("Preference saved");
		} catch (error) {
			toast.error("Failed to save preferences", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	return {
		organizationSlug,
		isOrgContext,
		configuredProviders,
		models,
		hasNoProviders,
		isLoading,
		pendingChanges,
		hasPendingChanges,
		isSaving,
		handleModelChange,
		handleSaveAll,
		handleResetToDefault,
		getHierarchicalModelsForTask,
		getTaskView,
		saveModelChoice,
	};
}
