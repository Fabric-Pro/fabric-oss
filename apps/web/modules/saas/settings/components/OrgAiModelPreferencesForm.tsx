"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
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
	LockIcon,
	MessageSquareIcon,
	MicIcon,
	NetworkIcon,
	SaveIcon,
	SettingsIcon,
	ShieldIcon,
	SparklesIcon,
	WrenchIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
};

// Provider display names
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

interface PendingChange {
	modelCanonicalName: string;
	provider?: string | null;
}

export function OrgAiModelPreferencesForm({
	readOnly = false,
}: {
	readOnly?: boolean;
}) {
	const queryClient = useQueryClient();
	const { organizationId, organizationSlug, organizationName, isOrgContext } =
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

	const models = availableModelsData?.models ?? [];
	const _modelsByProvider = availableModelsData?.modelsByProvider ?? {};
	const modelsByGatewayAndProvider =
		availableModelsData?.modelsByGatewayAndProvider ?? {};
	const configuredProviders = availableModelsData?.configuredProviders ?? [];
	const defaultProvider = availableModelsData?.defaultProvider ?? null;
	const hasNoProviders = configuredProviders.length === 0;

	// Query system defaults (filtered by org's default provider)
	const { data: taskDefaults = [], isLoading: isLoadingDefaults } = useQuery({
		queryKey: ["aiTaskDefaults", organizationId, defaultProvider],
		queryFn: async () => {
			return await orpcClient.aiConfig.preferences.getTaskDefaults({
				organizationId: organizationId ?? undefined,
			});
		},
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
		enabled: !!isOrgContext && !isLoadingModels,
	});

	// Set organization preference mutation
	const setPreferenceMutation = useMutation({
		mutationFn: async (data: {
			taskType: string;
			modelCanonicalName: string;
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

	const isLoading = isLoadingModels || isLoadingDefaults || isLoadingPrefs;

	// Get the current model for a task type
	const getCurrentModel = (taskType: string): ModelOption | null => {
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

		// Parse provider and model from value (format: "PROVIDER:canonicalName")
		const [provider, modelCanonicalName] = value.includes(":")
			? [value.split(":")[0], value.split(":").slice(1).join(":")]
			: [null, value];

		setPendingChanges((prev) => ({
			...prev,
			[taskType]: {
				modelCanonicalName,
				provider,
			},
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

	if (!isOrgContext) {
		return (
			<SettingsItem
				title="AI Model Preferences"
				description="Configure AI models for your organization"
			>
				<div className="flex items-center justify-center py-8">
					<LoaderIcon className="size-5 animate-spin text-muted-foreground" />
				</div>
			</SettingsItem>
		);
	}

	return (
		<SettingsItem
			title="Organization AI Model Preferences"
			description="Configure which AI models to use for different types of tasks across your organization."
		>
			<div className="space-y-6">
				{/* Read-Only Banner */}
				{readOnly && (
					<div className="rounded-md border border-highlight/20 bg-highlight/5 p-4">
						<div className="flex gap-3">
							<LockIcon className="size-5 shrink-0 text-highlight" />
							<div className="space-y-1 text-sm">
								<p className="font-medium text-foreground">
									View Only
								</p>
								<p className="text-highlight/80">
									Only organization administrators can modify
									AI model preferences.
								</p>
							</div>
						</div>
					</div>
				)}

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
								{!readOnly && organizationSlug && (
									<Link
										href={`/app/${organizationSlug}/settings/ai-providers`}
										className="inline-flex items-center gap-1 text-highlight/80 underline hover:text-highlight"
									>
										<SettingsIcon className="size-4" />
										Configure AI Providers
									</Link>
								)}
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
								Organization-Wide Settings
							</p>
							<p className="text-muted-foreground">
								These model preferences apply to all members of{" "}
								<strong>{organizationName}</strong>. Enable the
								lock icon to prevent members from overriding
								specific task settings.
							</p>
						</div>
					</div>
				</div>

				{/* Enforce Banner */}
				{!readOnly && (
					<div className="rounded-md border border-secondary/20 bg-secondary/5 p-4">
						<div className="flex gap-3">
							<ShieldIcon className="size-5 shrink-0 text-secondary" />
							<div className="space-y-1 text-sm">
								<p className="font-medium text-foreground">
									Enforce for Members
								</p>
								<p className="text-secondary/80">
									When enabled, organization members cannot
									override the model preference for that task
									type. This is useful for ensuring compliance
									with cost or capability requirements.
								</p>
							</div>
						</div>
					</div>
				)}

				{/* Save Button */}
				{hasPendingChanges && !readOnly && (
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
							const currentGateway = getCurrentGateway(
								taskType.id,
							);
							const hierarchicalModels =
								getHierarchicalModelsForTask(taskType.id);
							const hasCustomPref = hasOrgPreference(taskType.id);
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
								if (currentGateway) {
									return currentGateway;
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
															className="border-yellow-500 text-xs text-highlight"
														>
															Unsaved
														</Badge>
													)}
												</div>
												<p className="text-xs text-muted-foreground">
													{taskType.description}
												</p>
											</div>
										</div>

										{/* Model Selection - Hierarchical Dropdown */}
										<div className="flex items-center gap-3">
											<Select
												value={currentValue}
												onValueChange={(value) =>
													handleModelChange(
														taskType.id,
														value,
													)
												}
												disabled={
													hasNoProviders ||
													readOnly ||
													!hasModels
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
															<div className="flex items-center gap-2">
																<span className="truncate">
																	{
																		currentModel.displayName
																	}
																</span>
																{currentGateway && (
																	<Badge
																		variant="outline"
																		className="text-xs shrink-0"
																	>
																		via{" "}
																		{PROVIDER_DISPLAY_NAMES[
																			currentGateway
																		] ||
																			currentGateway}
																	</Badge>
																)}
															</div>
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
														<div className="px-2 py-4 text-center text-sm text-muted-foreground">
															No models available
															for this task type
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

											{hasCustomPref && !readOnly && (
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
												<Link
													href={`/app/${organizationSlug}/settings/ai-providers`}
													className="font-medium underline hover:text-highlight"
												>
													Configure AI Providers
												</Link>
											</p>
										</div>
									)}

									{/* Current Model Details */}
									{currentModel && (
										<div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
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
											{currentGateway && (
												<Badge
													variant="outline"
													className="text-xs border-cyan-500 text-cyan-600"
												>
													Route:{" "}
													{PROVIDER_DISPLAY_NAMES[
														currentGateway
													] || currentGateway}
												</Badge>
											)}
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
