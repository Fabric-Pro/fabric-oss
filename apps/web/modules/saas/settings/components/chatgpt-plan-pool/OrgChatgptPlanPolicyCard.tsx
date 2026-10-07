"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
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
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	type ChatgptPlanPool,
	useAcknowledgeChatgptPlanPoolTerms,
	useUpdateChatgptPlanPoolPolicy,
} from "./chatgpt-plan-pool-queries";

const HEADROOM_CHOICES = [0, 20, 40, 60, 80] as const;

/**
 * How the organization pools its shared ChatGPT plan accounts (Fizzy #2770).
 * Pooling stays off until an organization owner has accepted the terms;
 * admins see why the switch is unavailable.
 */
export function OrgChatgptPlanPolicyCard({
	policy,
	isOwner,
}: {
	policy: ChatgptPlanPool["policy"];
	isOwner: boolean;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	const update = useUpdateChatgptPlanPoolPolicy({
		onSuccess: () => toast.success(t("policyUpdated")),
		onError: () => toast.error(t("updateFailed")),
	});
	const acknowledge = useAcknowledgeChatgptPlanPoolTerms({
		onSuccess: () => toast.success(t("termsAccepted")),
		onError: () => toast.error(t("updateFailed")),
	});

	return (
		<Card className="space-y-4 p-4" data-testid="chatgpt-plan-pool-policy">
			<div className="space-y-1">
				<h3 className="font-medium text-base">{t("policyTitle")}</h3>
				<p className="text-muted-foreground text-sm">
					{t("policyDescription")}
				</p>
			</div>

			<div className="space-y-3 rounded-md border border-border p-3">
				<p className="font-medium text-sm">{t("termsTitle")}</p>
				<p className="text-muted-foreground text-sm">
					{t("termsBody")}
				</p>
				{policy.termsAcknowledged && policy.termsAcknowledgedAt ? (
					<p
						className="text-sm"
						data-testid="chatgpt-plan-pool-terms-accepted"
					>
						{t("termsAcceptedOn", {
							date: new Intl.DateTimeFormat(undefined, {
								dateStyle: "medium",
							}).format(new Date(policy.termsAcknowledgedAt)),
						})}
					</p>
				) : isOwner ? (
					<Button
						autoLoading={false}
						disabled={acknowledge.isPending}
						onClick={() => acknowledge.mutate(undefined)}
						size="sm"
						type="button"
					>
						{t("acceptTerms")}
					</Button>
				) : (
					<p
						className="text-sm"
						data-testid="chatgpt-plan-pool-owner-only"
					>
						{t("ownerOnly")}
					</p>
				)}
			</div>

			<div className="flex items-center justify-between gap-4">
				<div className="space-y-1">
					<Label htmlFor="chatgpt-plan-pool-enabled">
						{t("poolingEnabled")}
					</Label>
					<p className="text-muted-foreground text-sm">
						{policy.termsAcknowledged
							? t("poolingEnabledHelp")
							: t("poolingNeedsTerms")}
					</p>
				</div>
				<Switch
					checked={policy.poolingEnabled}
					disabled={!policy.termsAcknowledged || update.isPending}
					id="chatgpt-plan-pool-enabled"
					onCheckedChange={(checked) =>
						update.mutate({ poolingEnabled: checked })
					}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="chatgpt-plan-pool-background">
					{t("backgroundFallback")}
				</Label>
				<Select
					disabled={update.isPending}
					onValueChange={(value) =>
						update.mutate({
							apiFallbackBackground: value as "NEVER" | "AUTO",
						})
					}
					value={policy.apiFallbackBackground}
				>
					<SelectTrigger id="chatgpt-plan-pool-background">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="NEVER">
							{t("backgroundNever")}
						</SelectItem>
						<SelectItem value="AUTO">
							{t("backgroundAuto")}
						</SelectItem>
					</SelectContent>
				</Select>
				{policy.apiFallbackBackground === "AUTO" ? (
					<Alert
						data-testid="chatgpt-plan-pool-auto-warning"
						variant="warning"
					>
						<AlertTitle>
							{t("backgroundAutoWarningTitle")}
						</AlertTitle>
						<AlertDescription>
							{t("backgroundAutoWarning")}
						</AlertDescription>
					</Alert>
				) : null}
			</div>

			<div className="space-y-2">
				<Label htmlFor="chatgpt-plan-pool-headroom">
					{t("headroom")}
				</Label>
				<Select
					disabled={update.isPending}
					onValueChange={(value) =>
						update.mutate({ headroomPct: Number(value) })
					}
					value={String(policy.headroomPct)}
				>
					<SelectTrigger id="chatgpt-plan-pool-headroom">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{[
							...new Set<number>([
								...HEADROOM_CHOICES,
								policy.headroomPct,
							]),
						]
							.sort((a, b) => a - b)
							.map((percent) => (
								<SelectItem
									key={percent}
									value={String(percent)}
								>
									{t("headroomChoice", { percent })}
								</SelectItem>
							))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-sm">
					{t("headroomHelp")}
				</p>
			</div>
		</Card>
	);
}
