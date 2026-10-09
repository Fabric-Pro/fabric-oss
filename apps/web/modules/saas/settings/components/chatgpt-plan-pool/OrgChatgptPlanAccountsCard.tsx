"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Progress } from "@ui/components/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChatgptConnectCommand } from "../chatgpt-plan/ChatgptConnectCommand";
import { ChatgptPlanSubscription } from "../chatgpt-plan/ChatgptPlanSubscription";
import { useTakeBackChatgptPlan } from "../chatgpt-plan/chatgpt-plan-status";
import { PlanWindowDetails } from "../chatgpt-plan/PlanWindowDetails";
import {
	type ChatgptPlanPoolAccount,
	useDisconnectChatgptPlanPoolAccount,
	useUpdateChatgptPlanPoolAccount,
} from "./chatgpt-plan-pool-queries";

function clock(date: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(date));
}

/** The plan types an admin picks from; UNKNOWN reads as "Not set". */
const PLAN_TIER_OPTIONS = ["UNKNOWN", "PLUS", "PRO", "TEAM", "FREE"] as const;
type PlanTier = (typeof PLAN_TIER_OPTIONS)[number];

function isPlanTier(value: string): value is PlanTier {
	return (PLAN_TIER_OPTIONS as readonly string[]).includes(value);
}

/** The fair-share caps an admin picks from, in percent. */
const MEMBER_SHARE_OPTIONS = [10, 20, 25, 33, 50, 75];

function AccountStatus({ account }: { account: ChatgptPlanPoolAccount }) {
	const t = useTranslations("settings.chatgptPlanPool");
	if (account.status === "NEEDS_RECONNECT") {
		return <Badge status="warning">{t("statusNeedsReconnect")}</Badge>;
	}
	if (account.coolingUntil) {
		return (
			<Badge status="info">
				{t("statusCooling", { time: clock(account.coolingUntil) })}
			</Badge>
		);
	}
	return <Badge status="success">{t("statusActive")}</Badge>;
}

