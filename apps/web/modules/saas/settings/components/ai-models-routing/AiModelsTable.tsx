"use client";

import { embeddingModelFitsVectorStore } from "@repo/rag/lib/embedding/dimensions";
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
import { LockIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
	type ChatgptPlanModelTask,
	useSetChatgptPlanModel,
} from "../chatgpt-plan-models/chatgpt-plan-models-queries";
import { useEmbeddingsChangeConfirmation } from "../EmbeddingsChangeConfirmDialog";
import {
	API_DEFAULT_VALUE,
	ApiTaskModelSelect,
} from "../org-ai-model-preferences/ApiTaskModelSelect";
import { DefaultApiProviderPanel } from "../org-ai-model-preferences/DefaultApiProviderPanel";
import { ModelFitNote } from "../org-ai-model-preferences/ModelFitNote";
import {
	PROVIDER_DISPLAY_NAMES,
	TEXT_TASK_IDS,
	useOrgApiModelPreferences,
} from "../org-ai-model-preferences/use-org-api-model-preferences";
import type { AiRoutingData } from "./use-ai-routing-data";

/** The plan's text work first, in the order the plan card used, then API-only work. */
const ROWS = [
	"COMPLEX",
	"REASONING",
	"TOOL_CALLING",
	"CHAT",
	"EVAL",
	"SIMPLE",
	"IMAGE",
	"AUDIO",
	"DECISION",
] as const;

type RowTask = (typeof ROWS)[number];

const DEFAULT_VALUE = "__default__";

function clock(date: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(date));
}

type PlanModels = NonNullable<AiRoutingData["planModels"]["data"]>;

