"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	AlertCircleIcon,
	AlertTriangleIcon,
	CheckCircleIcon,
	LoaderIcon,
	LockIcon,
	SaveIcon,
	SettingsIcon,
	ShieldIcon,
} from "lucide-react";
import Link from "next/link";
import { ApiTaskModelSelect } from "./org-ai-model-preferences/ApiTaskModelSelect";
import {
	PROVIDER_DISPLAY_NAMES,
	TASK_TYPES,
	useOrgApiModelPreferences,
} from "./org-ai-model-preferences/use-org-api-model-preferences";

export function OrgAiModelPreferencesForm({
	readOnly = false,
}: {
	readOnly?: boolean;
}) {
	const {
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
		getTaskView,
	} = useOrgApiModelPreferences({ readOnly });

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
							const view = getTaskView(taskType.id);
							const {
								currentModel,
								currentGateway,
								hasCustomPref,
								hasPendingChange,
								isDisabledChoice,
								hasModels,
							} = view;
							const Icon = taskType.icon;

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
											<ApiTaskModelSelect
												disabled={readOnly}
												hasNoProviders={hasNoProviders}
												onValueChange={(value) =>
													handleModelChange(
														taskType.id,
														value,
													)
												}
												view={view}
											/>

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

									{/* Switched-Off Helper Text */}
									{isDisabledChoice && (
										<div className="mt-3 rounded-md border border-muted-foreground/20 bg-muted/40 px-3 py-2">
											<p className="text-xs text-muted-foreground">
												Decisions are switched off. Work
												items and action-item routing
												use your regular AI model.
											</p>
										</div>
									)}

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
												{taskType.id === "DECISION" &&
													"Decision models require Vercel AI Gateway. Work items use your regular AI model when no decision model is available."}
												{![
													"EMBEDDING",
													"IMAGE",
													"AUDIO",
													"DECISION",
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
