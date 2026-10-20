"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { ArrowDownIcon, ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useSetChatgptPlanFallbackModel } from "../chatgpt-plan-models/chatgpt-plan-models-queries";
import { AdvancedSettings } from "../chatgpt-plan-pool/AdvancedSettings";
import {
	useAcknowledgeChatgptPlanPoolTerms,
	useUpdateChatgptPlanPoolPolicy,
} from "../chatgpt-plan-pool/chatgpt-plan-pool-queries";
import {
	CHATGPT_PLAN_TERMS_ANCHOR,
	scrollToTermsWhenTargeted,
} from "../chatgpt-plan-pool/chatgpt-plan-terms-anchor";
import { InfoTip } from "../chatgpt-plan-pool/InfoTip";
import { PROVIDER_DISPLAY_NAMES } from "../org-ai-model-preferences/use-org-api-model-preferences";
import { SegmentedControl } from "./SegmentedControl";
import type { AiRoutingData } from "./use-ai-routing-data";

/**
 * What background work may use of each shared account's window, in percent.
 * Stored the other way round, as `headroomPct`: the share left for people,
 * so what is shown is `100 - headroomPct` (Fizzy #3085 FR8).
 */
const BACKGROUND_SHARE_CHOICES = [20, 40, 60, 80, 100] as const;
/** The stored `headroomPct` of an organization that never chose one: no limit. */
const DEFAULT_HEADROOM_PCT = 0;
const NO_FALLBACK = "__none__";

function Step({
	number,
	title,
	body,
	status,
	action,
	testId,
}: {
	number: number;
	title: string;
	body: string;
	status: ReactNode;
	action?: ReactNode;
	testId: string;
}) {
	return (
		<li
			className="grid min-w-0 content-start gap-1.5 rounded-lg border border-border bg-muted p-4"
			data-testid={testId}
		>
			<span className="font-mono text-muted-foreground text-xs">
				{number}
			</span>
			<span className="font-medium">{title}</span>
			<span className="text-muted-foreground text-sm">{body}</span>
			{status}
			{action}
		</li>
	);
}

function PolicyRow({
	question,
	help,
	children,
	testId,
}: {
	question: string;
	help: string;
	children: ReactNode;
	testId: string;
}) {
	return (
		<div
			className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-border border-t pt-4"
			data-testid={testId}
		>
			<div className="max-w-prose space-y-0.5">
				<p className="font-medium text-sm">{question}</p>
				<p className="text-muted-foreground text-sm">{help}</p>
			</div>
			<div className="flex flex-col items-start gap-3 sm:items-end">
				{children}
			</div>
		</div>
	);
}

/**
 * How AI work runs in the organization (Fizzy #2770 F6): the sources a
 * request tries in order with their live status — the last one the viewer's
 * own personal key, shown only as it stands for them (Fizzy #3085) — then
 * the organization's
 * policy — what happens when every plan is spent, and the fallback
 * for a model a plan stops serving. The one home of that policy.
 */
