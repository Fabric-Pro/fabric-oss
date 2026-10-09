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
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChatgptPlanSubscription } from "./ChatgptPlanSubscription";
import {
	useShareChatgptPlan,
	useTakeBackChatgptPlan,
} from "./chatgpt-plan-status";

/** The server's own sentence says what to do; the fallback only names the failure. */
function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Turns the member's own plan into one of the organization's shared accounts,
 * without a new sign-in (Fizzy #2770 I1). Shown only when the server says the
 * organization takes shared plans from its members.
 */
export function ChatgptPlanShareAction({
	organizationName,
}: {
	organizationName: string;
}) {
	const t = useTranslations("settings.chatgptPlan.share");
	const tPlan = useTranslations("settings.chatgptPlan");
	const [open, setOpen] = useState(false);
	const share = useShareChatgptPlan({
		onSuccess: () => {
			setOpen(false);
			toast.success(t("shared", { organization: organizationName }));
		},
		onError: (error) => toast.error(errorMessage(error, t("failed"))),
	});
	return (
		<div
			className="flex flex-col gap-3 border-border border-t pt-4 sm:flex-row sm:items-center sm:justify-between"
			data-testid="chatgpt-plan-share"
		>
			<p className="text-muted-foreground text-sm">
				{t("description", { organization: organizationName })}
			</p>
			<Button
				autoLoading={false}
				onClick={() => setOpen(true)}
				size="sm"
				type="button"
				variant="outline"
			>
				{t("action", { organization: organizationName })}
			</Button>
			<AlertDialog onOpenChange={setOpen} open={open}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("confirmTitle", {
								organization: organizationName,
							})}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("confirmBody", {
								organization: organizationName,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={share.isPending}>
							{tPlan("cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={share.isPending}
							onClick={(event) => {
								// Stays open until the move is done.
								event.preventDefault();
								share.mutate(undefined);
							}}
						>
							{t("confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

export interface ChatgptPlanSharedAccount {
	accountId: string;
	label: string;
	maskedEmail: string | null;
	status: "ACTIVE" | "NEEDS_RECONNECT";
	tier: "UNKNOWN" | "PLUS" | "PRO" | "FREE" | "TEAM";
	enabled: boolean;
}

/**
 * The shared accounts in this organization the member connected: read-only
 * here — its admins manage them — with the take-back only they may use.
 */
export function ChatgptPlanSharedHere({
	accounts,
	organizationName,
	hasOwnPlan,
}: {
	accounts: ChatgptPlanSharedAccount[];
	organizationName: string;
	hasOwnPlan: boolean;
}) {
	const t = useTranslations("settings.chatgptPlan.share");
	const tPlan = useTranslations("settings.chatgptPlan");
	const [pending, setPending] = useState<ChatgptPlanSharedAccount | null>(
		null,
	);
	const takeBack = useTakeBackChatgptPlan({
		onSuccess: () => {
			setPending(null);
			toast.success(t("takenBack"));
		},
		onError: (error) =>
			toast.error(errorMessage(error, t("takeBackFailed"))),
	});
	if (accounts.length === 0) {
		return null;
	}
	return (
		<Card className="space-y-4 p-4" data-testid="chatgpt-plan-shared-here">
			<div className="space-y-1">
				<p className="font-medium text-sm">
					{t("sharedWithTitle", { organization: organizationName })}
				</p>
				<p className="text-muted-foreground text-sm">
					{t("sharedWithNote", { organization: organizationName })}
				</p>
			</div>
			<ul className="space-y-3">
				{accounts.map((account) => (
					<li
						className="flex flex-col gap-3 border-border border-t pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between"
						key={account.accountId}
					>
						<div className="min-w-0 space-y-1 text-sm">
							<p className="truncate font-medium">
								{account.label}
							</p>
							{account.maskedEmail ? (
								<p className="truncate text-muted-foreground">
									{account.maskedEmail}
								</p>
							) : null}
							<Badge
								status={
									account.status === "NEEDS_RECONNECT"
										? "warning"
										: "success"
								}
							>
								{account.status === "NEEDS_RECONNECT"
									? tPlan("statusNeedsReconnect")
									: tPlan("statusActive")}
							</Badge>
							<ChatgptPlanSubscription
								subscriptionActiveUntil={null}
								tier={account.tier}
							/>
						</div>
						<div className="space-y-1 sm:text-right">
							<Button
								autoLoading={false}
								disabled={hasOwnPlan}
								onClick={() => setPending(account)}
								size="sm"
								type="button"
								variant="outline"
							>
								{t("takeBack")}
							</Button>
							{hasOwnPlan ? (
								<p className="text-muted-foreground text-xs">
									{t("takeBackBlocked")}
								</p>
							) : null}
						</div>
					</li>
				))}
			</ul>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setPending(null);
					}
				}}
				open={pending !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("takeBackConfirmTitle", {
								account: pending?.label ?? "",
							})}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("takeBackConfirmBody", {
								organization: organizationName,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={takeBack.isPending}>
							{tPlan("cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={takeBack.isPending}
							onClick={(event) => {
								event.preventDefault();
								if (pending) {
									takeBack.mutate(pending.accountId);
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
