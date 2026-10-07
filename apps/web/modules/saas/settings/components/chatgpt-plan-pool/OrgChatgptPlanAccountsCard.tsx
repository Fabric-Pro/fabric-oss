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
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChatgptConnectCommand } from "../chatgpt-plan/ChatgptConnectCommand";
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
}: {
	account: ChatgptPlanPoolAccount;
	onDisconnect: (account: ChatgptPlanPoolAccount) => void;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
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
					<AccountStatus account={account} />
				</div>
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
			<div className="space-y-2">
				<p className="text-sm">
					{t("usageEstimate", {
						percent,
						hours: account.usageEstimate.windowHours,
					})}
				</p>
				<Progress aria-hidden="true" className="h-2" value={percent} />
			</div>
			<div className="space-y-3">
				{toggle("enabled", t("enabled"))}
				{toggle("serveInteractive", t("serveInteractive"))}
				{toggle("serveBackground", t("serveBackground"))}
			</div>
		</li>
	);
}

/**
 * The organization's shared ChatGPT plan accounts (Fizzy #2770): each one's
 * status, an estimate of its five-hour window, and which work it serves.
 */
export function OrgChatgptPlanAccountsCard({
	accounts,
	organizationSlug,
}: {
	accounts: ChatgptPlanPoolAccount[];
	organizationSlug: string;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	const [confirming, setConfirming] = useState<ChatgptPlanPoolAccount | null>(
		null,
	);
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
		</Card>
	);
}