export function AiRoutingCard({ data }: { data: AiRoutingData }) {
	const t = useTranslations("settings.aiModelsRouting.routing");
	// Copy that already lives with the shared-accounts settings.
	const tPool = useTranslations("settings.chatgptPlanPool");
	const onSave = {
		onSuccess: () => toast.success(t("saved")),
		onError: () => toast.error(t("saveFailed")),
	};
	const updatePolicy = useUpdateChatgptPlanPoolPolicy(onSave);
	const acknowledge = useAcknowledgeChatgptPlanPoolTerms(onSave);
	const setFallback = useSetChatgptPlanFallbackModel(onSave);

	const plan = data.planModels.data;
	const pool = data.pool.data;
	const policy = pool?.policy;
	const canEdit = plan?.canEdit ?? false;
	// Accounts serve as soon as an owner has accepted the sharing terms.
	const sharingOn = Boolean(policy?.termsAcknowledged);

	const activeAccounts =
		pool?.accounts.filter(
			(account) => account.enabled && account.status === "ACTIVE",
		) ?? [];
	const windowPercent =
		activeAccounts.length > 0
			? Math.round(
					activeAccounts.reduce(
						(sum, account) =>
							sum +
							(account.usageEstimate.percent ??
								account.usageEstimate.estimatedPercent),
						0,
					) / activeAccounts.length,
				)
			: 0;

	const sharedStatus = !sharingOn ? (
		<Badge status="info">{t("sharedNeedsTerms")}</Badge>
	) : activeAccounts.length === 0 ? (
		<Badge status="warning">{t("sharedNone")}</Badge>
	) : (
		<Badge status="success">
			{t("sharedActive", {
				count: activeAccounts.length,
				percent: windowPercent,
			})}
		</Badge>
	);

	const apiNames = data.apiProviders.map(
		(provider) =>
			provider.displayName ??
			PROVIDER_DISPLAY_NAMES[provider.provider] ??
			provider.provider,
	);

	const background = data.hasApiProvider
		? (policy?.apiFallbackBackground ?? "NEVER")
		: "NEVER";
	// A stored NEVER, no longer offered, reads as Stop.
	const people =
		data.hasApiProvider && policy?.apiFallbackInteractive === "AUTO"
			? "AUTO"
			: "ASK";
	const spentHelp = !data.hasApiProvider
		? t("spentHelpNoApi")
		: [
				background === "AUTO"
					? t("spentHelpBackgroundApi")
					: t("spentHelpBackgroundWait"),
				people === "AUTO"
					? t("spentHelpPeopleApi")
					: background === "AUTO"
						? t("spentHelpPeopleStopApi")
						: t("spentHelpPeopleStopWait"),
			].join(" ");
	const spentDisabled = !canEdit || updatePolicy.isPending;
	const backgroundShare = 100 - (policy?.headroomPct ?? DEFAULT_HEADROOM_PCT);
	// Why "Use API billing" cannot be chosen, said next to it.
	const apiDisabledReason = data.hasApiProvider
		? null
		: data.onlyEmbeddingsKeys
			? t("apiNeedsLlmProvider")
			: t("apiNeedsProvider");

	const models = plan?.models ?? [];
	const fallback = plan?.fallbackModel ?? null;
	const fallbackHelp =
		fallback === null
			? t("fallbackHelpNone")
			: fallback === plan?.recommendedFallbackModel
				? t("fallbackHelpRecommended")
				: t("fallbackHelpOther");

	return (
		<Card
			aria-labelledby="ai-routing-heading"
			className="space-y-4 p-6"
			data-testid="ai-routing-card"
			role="region"
		>
			<div className="space-y-1">
				<p className="app-editorial-label">{t("label")}</p>
				<h2 className="font-medium text-lg" id="ai-routing-heading">
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>

			<ol className="grid gap-2.5 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
				<Step
					body={t("ownPlansBody")}
					number={1}
					status={
						<Badge status="info">
							{t("ownPlansCount", {
								count: plan?.ownPlanMembers ?? 0,
							})}
						</Badge>
					}
					testId="ai-routing-step-own"
					title={t("ownPlansTitle")}
				/>
				<StepArrow />
				<Step
					action={
						data.providersHref ? (
							<Link
								className="w-fit text-primary text-sm underline underline-offset-4"
								href={`${data.providersHref}#shared-chatgpt-plans`}
							>
								{t("manageShared")}
							</Link>
						) : undefined
					}
					body={t("sharedBody")}
					number={2}
					status={sharedStatus}
					testId="ai-routing-step-shared"
					title={t("sharedTitle")}
				/>
				<StepArrow />
				<Step
					action={
						data.providersHref ? (
							<Link
								className="w-fit text-primary text-sm underline underline-offset-4"
								href={data.providersHref}
							>
								{data.hasApiProvider
									? t("manageProviders")
									: t("addProvider")}
							</Link>
						) : undefined
					}
					body={data.hasApiProvider ? t("apiBody") : t("apiBodyNone")}
					number={3}
					status={
						data.hasApiProvider ? (
							<Badge status="success">
								{apiNames.join(" · ")}
							</Badge>
						) : (
							<Badge status="warning">{t("apiNone")}</Badge>
						)
					}
					testId="ai-routing-step-api"
					title={t("apiTitle")}
				/>
				<StepArrow />
				<Step
					action={
						data.providersHref ? (
							<Link
								className="w-fit text-primary text-sm underline underline-offset-4"
								href={`${data.providersHref}?tab=personal`}
							>
								{data.planSpentPersonalProvider
									? t("personalManage")
									: t("personalSetUp")}
							</Link>
						) : undefined
					}
					body={t("personalBody")}
					number={4}
					status={
						data.planSpentPersonalProvider ? (
							<Badge status="success">
								{t("personalUsed", {
									provider:
										PROVIDER_DISPLAY_NAMES[
											data.planSpentPersonalProvider
										] ?? data.planSpentPersonalProvider,
								})}
							</Badge>
						) : (
							<Badge status="info">{t("personalNotSet")}</Badge>
						)
					}
					testId="ai-routing-step-personal"
					title={t("personalTitle")}
				/>
			</ol>

			{policy && !policy.termsAcknowledged ? (
				<div
					className="scroll-mt-24 space-y-2 rounded-md border border-border p-3"
					data-testid="ai-routing-terms"
					id={CHATGPT_PLAN_TERMS_ANCHOR}
					ref={scrollToTermsWhenTargeted}
				>
					<p className="font-medium text-sm">{tPool("termsTitle")}</p>
					<p className="text-muted-foreground text-sm">
						{tPool("termsBody")}
					</p>
					{pool?.viewer.isOwner ? (
						<Button
							autoLoading={false}
							disabled={acknowledge.isPending}
							onClick={() => acknowledge.mutate(undefined)}
							size="sm"
							type="button"
						>
							{tPool("acceptTerms")}
						</Button>
					) : (
						<p className="text-sm">{tPool("ownerOnly")}</p>
					)}
				</div>
			) : null}

			<PolicyRow
				help={spentHelp}
				question={t("spentQuestion")}
				testId="ai-routing-spent"
			>
				<div className="flex flex-wrap items-center gap-2 sm:justify-end">
					<span className="text-muted-foreground text-sm">
						{t("backgroundLabel")}
					</span>
					<SegmentedControl
						ariaLabel={t("backgroundLabel")}
						disabled={spentDisabled}
						onValueChange={(value) =>
							updatePolicy.mutate({
								apiFallbackBackground: value,
							})
						}
						options={[
							{ value: "NEVER", label: t("backgroundWait") },
							{
								value: "AUTO",
								label: t("backgroundApi"),
								disabled: !data.hasApiProvider,
							},
						]}
						value={background}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2 sm:justify-end">
					<span className="text-muted-foreground text-sm">
						{t("peopleLabel")}
					</span>
					<SegmentedControl
						ariaLabel={t("peopleLabel")}
						disabled={spentDisabled}
						onValueChange={(value) =>
							updatePolicy.mutate({
								apiFallbackInteractive: value,
							})
						}
						options={[
							{ value: "ASK", label: t("peopleStop") },
							{
								value: "AUTO",
								label: t("peopleApi"),
								disabled: !data.hasApiProvider,
							},
						]}
						value={people}
					/>
				</div>
				{apiDisabledReason ? (
					<p
						className="max-w-sm text-muted-foreground text-xs sm:text-right"
						data-testid="ai-routing-api-disabled-reason"
					>
						{apiDisabledReason}
					</p>
				) : null}
				<AdvancedSettings testId="ai-routing-advanced">
					<div className="flex flex-wrap items-center gap-2 sm:justify-end">
						<div className="flex items-center gap-1.5">
							<Label
								className="font-normal text-muted-foreground"
								htmlFor="ai-routing-background-share"
							>
								{t("backgroundShareLabel")}
							</Label>
							<InfoTip
								setting={t("backgroundShareLabel")}
								text={t("backgroundShareTooltip")}
							/>
						</div>
						<Select
							disabled={spentDisabled}
							onValueChange={(value) =>
								updatePolicy.mutate({
									headroomPct: 100 - Number(value),
								})
							}
							value={String(backgroundShare)}
						>
							<SelectTrigger
								className="w-24"
								id="ai-routing-background-share"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{[
									...new Set<number>([
										...BACKGROUND_SHARE_CHOICES,
										backgroundShare,
									]),
								]
									.sort((a, b) => a - b)
									.map((percent) => (
										<SelectItem
											key={percent}
											value={String(percent)}
										>
											{`${percent}%`}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					</div>
					<p className="max-w-sm text-muted-foreground text-xs sm:text-right">
						{t("backgroundShareDescription")}
					</p>
				</AdvancedSettings>
				{data.hasApiProvider &&
				sharingOn &&
				(background === "AUTO" || people === "AUTO") ? (
					<Alert
						className="max-w-md"
						data-testid="ai-routing-auto-warning"
						variant="warning"
					>
						<AlertTitle>
							{tPool("backgroundAutoWarningTitle")}
						</AlertTitle>
						<AlertDescription>
							{people === "AUTO"
								? `${tPool("backgroundAutoWarning")} ${tPool("peopleAutoWarning")}`
								: tPool("backgroundAutoWarning")}
						</AlertDescription>
					</Alert>
				) : null}
			</PolicyRow>

			<PolicyRow
				help={fallbackHelp}
				question={t("fallbackQuestion")}
				testId="ai-routing-fallback"
			>
				<Select
					disabled={!canEdit || setFallback.isPending}
					onValueChange={(value) =>
						setFallback.mutate(value === NO_FALLBACK ? null : value)
					}
					value={fallback ?? NO_FALLBACK}
				>
					<SelectTrigger
						aria-label={t("fallbackLabel")}
						className="w-full sm:w-80"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{models.map((model) => (
							<SelectItem key={model.slug} value={model.slug}>
								{model.slug === plan?.recommendedFallbackModel
									? `${model.displayName} · ${t("recommended")}`
									: model.displayName}
							</SelectItem>
						))}
						<SelectItem value={NO_FALLBACK}>
							{t("noFallback")}
						</SelectItem>
					</SelectContent>
				</Select>
			</PolicyRow>
		</Card>
	);
}

function StepArrow() {
	return (
		<li aria-hidden="true" className="self-center justify-self-center">
			<ArrowRightIcon className="hidden size-4 text-muted-foreground lg:block" />
			<ArrowDownIcon className="size-4 text-muted-foreground lg:hidden" />
		</li>
	);
}
