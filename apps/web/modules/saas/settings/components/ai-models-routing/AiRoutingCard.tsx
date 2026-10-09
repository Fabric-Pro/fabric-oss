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
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import { ArrowDownIcon, ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useSetChatgptPlanFallbackModel } from "../chatgpt-plan-models/chatgpt-plan-models-queries";
import {
	useAcknowledgeChatgptPlanPoolTerms,
	useUpdateChatgptPlanPoolPolicy,
} from "../chatgpt-plan-pool/chatgpt-plan-pool-queries";
import { PROVIDER_DISPLAY_NAMES } from "../org-ai-model-preferences/use-org-api-model-preferences";
import { SegmentedControl } from "./SegmentedControl";
import type { AiRoutingData } from "./use-ai-routing-data";

const HEADROOM_CHOICES = [0, 20, 40, 60, 80] as const;
const NO_FALLBACK = "__none__";

function Step({
	number,
	title,
	body,
	status,
	action,
	muted = false,
	testId,
}: {
	number: number;
	title: string;
	body: string;
	status: ReactNode;
	action?: ReactNode;
	muted?: boolean;
	testId: string;
}) {
	return (
		<li
			className={cn(
				"grid min-w-0 content-start gap-1.5 rounded-lg border border-border bg-muted p-4",
				muted && "text-muted-foreground",
			)}
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
 * How AI work runs in the organization (Fizzy #2770 F6): the three sources a
 * request tries in order with their live status, then the organization's
 * policy — sharing, what happens when every plan is spent, and the fallback
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
	const pool = data.pooling ? data.pool.data : undefined;
	const policy = pool?.policy;
	const canEdit = plan?.canEdit ?? false;
	const sharingOn = Boolean(policy?.poolingEnabled);

	const activeAccounts =
		pool?.accounts.filter(
			(account) => account.enabled && account.status === "ACTIVE",
		) ?? [];
	const windowPercent =
		activeAccounts.length > 0
			? Math.round(
					activeAccounts.reduce(
						(sum, account) =>
							sum + account.usageEstimate.estimatedPercent,
						0,
					) / activeAccounts.length,
				)
			: 0;

	const sharedStatus = !data.pooling ? (
		<Badge status="info">{t("sharedNotEnabled")}</Badge>
	) : !sharingOn ? (
		<Badge status="info">{t("sharedOff")}</Badge>
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

	const background = policy?.apiFallbackBackground ?? "NEVER";
	const spentHelp = !data.hasApiProvider
		? t("spentHelpNoApi")
		: !data.pooling || !sharingOn
			? t("spentHelpNoSharing")
			: background === "AUTO"
				? t("spentHelpAuto")
				: t("spentHelpWait");
	const spentDisabled =
		!canEdit || !data.pooling || !sharingOn || updatePolicy.isPending;

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

			<ol className="grid gap-2.5 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
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
						data.pooling && data.providersHref ? (
							<Link
								className="w-fit text-primary text-sm underline underline-offset-4"
								href={`${data.providersHref}#shared-chatgpt-plans`}
							>
								{t("manageShared")}
							</Link>
						) : undefined
					}
					body={t("sharedBody")}
					muted={!data.pooling}
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
			</ol>

			{data.pooling && policy ? (
				<PolicyRow
					help={
						policy.termsAcknowledged
							? t("sharingHelp")
							: t("sharingNeedsTerms")
					}
					question={t("sharingQuestion")}
					testId="ai-routing-sharing"
				>
					<Switch
						aria-label={t("sharingQuestion")}
						checked={policy.poolingEnabled}
						disabled={
							!canEdit ||
							!policy.termsAcknowledged ||
							updatePolicy.isPending
						}
						onCheckedChange={(checked) =>
							updatePolicy.mutate({ poolingEnabled: checked })
						}
					/>
				</PolicyRow>
			) : null}
			{data.pooling && policy && !policy.termsAcknowledged ? (
				<div
					className="space-y-2 rounded-md border border-border p-3"
					data-testid="ai-routing-terms"
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
						{t("interactiveLabel")}
					</span>
					<Badge status="outline" title={t("interactiveFixed")}>
						{t("interactiveAsk")}
					</Badge>
				</div>
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
						value={data.hasApiProvider ? background : "NEVER"}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2 sm:justify-end">
					<Label
						className="font-normal text-muted-foreground"
						htmlFor="ai-routing-headroom"
					>
						{t("headroomLabel")}
					</Label>
					<Select
						disabled={spentDisabled}
						onValueChange={(value) =>
							updatePolicy.mutate({ headroomPct: Number(value) })
						}
						value={String(policy?.headroomPct ?? 40)}
					>
						<SelectTrigger
							className="w-24"
							id="ai-routing-headroom"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{[
								...new Set<number>([
									...HEADROOM_CHOICES,
									policy?.headroomPct ?? 40,
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
				{data.hasApiProvider && sharingOn && background === "AUTO" ? (
					<Alert
						className="max-w-md"
						data-testid="ai-routing-auto-warning"
						variant="warning"
					>
						<AlertTitle>
							{tPool("backgroundAutoWarningTitle")}
						</AlertTitle>
						<AlertDescription>
							{tPool("backgroundAutoWarning")}
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
			<ArrowRightIcon className="hidden size-4 text-muted-foreground md:block" />
			<ArrowDownIcon className="size-4 text-muted-foreground md:hidden" />
		</li>
	);
}
