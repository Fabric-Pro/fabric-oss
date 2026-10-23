"use client";

import type { AiTaskType } from "@repo/database";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
	EmbeddingsChangeConfirmation,
	hasIndexedEmbeddingContent,
	matchesEmbeddingsConfirmation,
	useEmbeddingsChangeImpact,
} from "../EmbeddingsChangeConfirmDialog";
import {
	PROVIDER_DISPLAY_NAMES,
	TEXT_TASK_IDS,
	type useOrgApiModelPreferences,
} from "./use-org-api-model-preferences";

type ProviderLabel = { provider: string; displayName?: string | null };

const TASK_LABEL_KEYS = {
	SIMPLE: "tasks.SIMPLE.name",
	COMPLEX: "tasks.COMPLEX.name",
	REASONING: "tasks.REASONING.name",
	CHAT: "tasks.CHAT.name",
	TOOL_CALLING: "tasks.TOOL_CALLING.name",
	EVAL: "tasks.EVAL.name",
	IMAGE: "tasks.IMAGE.name",
	AUDIO: "tasks.AUDIO.name",
	DECISION: "tasks.DECISION.name",
	EMBEDDING: "embeddingsTitle",
} as const satisfies Record<AiTaskType, string>;

/** The same server-computed review from AI Models and AI Providers. */
export function DefaultApiProviderSwitchDialog({
	organizationId,
	currentProvider,
	configuredProviders,
	open,
	onOpenChange,
	initialProvider = "",
	disabled = false,
	hasPendingChanges = false,
	onSuccess,
	children,
}: {
	organizationId: string | null | undefined;
	currentProvider: string | null;
	configuredProviders: ProviderLabel[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialProvider?: string;
	disabled?: boolean;
	hasPendingChanges?: boolean;
	onSuccess?: () => void;
	children?: ReactNode;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const client = useQueryClient();
	const [target, setTarget] = useState(initialProvider);
	const [confirmation, setConfirmation] = useState("");
	const targets = useQuery({
		queryKey: ["aiDefaultProviderSwitch", organizationId, ""],
		queryFn: () =>
			orpcClient.aiConfig.providers.previewSetDefault({
				organizationId: organizationId as string,
			}),
		enabled: open && !!organizationId,
		staleTime: 0,
	});
	const preview = useQuery({
		queryKey: ["aiDefaultProviderSwitch", organizationId, target],
		queryFn: () =>
			orpcClient.aiConfig.providers.previewSetDefault({
				organizationId: organizationId as string,
				provider: target || undefined,
			}),
		enabled: open && !!organizationId && !!target,
		staleTime: 0,
	});
	const plan = target ? preview.data : targets.data;
	const validProviders =
		targets.data?.validProviders ?? preview.data?.validProviders ?? [];
	const previewError = preview.error ?? targets.error;
	const providerName = (provider: string | null) =>
		configuredProviders.find((p) => p.provider === provider)?.displayName ||
		(provider
			? PROVIDER_DISPLAY_NAMES[provider] || provider
			: t("providerNotConfigured"));
	const mutation = useMutation({
		mutationFn: () =>
			orpcClient.aiConfig.providers.setDefault({
				provider: target,
				organizationId: organizationId ?? undefined,
			}),
		onSuccess: async () => {
			onSuccess?.();
			await Promise.all(
				[
					"aiConfigStatus",
					"aiAvailableModels",
					"aiTaskDefaults",
					"aiOrgPreferences",
					"aiDefaultProviderSwitch",
				].map((key) =>
					client.invalidateQueries({
						queryKey: [key, organizationId],
					}),
				),
			);
			onOpenChange(false);
		},
	});
	const impact = useEmbeddingsChangeImpact(
		organizationId,
		open && !!plan?.embeddingsModelChanged,
	);
	const needsEmbeddingConfirmation =
		!!plan?.embeddingsModelChanged &&
		(impact.isPending ||
			impact.isFetching ||
			impact.isError ||
			!impact.data ||
			hasIndexedEmbeddingContent(impact.data));
	const canApply =
		!!target &&
		!!plan &&
		target === plan.targetProvider &&
		target !== plan.currentProvider &&
		preview.isSuccess &&
		!preview.isFetching &&
		!disabled &&
		!mutation.isPending &&
		(!needsEmbeddingConfirmation ||
			(!impact.isPending &&
				!impact.isFetching &&
				matchesEmbeddingsConfirmation(
					confirmation,
					t("embeddingsConfirmationWord"),
				)));
	return (
		<AlertDialog
			open={open}
			onOpenChange={(value) => {
				if (!mutation.isPending) {
					if (value) {
						setTarget(initialProvider);
						setConfirmation("");
						mutation.reset();
					}
					onOpenChange(value);
				}
			}}
		>
			{children && (
				<AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
			)}
			<AlertDialogContent className="max-h-dvh overflow-y-auto">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{target
							? t("switchTitle", {
									provider: providerName(target),
								})
							: t("chooseDefaultApiProvider")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t("switchDescription")} {t("providerSwitchNote")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="space-y-3 text-sm">
					<p>
						{t("currentProvider", {
							provider: providerName(
								plan?.currentProvider ?? currentProvider,
							),
						})}
					</p>
					<Select
						value={target}
						onValueChange={(value) => {
							setTarget(value);
							setConfirmation("");
							mutation.reset();
						}}
						disabled={disabled || mutation.isPending}
					>
						<SelectTrigger aria-label={t("changeProvider")}>
							<SelectValue placeholder={t("changeProvider")} />
						</SelectTrigger>
						<SelectContent>
							{validProviders.map((p) => (
								<SelectItem key={p.provider} value={p.provider}>
									{providerName(p.provider)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{previewError && (
						<p role="alert" className="text-destructive">
							{previewError.message}
						</p>
					)}
					{target && plan && plan.targetProvider === target && (
						<>
							<ul className="space-y-2">
								{plan.textTasks.map((row) => {
									const current =
										row.currentModel?.displayName ??
										t("noDefaultModel");
									const next = row.targetModel
										? t("systemDefaultModel", {
												model: row.targetModel
													.displayName,
											})
										: t("noDefaultModel");
									return (
										<li
											key={row.taskType}
											data-testid={`provider-switch-task-${row.taskType}`}
											className="flex flex-wrap justify-between gap-2"
											aria-label={t(
												"switchTaskAccessible",
												{
													task: t(
														TASK_LABEL_KEYS[
															row.taskType
														],
													),
													current,
													target: next,
												},
											)}
										>
											<span>
												{t(
													TASK_LABEL_KEYS[
														row.taskType
													],
												)}
											</span>
											<span>
												{current}{" "}
												<span aria-hidden="true">
													→
												</span>{" "}
												{next}
											</span>
										</li>
									);
								})}
							</ul>
							{plan.savedTextChoiceCount > 0 && (
								<p>
									{t("choicesRemoved", {
										count: plan.savedTextChoiceCount,
									})}
								</p>
							)}
							{hasPendingChanges && <p>{t("unsavedRemoved")}</p>}
							{plan.keptPreferences.length > 0 && (
								<>
									<p>{t("keptChoices")}</p>
									<ul>
										{plan.keptPreferences.map((row) => (
											<li key={row.id}>
												{row.provider ===
												"OPENAI_CHATGPT_PLAN"
													? t("keptPlanChoice", {
															task: t(
																TASK_LABEL_KEYS[
																	row.taskType
																],
															),
														})
													: t(
															TASK_LABEL_KEYS[
																row.taskType
															],
														)}
											</li>
										))}
									</ul>
								</>
							)}
							{plan.preservesEmbedding && (
								<p>
									{t("embeddingsStay", {
										provider: providerName(
											plan.documentsProvider,
										),
									})}
								</p>
							)}
							{needsEmbeddingConfirmation && (
								<EmbeddingsChangeConfirmation
									impact={impact.data}
									isLoading={
										impact.isPending || impact.isFetching
									}
									isError={impact.isError}
									value={confirmation}
									onValueChange={setConfirmation}
								/>
							)}
						</>
					)}
					{mutation.isError && (
						<p role="alert" className="text-destructive">
							{mutation.error.message}
						</p>
					)}
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={mutation.isPending}>
						{t("embeddingsChangeCancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						disabled={!canApply}
						onClick={(event) => {
							event.preventDefault();
							if (canApply) {
								mutation.mutate();
							}
						}}
					>
						{t("makeDefault")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** Compact bar shared by both organization model settings views. */
export function DefaultApiProviderPanel({
	api,
	readOnly,
	disabled = false,
}: {
	api: ReturnType<typeof useOrgApiModelPreferences>;
	readOnly: boolean;
	disabled?: boolean;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const [open, setOpen] = useState(false);
	const providerName =
		api.configuredProviders.find((p) => p.provider === api.defaultProvider)
			?.displayName ||
		(api.defaultProvider
			? PROVIDER_DISPLAY_NAMES[api.defaultProvider] || api.defaultProvider
			: t("providerNotConfigured"));
	return (
		<section
			aria-label={t("defaultApiProvider")}
			className="flex flex-col gap-3 rounded-lg border border-border bg-muted px-4 py-3 md:flex-row md:items-center md:justify-between"
		>
			<div className="min-w-0 space-y-1">
				<p className="app-editorial-label">{t("defaultApiProvider")}</p>
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">{providerName}</span>
					{api.defaultProvider && !readOnly && (
						<Badge variant="outline" className="text-xs">
							{t("runsTextTasks", {
								count: TEXT_TASK_IDS.length,
							})}
						</Badge>
					)}
				</div>
				{(!api.defaultProvider || !readOnly) && (
					<p className="text-xs text-muted-foreground">
						{t(
							api.defaultProvider
								? "providerSwitchNote"
								: readOnly
									? "noDefaultProviderMember"
									: "chooseDefaultProvider",
						)}
					</p>
				)}
			</div>
			{!readOnly && !api.hasNoProviders && (
				<DefaultApiProviderSwitchDialog
					organizationId={api.organizationId}
					currentProvider={api.defaultProvider}
					configuredProviders={api.configuredProviders}
					open={open}
					onOpenChange={setOpen}
					disabled={api.isLoading || api.isSaving || disabled}
					hasPendingChanges={api.hasPendingChanges}
					onSuccess={api.clearPendingChanges}
				>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="w-full shrink-0 md:w-auto"
						aria-label={t(
							api.defaultProvider
								? "changeDefaultApiProvider"
								: "chooseDefaultApiProvider",
						)}
						disabled={api.isLoading || api.isSaving || disabled}
					>
						{t(
							api.defaultProvider
								? "changeDefaultApiProvider"
								: "chooseDefaultApiProvider",
						)}
					</Button>
				</DefaultApiProviderSwitchDialog>
			)}
		</section>
	);
}