function AccountRow({
	account,
	onDisconnect,
	onTakeBack,
	takeBackBlocked,
}: {
	account: ChatgptPlanPoolAccount;
	onDisconnect: (account: ChatgptPlanPoolAccount) => void;
	onTakeBack: (account: ChatgptPlanPoolAccount) => void;
	takeBackBlocked: boolean;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	const tPlan = useTranslations("settings.chatgptPlan");
	const tShare = useTranslations("settings.chatgptPlan.share");
	const update = useUpdateChatgptPlanPoolAccount({
		onSuccess: () => toast.success(t("accountUpdated")),
		onError: () => toast.error(t("updateFailed")),
	});
	const percent = Math.round(
		Math.min(100, Math.max(0, account.usageEstimate.estimatedPercent)),
	);
	const toggle = (
		field: "enabled" | "serveInteractive" | "serveBackground",
		label: string,
	) => {
		const id = `chatgpt-plan-pool-${account.id}-${field}`;
		return (
			<div className="flex items-center justify-between gap-4">
				<Label htmlFor={id}>{label}</Label>
				<Switch
					// Every account row repeats the same three settings; the name
					// says which account a switch belongs to.
					aria-label={t("switchLabel", {
						setting: label,
						account: account.label,
					})}
					checked={account[field]}
					disabled={update.isPending}
					id={id}
					onCheckedChange={(checked) =>
						update.mutate({
							accountId: account.id,
							[field]: checked,
						})
					}
				/>
			</div>
		);
	};

	return (
		<li
			className="space-y-4 border-border border-t pt-4 first:border-t-0 first:pt-0"
			data-testid="chatgpt-plan-pool-account"
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1 text-sm">
					<p className="truncate font-medium">{account.label}</p>
					<p className="truncate text-muted-foreground">
						{account.maskedEmail ?? t("unknownAccount")}
					</p>
					<p
						className="truncate text-muted-foreground"
						data-testid="chatgpt-plan-pool-connected-by"
					>
						{account.viewerIsConnector
							? t("connectedByYou")
							: account.connectedByName
								? t("connectedBy", {
										name: account.connectedByName,
									})
								: t("connectedByUnknown")}
					</p>
					<AccountStatus account={account} />
					<ChatgptPlanSubscription
						subscriptionActiveUntil={
							account.subscriptionActiveUntil
						}
						tier={account.tier}
					/>
				</div>
				<div className="flex flex-wrap gap-2">
					{account.viewerIsConnector ? (
						<div className="space-y-1">
							<Button
								autoLoading={false}
								disabled={takeBackBlocked}
								onClick={() => onTakeBack(account)}
								size="sm"
								type="button"
								variant="outline"
							>
								{t("takeBack")}
							</Button>
							{takeBackBlocked ? (
								<p className="max-w-56 text-muted-foreground text-xs">
									{tShare("takeBackBlocked")}
								</p>
							) : null}
						</div>
					) : null}
					<Button
						autoLoading={false}
						onClick={() => onDisconnect(account)}
						size="sm"
						type="button"
						variant="outline"
					>
						{t("disconnect")}
					</Button>
				</div>
			</div>
			<div className="space-y-2">
				{account.usageEstimate.weeklyLimitOnly ? (
					<p className="text-sm">{tPlan("weeklyLimitOnly")}</p>
				) : (
					<>
						<p className="text-sm">
							{t("usageEstimate", {
								percent,
								hours: account.usageEstimate.windowHours,
							})}
						</p>
						<Progress
							aria-hidden="true"
							className="h-2"
							value={percent}
						/>
					</>
				)}
				<PlanWindowDetails estimate={account.usageEstimate} />
			</div>
			<div className="space-y-3">
				<PlanType
					account={account}
					disabled={update.isPending}
					onChange={(tier) =>
						update.mutate({ accountId: account.id, tier })
					}
				/>
				{toggle("enabled", t("enabled"))}
				{toggle("serveInteractive", t("serveInteractive"))}
				{toggle("serveBackground", t("serveBackground"))}
				{account.serveInteractive && (
					<MemberShare
						account={account}
						disabled={update.isPending}
						onChange={(maxMemberSharePct) =>
							update.mutate({
								accountId: account.id,
								maxMemberSharePct,
							})
						}
					/>
				)}
			</div>
		</li>
	);
}

/**
 * The account's ChatGPT plan, set by an admin (Fizzy #2770): OpenAI's sign-in
 * does not report it, and it sizes the usage estimate. Optional: "Not set"
 * is the default and can be chosen again.
 */
function PlanType({
	account,
	disabled,
	onChange,
}: {
	account: ChatgptPlanPoolAccount;
	disabled: boolean;
	onChange: (tier: PlanTier) => void;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	const tTier = useTranslations("settings.chatgptPlan.subscription.tier");
	const id = `chatgpt-plan-pool-${account.id}-plan-type`;
	return (
		<div className="flex items-center justify-between gap-4">
			<div className="space-y-1">
				<Label htmlFor={id}>{t("planType")}</Label>
				<p className="text-muted-foreground text-xs">
					{t("planTypeDescription")}
				</p>
			</div>
			<Select
				disabled={disabled}
				onValueChange={(value) => {
					if (isPlanTier(value)) {
						onChange(value);
					}
				}}
				value={account.tier}
			>
				<SelectTrigger
					aria-label={t("switchLabel", {
						setting: t("planType"),
						account: account.label,
					})}
					className="w-32"
					id={id}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{PLAN_TIER_OPTIONS.map((option) => (
						<SelectItem key={option} value={option}>
							{option === "UNKNOWN"
								? t("planTypeNotSet")
								: tTier(option)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * Fair share (Fizzy #2770 D6): the most of the account's window one member's
 * own work may use before it goes to the organization's other accounts.
 */
function MemberShare({
	account,
	disabled,
	onChange,
}: {
	account: ChatgptPlanPoolAccount;
	disabled: boolean;
	onChange: (maxMemberSharePct: number | null) => void;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	const id = `chatgpt-plan-pool-${account.id}-member-share`;
	const current = account.maxMemberSharePct;
	const options =
		current === null || MEMBER_SHARE_OPTIONS.includes(current)
			? MEMBER_SHARE_OPTIONS
			: [...MEMBER_SHARE_OPTIONS, current].sort((a, b) => a - b);
	return (
		<div className="flex items-center justify-between gap-4">
			<div className="space-y-1">
				<Label htmlFor={id}>{t("memberShare")}</Label>
				<p className="text-muted-foreground text-xs">
					{t("memberShareDescription")}
				</p>
			</div>
			<Select
				disabled={disabled}
				onValueChange={(value) =>
					onChange(value === "none" ? null : Number(value))
				}
				value={current === null ? "none" : String(current)}
			>
				<SelectTrigger
					aria-label={t("switchLabel", {
						setting: t("memberShare"),
						account: account.label,
					})}
					className="w-32"
					id={id}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="none">{t("memberShareNone")}</SelectItem>
					{options.map((pct) => (
						<SelectItem key={pct} value={String(pct)}>
							{t("memberSharePercent", { percent: pct })}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * The organization's shared ChatGPT plan accounts (Fizzy #2770): each one's
 * status, an estimate of its five-hour window, and which work it serves.
 */
export function OrgChatgptPlanAccountsCard({
	accounts,
	organizationSlug,
	viewerHasOwnPlan = false,
}: {
	accounts: ChatgptPlanPoolAccount[];
	organizationSlug: string;
	/** A connector with an own plan must disconnect it first (Fizzy #2770 I1). */
	viewerHasOwnPlan?: boolean;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	const tShare = useTranslations("settings.chatgptPlan.share");
	const [confirming, setConfirming] = useState<ChatgptPlanPoolAccount | null>(
		null,
	);
	// Only the member who connected an account sees this (Fizzy #2770 I1).
	const [takingBack, setTakingBack] = useState<ChatgptPlanPoolAccount | null>(
		null,
	);
	const takeBack = useTakeBackChatgptPlan({
		onSuccess: () => {
			setTakingBack(null);
			toast.success(tShare("takenBack"));
		},
		onError: (error) =>
			toast.error(
				error instanceof Error && error.message
					? error.message
					: tShare("takeBackFailed"),
			),
	});
	const disconnect = useDisconnectChatgptPlanPoolAccount({
		onSuccess: () => {
			setConfirming(null);
			toast.success(t("disconnected"));
		},
		onError: () => toast.error(t("disconnectFailed")),
	});

	return (
		<Card
			className="space-y-4 p-4"
			data-testid="chatgpt-plan-pool-accounts"
		>
			<div className="space-y-1">
				<h3 className="font-medium text-base">{t("accountsTitle")}</h3>
				<p className="text-muted-foreground text-sm">
					{t("accountsDescription")}
				</p>
			</div>

			{accounts.length === 0 ? (
				<div className="space-y-3">
					<p className="text-sm">{t("emptyAccounts")}</p>
					<ChatgptConnectCommand
						sharedOrganizationSlug={organizationSlug}
					/>
				</div>
			) : (
				<>
					<ul className="space-y-4">
						{accounts.map((account) => (
							<AccountRow
								account={account}
								key={account.id}
								onDisconnect={setConfirming}
								onTakeBack={setTakingBack}
								takeBackBlocked={viewerHasOwnPlan}
							/>
						))}
					</ul>
					<div className="space-y-2 border-border border-t pt-4">
						<p className="text-muted-foreground text-sm">
							{t("connectAnother")}
						</p>
						<ChatgptConnectCommand
							sharedOrganizationSlug={organizationSlug}
						/>
					</div>
				</>
			)}

			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setConfirming(null);
					}
				}}
				open={confirming !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("disconnectConfirmTitle")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("disconnectConfirmDescription", {
								label: confirming?.label ?? "",
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={disconnect.isPending}>
							{t("cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={disconnect.isPending}
							onClick={(event) => {
								// Stays open while the request is in flight; the
								// mutation closes it on success.
								event.preventDefault();
								if (confirming) {
									disconnect.mutate(confirming.id);
								}
							}}
							variant="destructive"
						>
							{disconnect.isPending
								? t("disconnecting")
								: t("disconnect")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setTakingBack(null);
					}
				}}
				open={takingBack !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{tShare("takeBackConfirmTitle", {
								account: takingBack?.label ?? "",
							})}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("takeBackConfirmBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={takeBack.isPending}>
							{t("cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={takeBack.isPending}
							onClick={(event) => {
								event.preventDefault();
								if (takingBack) {
									takeBack.mutate(takingBack.id);
								}
							}}
						>
							{t("takeBack")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}
