"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
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
import { Skeleton } from "@ui/components/skeleton";
import { Switch } from "@ui/components/switch";
import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChatgptConnectCommand } from "./ChatgptConnectCommand";
import { ChatgptPlanReconnectActions } from "./ChatgptPlanReconnectActions";
import {
	useChatgptPlanStatus,
	useDisconnectChatgptPlan,
	useSetChatgptPlanBackgroundJobs,
	useSetChatgptPlanOrganizationUse,
} from "./chatgpt-plan-status";

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

function UsageMeter({
	estimate,
}: {
	estimate: { windowHours: number; estimatedPercent: number };
}) {
	const t = useTranslations("settings.chatgptPlan");
	const percent = Math.round(
		Math.min(100, Math.max(0, estimate.estimatedPercent)),
	);

	return (
		<div
			className="space-y-2 border-border border-t pt-4"
			data-testid="chatgpt-plan-usage"
		>
			<p className="text-sm">
				{t("usageEstimate", { percent, hours: estimate.windowHours })}
			</p>
			<Progress aria-hidden="true" className="h-2" value={percent} />
			<p className="text-muted-foreground text-xs">
				{t("usageEstimateNote")}{" "}
				<a
					className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
					href={CHATGPT_USAGE_URL}
					rel="noopener noreferrer"
					target="_blank"
				>
					{t("usageLink")}
					<ExternalLinkIcon aria-hidden="true" className="size-3" />
					<span className="sr-only">{t("opensInNewTab")}</span>
				</a>
			</p>
		</div>
	);
}

/**
 * The member's own ChatGPT plan, inside the account AI providers page. Renders
 * nothing, and mounts no query, unless `CHATGPT_PLAN` is on for the
 * organization on screen.
 */
export function ChatgptPlanSettings() {
	return useFeatureFlag("CHATGPT_PLAN") ? <ChatgptPlanSection /> : null;
}

function ChatgptPlanSection() {
	const t = useTranslations("settings.chatgptPlan");
	const { query, currentOrganization } = useChatgptPlanStatus();
	const [confirmOpen, setConfirmOpen] = useState(false);

	const setOrganizationUse = useSetChatgptPlanOrganizationUse({
		onSuccess: (on) => toast.success(on ? t("turnedOn") : t("turnedOff")),
		onError: () => toast.error(t("updateFailed")),
	});

	const setBackgroundJobs = useSetChatgptPlanBackgroundJobs({
		onSuccess: (on) =>
			toast.success(on ? t("backgroundJobsOn") : t("backgroundJobsOff")),
		onError: () => toast.error(t("updateFailed")),
	});

	const disconnect = useDisconnectChatgptPlan({
		onSuccess: () => {
			setConfirmOpen(false);
			toast.success(t("disconnected"));
		},
		onError: () => toast.error(t("disconnectFailed")),
	});

	return (
		<section
			aria-labelledby="chatgpt-plan-heading"
			className="mt-6 space-y-4"
			data-testid="chatgpt-plan-settings"
		>
			<div className="space-y-1">
				<h2 className="font-semibold text-lg" id="chatgpt-plan-heading">
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>

			{query.isPending ? (
				<Skeleton className="h-24 w-full" />
			) : query.isError ? (
				<Alert variant="error">
					<AlertDescription>{t("loadFailed")}</AlertDescription>
				</Alert>
			) : !query.data.connected ? (
				<Card className="space-y-3 p-4">
					<p className="font-medium text-sm">{t("notConnected")}</p>
					<p className="text-muted-foreground text-sm">
						{t("howToConnect")}
					</p>
					<ChatgptConnectCommand />
				</Card>
			) : (
				<Card className="space-y-4 p-4">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0 space-y-1 text-sm">
							<p className="text-muted-foreground">
								{t("connectedAs")}
							</p>
							<p
								className="truncate font-medium"
								data-testid="chatgpt-plan-email"
							>
								{query.data.email ?? t("unknownAccount")}
							</p>
							<Badge
								status={
									query.data.status === "NEEDS_RECONNECT"
										? "warning"
										: "success"
								}
							>
								{query.data.status === "NEEDS_RECONNECT"
									? t("statusNeedsReconnect")
									: t("statusActive")}
							</Badge>
						</div>
						<Button
							autoLoading={false}
							onClick={() => setConfirmOpen(true)}
							size="sm"
							type="button"
							variant="outline"
						>
							{t("disconnect")}
						</Button>
					</div>

					{query.data.status === "NEEDS_RECONNECT" ? (
						<Alert
							data-testid="chatgpt-plan-reconnect"
							variant="warning"
						>
							<AlertTitle>{t("reconnectTitle")}</AlertTitle>
							<AlertDescription className="space-y-3">
								<p>{t("reconnectDescription")}</p>
								<ChatgptPlanReconnectActions
									showSettingsLink={false}
								/>
							</AlertDescription>
						</Alert>
					) : null}

					{currentOrganization ? (
						<div className="flex items-center justify-between gap-4 border-border border-t pt-4">
							<div className="space-y-1">
								<Label htmlFor="chatgpt-plan-organization-use">
									{t("useInOrganization")}
								</Label>
								<p className="text-muted-foreground text-sm">
									{t("useInOrganizationHelp", {
										organization: currentOrganization.name,
									})}
								</p>
							</div>
							<Switch
								checked={currentOrganization.enabled}
								disabled={setOrganizationUse.isPending}
								id="chatgpt-plan-organization-use"
								onCheckedChange={(checked) =>
									setOrganizationUse.mutate(checked)
								}
							/>
						</div>
					) : null}

					{currentOrganization ? (
						<div
							className="space-y-3 border-border border-l-2 pl-4"
							data-testid="chatgpt-plan-background-jobs"
						>
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="chatgpt-plan-background-jobs">
									{t("includeBackgroundJobs")}
								</Label>
								<Switch
									checked={
										currentOrganization.enabled &&
										currentOrganization.includeBackgroundJobs
									}
									disabled={
										!currentOrganization.enabled ||
										setBackgroundJobs.isPending ||
										setOrganizationUse.isPending
									}
									id="chatgpt-plan-background-jobs"
									onCheckedChange={(checked) =>
										setBackgroundJobs.mutate(checked)
									}
								/>
							</div>
							<Alert variant="warning">
								<AlertTitle>
									{t("backgroundJobsWarningTitle")}
								</AlertTitle>
								<AlertDescription>
									{t("backgroundJobsWarning")}
								</AlertDescription>
							</Alert>
						</div>
					) : null}

					{query.data.usageEstimate ? (
						<UsageMeter estimate={query.data.usageEstimate} />
					) : null}
				</Card>
			)}

			<AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("disconnectConfirmTitle")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("disconnectConfirmDescription")}
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
								disconnect.mutate();
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
		</section>
	);
}
