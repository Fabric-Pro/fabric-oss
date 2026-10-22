"use client";

import { embeddingModelFitsVectorStore } from "@repo/rag/lib/embedding/dimensions";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { Button } from "@ui/components/button";
import { LoaderIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEmbeddingsChangeConfirmation } from "./EmbeddingsChangeConfirmDialog";

import {
	API_DEFAULT_VALUE,
	ApiTaskModelSelect,
} from "./org-ai-model-preferences/ApiTaskModelSelect";
import { DefaultApiProviderPanel } from "./org-ai-model-preferences/DefaultApiProviderPanel";
import { ModelFitNote } from "./org-ai-model-preferences/ModelFitNote";
import {
	TASK_TYPES,
	TEXT_TASK_IDS,
	useOrgApiModelPreferences,
} from "./org-ai-model-preferences/use-org-api-model-preferences";

export function OrgAiModelPreferencesForm({
	readOnly = false,
}: {
	readOnly?: boolean;
}) {
	const api = useOrgApiModelPreferences({ readOnly });
	const t = useTranslations("settings.aiModelsRouting.models");
	const embeddingChange = useEmbeddingsChangeConfirmation(api.organizationId);
	const applyChoice = (taskType: string, value: string) =>
		value === API_DEFAULT_VALUE
			? api.handlePendingResetToDefault(taskType)
			: api.handleModelChange(taskType, value);
	const changeChoice = (
		taskType: string,
		value: string,
		invoker?: HTMLElement | null,
	) => {
		if (
			taskType === "EMBEDDING" &&
			api.embeddingChoiceChangesIdentity(value)
		) {
			void embeddingChange.requestChange(
				() => applyChoice(taskType, value),
				invoker,
			);
			return;
		}
		applyChoice(taskType, value);
	};
	const renderRow = (taskTypeId: string) => {
		const taskType = TASK_TYPES.find((task) => task.id === taskTypeId);
		if (!taskType) {
			return null;
		}
		const view = api.getTaskView(taskType.id);
		return (
			<tr
				key={taskType.id}
				data-testid={
					taskType.id === "EMBEDDING"
						? "ai-models-embeddings"
						: `ai-models-row-${taskType.id}`
				}
				className="block border-b border-border py-3 last:border-b-0 md:table-row md:py-0"
			>
				<th
					scope="row"
					className="block pb-2 text-left font-medium md:table-cell md:py-3 md:pr-4"
				>
					<span>{taskType.label}</span>
					{view.hasPendingChange && (
						<span className="text-xs text-muted-foreground">
							{t("unsaved")}
						</span>
					)}
					<span className="block text-xs font-normal text-muted-foreground">
						{taskType.description}
					</span>
				</th>
				<td className="block py-2 md:table-cell md:py-3">
					{taskType.id === "EMBEDDING" &&
					api.organizationEmbedding?.source === "platform" ? (
						<p>{t("embeddingsPlatform")}</p>
					) : (
						<ApiTaskModelSelect
							view={view}
							triggerClassName="w-full"
							modelUnavailableReason={
								taskType.id === "EMBEDDING"
									? (name) =>
											embeddingModelFitsVectorStore(name)
												? undefined
												: t("embeddingsNeedsVectorSize")
									: undefined
							}
							hasNoProviders={api.hasNoProviders}
							disabled={readOnly || embeddingChange.isChecking}
							ariaLabel={t("apiSelectLabel", {
								task:
									taskType.id === "EMBEDDING"
										? t("embeddingsTitle")
										: t(`tasks.${taskType.id}.name`),
							})}
							defaultLabel={
								view.hasCustomPref
									? t("defaultPlain")
									: undefined
							}
							onValueChange={(value, invoker) =>
								changeChoice(taskType.id, value, invoker)
							}
						/>
					)}
					{!view.isDefaultChoice &&
						(view.hasCustomPref || view.hasPendingChange) && (
							<ModelFitNote
								taskType={view.taskType}
								model={view.currentModel}
							/>
						)}
					{view.hasCustomPref && (
						<p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
							<LockIcon aria-hidden="true" className="size-3" />
							{t("enforced")}
						</p>
					)}
					{view.hasCustomPref && !readOnly && (
						<Button
							variant="ghost"
							disabled={embeddingChange.isChecking}
							size="sm"
							onClick={() =>
								changeChoice(taskType.id, API_DEFAULT_VALUE)
							}
						>
							Reset
						</Button>
					)}
					{!view.hasModels &&
						(taskType.id !== "EMBEDDING" ||
							api.organizationEmbedding?.source !== "platform") &&
						!view.noDefaultProvider &&
						taskType.id !== "DECISION" && (
							<p className="text-xs text-muted-foreground">
								{t("noModelsAvailable")}{" "}
								{api.organizationSlug && (
									<Link
										href={`/app/${api.organizationSlug}/settings/ai-providers`}
									>
										{t("configureProvidersFirst")}
									</Link>
								)}
							</p>
						)}
					{!view.hasModels && taskType.id === "DECISION" && (
						<p className="text-xs text-muted-foreground">
							{t("decisionUnavailable")}
						</p>
					)}
					{view.isDisabledChoice && (
						<p className="text-xs text-muted-foreground">
							Decisions are switched off. Work items and
							action-item routing use your regular AI model.
						</p>
					)}
				</td>
			</tr>
		);
	};
	return (
		<SettingsItem
			title="Organization AI Model Preferences"
			description="Configure which AI models to use for different types of tasks across your organization."
		>
			<div className="space-y-6">
				{readOnly && (
					<p className="text-sm text-muted-foreground">
						Only organization administrators can modify AI model
						preferences.
					</p>
				)}
				{api.hasNoProviders && (
					<p>
						No AI Providers Configured{" "}
						{api.organizationSlug && (
							<Link
								href={`/app/${api.organizationSlug}/settings/ai-providers`}
							>
								Configure AI Providers
							</Link>
						)}
					</p>
				)}
				{!readOnly && api.hasPendingChanges && (
					<div className="flex items-center justify-between gap-3">
						<p className="text-sm">
							You have {Object.keys(api.pendingChanges).length}{" "}
							unsaved change(s)
						</p>
						<Button
							size="sm"
							disabled={
								api.isSaving || embeddingChange.isChecking
							}
							onClick={api.handleSaveAll}
						>
							{api.isSaving ? "Saving..." : "Save Changes"}
						</Button>
					</div>
				)}
				{!api.isOrgContext || api.isLoading ? (
					<LoaderIcon className="size-5 animate-spin text-muted-foreground" />
				) : (
					<>
						<section
							className="space-y-4"
							aria-label={t("textTasks")}
						>
							{!api.hasNoProviders && (
								<DefaultApiProviderPanel
									api={api}
									readOnly={readOnly}
								/>
							)}
							<div className="min-w-0">
								<table
									aria-label={t("textTasks")}
									className="block w-full text-sm md:table md:table-fixed"
								>
									<thead className="sr-only md:not-sr-only">
										<tr className="border-b border-border text-left text-xs text-muted-foreground">
											<th
												scope="col"
												className="pb-2.5 font-medium"
											>
												{t("kindColumn")}
											</th>
											<th
												scope="col"
												className="pb-2.5 font-medium"
											>
												{t("modelColumn")}
											</th>
										</tr>
									</thead>
									<tbody className="block md:table-row-group">
										{TEXT_TASK_IDS.map(renderRow)}
									</tbody>
								</table>
							</div>
						</section>
						<section
							aria-label={t("otherWorkTitle")}
							className="space-y-3"
						>
							<h2 className="text-lg font-medium">
								{t("otherWorkTitle")}
							</h2>
							<p className="text-sm text-muted-foreground">
								{t("otherWorkDescription")}
							</p>
							<div className="min-w-0">
								<table
									aria-label={t("otherWorkTitle")}
									className="block w-full text-sm md:table md:table-fixed"
								>
									<thead className="sr-only md:not-sr-only">
										<tr className="border-b border-border text-left text-xs text-muted-foreground">
											<th
												scope="col"
												className="pb-2.5 font-medium"
											>
												{t("kindColumn")}
											</th>
											<th
												scope="col"
												className="pb-2.5 font-medium"
											>
												{t("modelColumn")}
											</th>
										</tr>
									</thead>
									<tbody className="block md:table-row-group">
										{[
											"IMAGE",
											"AUDIO",
											"DECISION",
											"EMBEDDING",
										].map(renderRow)}
									</tbody>
								</table>
							</div>
						</section>
					</>
				)}
				{embeddingChange.dialog}
			</div>
		</SettingsItem>
	);
}