function PlanModelSelect({
	task,
	plan,
	taskName,
}: {
	task: ChatgptPlanModelTask;
	plan: PlanModels;
	taskName: string;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const tRouting = useTranslations("settings.aiModelsRouting.routing");
	const save = useSetChatgptPlanModel({
		onSuccess: () => toast.success(tRouting("saved")),
		onError: () => toast.error(tRouting("saveFailed")),
	});
	const isDefault = task.source !== "organization" || !task.model;
	const defaultLabel =
		task.source === "default" && task.model
			? t("defaultModel", { model: task.model.displayName })
			: t("defaultPlain");
	return (
		<div className="space-y-1">
			<Select
				disabled={!plan.canEdit || save.isPending}
				onValueChange={(value) =>
					save.mutate({
						taskType: task.taskType,
						modelCanonicalName:
							value === DEFAULT_VALUE ? null : value,
					})
				}
				value={
					isDefault
						? DEFAULT_VALUE
						: (task.model?.canonicalName ?? "")
				}
			>
				<SelectTrigger
					aria-label={t("planSelectLabel", { task: taskName })}
					className={cn(
						"w-full",
						isDefault && "text-muted-foreground",
					)}
				>
					<SelectValue>
						<span className="block truncate text-left">
							{isDefault ? defaultLabel : task.model?.displayName}
						</span>
					</SelectValue>
				</SelectTrigger>
				<SelectContent className="max-w-[380px]">
					<SelectItem value={DEFAULT_VALUE}>
						{defaultLabel}
					</SelectItem>
					<SelectGroup>
						<SelectLabel className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
							{t("servedGroup")}
						</SelectLabel>
						{plan.models.map((model) => (
							<SelectItem
								key={model.canonicalName}
								textValue={model.displayName}
								value={model.canonicalName}
							>
								<span className="flex flex-col gap-0.5">
									<span>
										{model.displayName}
										{model.newest ? (
											<span className="ml-2 font-mono text-success text-xs">
												{t("newest")}
											</span>
										) : null}
									</span>
									{model.description ? (
										<span className="text-muted-foreground text-xs">
											{model.description}
										</span>
									) : null}
								</span>
							</SelectItem>
						))}
					</SelectGroup>
					<p className="mt-1 border-border border-t px-2 pt-2 pb-1 text-muted-foreground text-xs">
						{plan.servedCheckedAt
							? t("servedFooter", {
									time: clock(plan.servedCheckedAt),
									count: plan.models.length,
								})
							: t("servedFooterUnchecked")}
					</p>
				</SelectContent>
			</Select>
			{task.noLongerServed ? (
				<p
					className="text-highlight text-xs"
					data-testid={`ai-models-plan-not-served-${task.taskType}`}
				>
					{t("noLongerServed")}
				</p>
			) : null}
		</div>
	);
}

/**
 * The model for each kind of work, on a ChatGPT plan and on API billing, side
 * by side (Fizzy #2770 F6), then the embeddings row, which is always API.
 * The API column runs the same per-task select and preference writes as the
 * legacy AI Models form; a choice here saves at once.
 */
export function AiModelsTable({
	data,
	readOnly,
}: {
	data: AiRoutingData;
	readOnly: boolean;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const api = useOrgApiModelPreferences({ readOnly });
	// Reuse the impact check and confirmation for indexed content.
	const embeddingChange = useEmbeddingsChangeConfirmation(api.organizationId);
	const plan = data.planModels.data;
	const planTasks = new Map(
		(plan?.tasks ?? []).map((task) => [task.taskType as string, task]),
	);
	const noApi = !data.hasApiProvider;

	const apiCell = (taskType: RowTask, taskName: string) => {
		// No choice can exist here, so no control that looks clickable.
		if (noApi) {
			return (
				<span
					className="text-muted-foreground text-sm"
					data-testid={`ai-models-api-none-${taskType}`}
				>
					{t("noApiProvider")}
				</span>
			);
		}
		return apiSelect(taskType, taskName);
	};

	// Without the no-provider gate: an embeddings-only key serves this row
	// even where no provider may serve LLM work.
	const apiSelect = (taskType: RowTask | "EMBEDDING", taskName: string) => {
		const view = api.getTaskView(taskType);
		const applyChoice = (value: string) =>
			value === API_DEFAULT_VALUE
				? api.handleResetToDefault(taskType)
				: api.saveModelChoice(taskType, value);
		if (
			taskType !== "EMBEDDING" &&
			!api.isLoading &&
			!api.hasNoProviders &&
			!view.hasModels &&
			!view.noDefaultProvider
		) {
			return (
				<span
					className="text-muted-foreground text-sm"
					data-testid={`ai-models-api-no-models-${taskType}`}
				>
					{t("noModelsAvailable")}
				</span>
			);
		}
		return (
			<div className="space-y-1">
				<ApiTaskModelSelect
					ariaLabel={t("apiSelectLabel", { task: taskName })}
					// Only a task the organization chose has a choice to clear.
					defaultLabel={
						view.hasCustomPref ? t("defaultPlain") : undefined
					}
					disabled={
						readOnly || api.isLoading || embeddingChange.isChecking
					}
					hasNoProviders={api.hasNoProviders}
					modelUnavailableReason={
						taskType === "EMBEDDING"
							? (canonicalName) =>
									embeddingModelFitsVectorStore(canonicalName)
										? undefined
										: t("embeddingsNeedsVectorSize")
							: undefined
					}
					onValueChange={(value, invoker) => {
						if (
							taskType === "EMBEDDING" &&
							api.embeddingChoiceChangesIdentity(value)
						) {
							void embeddingChange.requestChange(
								() => applyChoice(value),
								invoker,
							);
							return;
						}
						applyChoice(value);
					}}
					triggerClassName="w-full"
					view={view}
				/>
				{!view.isDefaultChoice &&
					(view.hasCustomPref || view.hasPendingChange) && (
						<ModelFitNote
							taskType={view.taskType}
							model={view.currentModel}
						/>
					)}
				{view.hasCustomPref ? (
					<p className="inline-flex items-center gap-1 text-muted-foreground text-xs">
						<LockIcon aria-hidden="true" className="size-3" />
						{t("enforced")}
					</p>
				) : null}
			</div>
		);
	};

	const renderTable = (tasks: readonly RowTask[], label: string) => (
		<div className="min-w-0">
			<table
				aria-label={label}
				className="block w-full border-collapse text-sm md:table md:table-fixed"
			>
				<thead className="sr-only md:not-sr-only">
					<tr className="border-border border-b text-left text-muted-foreground text-xs">
						<th className="pb-2.5 font-medium" scope="col">
							{t("kindColumn")}
						</th>
						<th
							className="w-[34%] px-3 pb-2.5 font-medium"
							scope="col"
						>
							{t("planColumn")}
							<span className="block font-normal">
								{t("planColumnHint")}
							</span>
						</th>
						<th
							className="w-[34%] pb-2.5 pl-3 font-medium"
							scope="col"
						>
							{t("apiColumn")}
							<span className="block font-normal">
								{noApi
									? t("apiColumnHintNone")
									: t("apiColumnHint")}
							</span>
						</th>
					</tr>
				</thead>
				<tbody className="block md:table-row-group">
					{tasks.map((taskType) => {
						const taskName = t(`tasks.${taskType}.name`);
						const planTask = planTasks.get(taskType);
						// A decision a plan can serve is made by the
						// language model of the work it belongs to, on
						// the plan; the API decision model is the fallback.
						const decidedOnPlan = Boolean(
							plan && taskType === "DECISION",
						);
						return (
							<tr
								className="block border-border border-b py-3 last:border-b-0 md:table-row md:py-0"
								data-testid={`ai-models-row-${taskType}`}
								key={taskType}
							>
								<th
									className="block pb-2 text-left font-medium md:table-cell md:py-3 md:pr-3"
									scope="row"
								>
									{taskName}
									<span className="block font-normal text-muted-foreground text-xs">
										{t(`tasks.${taskType}.hint`)}
									</span>
								</th>
								{!(planTask && plan) &&
								!decidedOnPlan &&
								noApi ? (
									// Neither column could ever offer a choice.
									<td
										className="block py-2 align-middle text-muted-foreground text-sm md:table-cell md:px-3 md:py-3"
										colSpan={2}
										data-testid={`ai-models-unavailable-${taskType}`}
									>
										{t("needsApiProvider")}
									</td>
								) : (
									<>
										<td className="block py-2 align-middle md:table-cell md:px-3 md:py-3">
											<span
												aria-hidden="true"
												className="mb-1 block text-xs text-muted-foreground md:hidden"
											>
												{t("planColumn")}
											</span>
											{planTask && plan ? (
												<PlanModelSelect
													plan={plan}
													task={planTask}
													taskName={taskName}
												/>
											) : decidedOnPlan ? (
												<div
													className="space-y-1 text-sm"
													data-testid={`ai-models-plan-decision-${taskType}`}
												>
													<p>{t("decisionOnPlan")}</p>
													<p className="text-muted-foreground text-xs">
														{t(
															"decisionOnPlanHint",
														)}
													</p>
												</div>
											) : (
												<span className="text-muted-foreground text-sm">
													{t("notOnPlan")}
												</span>
											)}
										</td>
										<td className="block py-2 align-middle md:table-cell md:py-3 md:pl-3">
											<span
												aria-hidden="true"
												className="mb-1 block text-xs text-muted-foreground md:hidden"
											>
												{t("apiColumn")}
											</span>
											{apiCell(taskType, taskName)}
										</td>
									</>
								)}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);

	return (
		<Card
			aria-labelledby="ai-models-heading"
			className="space-y-4 p-6"
			data-testid="ai-models-table"
			role="region"
		>
			<div className="space-y-1">
				<p className="app-editorial-label">{t("label")}</p>
				<h2 className="font-medium text-lg" id="ai-models-heading">
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>

			<section aria-label={t("textTasks")} className="space-y-3">
				{!noApi && (
					<DefaultApiProviderPanel
						api={api}
						readOnly={readOnly}
						disabled={embeddingChange.isChecking}
					/>
				)}
				{renderTable(TEXT_TASK_IDS, t("textTasks"))}
			</section>
			<section aria-label={t("otherWorkTitle")} className="space-y-3">
				<h2 className="font-medium text-lg">{t("otherWorkTitle")}</h2>
				<p className="text-muted-foreground text-sm">
					{t("otherWorkDescription")}
				</p>
				{renderTable(
					["IMAGE", "AUDIO", "DECISION"],
					t("otherWorkTitle"),
				)}

				<EmbeddingsRow apiSelect={apiSelect} data={data} />
			</section>
			{embeddingChange.dialog}
		</Card>
	);
}

function EmbeddingsRow({
	data,
	apiSelect,
}: {
	data: AiRoutingData;
	apiSelect: (taskType: "EMBEDDING", taskName: string) => ReactNode;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const provider = data.embeddingProvider;
	const providerName = provider
		? (PROVIDER_DISPLAY_NAMES[provider] ?? provider)
		: null;
	return (
		<div
			className="grid items-center gap-x-6 gap-y-3 rounded-lg bg-muted p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
			data-testid="ai-models-embeddings"
		>
			<div className="font-medium text-sm">
				{t("embeddingsTitle")}
				<span className="block font-normal text-muted-foreground text-xs">
					{t("embeddingsHint")}
				</span>
			</div>
			{data.organizationEmbedding?.source === "platform" ? (
				<p className="text-muted-foreground text-sm">
					{t("embeddingsPlatform")}
				</p>
			) : !data.organizationEmbedding ? (
				<p className="text-muted-foreground text-sm">
					{t("embeddingsResolutionUnavailable")}
				</p>
			) : provider ? (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="w-full max-w-md">
						{apiSelect("EMBEDDING", t("embeddingsTitle"))}
					</div>
					<span className="text-muted-foreground text-sm">
						{providerName
							? `${t("embeddingsVia", { provider: providerName })} · `
							: ""}
						{t("embeddingsWhy")}
					</span>
				</div>
			) : (
				<div
					className="grid gap-1 rounded-md border border-highlight/30 bg-highlight/5 p-3 text-sm"
					data-testid="ai-models-embeddings-off"
				>
					<strong className="font-medium">
						{t("embeddingsOffTitle")}
					</strong>
					<span className="text-muted-foreground">
						{t("embeddingsOffBody")}
					</span>
					{data.providersHref ? (
						<Link
							className="w-fit text-primary underline underline-offset-4"
							href={data.providersHref}
						>
							{t("addEmbeddingsKey")}
						</Link>
					) : null}
				</div>
			)}
		</div>
	);
}
