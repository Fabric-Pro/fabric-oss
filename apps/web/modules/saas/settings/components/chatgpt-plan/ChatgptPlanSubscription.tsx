"use client";

import { Badge } from "@ui/components/badge";
import { useTranslations } from "next-intl";

export type ChatgptPlanTier = "UNKNOWN" | "PLUS" | "PRO" | "FREE" | "TEAM";

/** Within this long of running out, a subscription is called out. */
const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60_000;

function day(date: Date | string): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		new Date(date),
	);
}

/**
 * A ChatGPT plan's subscription as its sign-in reports it (Fizzy #2770 G7):
 * the tier, when it is paid until, and warnings for a Free plan and for a
 * subscription that runs out within three days or already has.
 */
export function ChatgptPlanSubscription({
	tier,
	subscriptionActiveUntil,
	now = Date.now(),
}: {
	tier: ChatgptPlanTier | null;
	subscriptionActiveUntil: Date | string | null;
	now?: number;
}) {
	const t = useTranslations("settings.chatgptPlan.subscription");
	const until = subscriptionActiveUntil
		? new Date(subscriptionActiveUntil).getTime()
		: null;
	const expired = until !== null && until <= now;
	const expiring =
		until !== null && !expired && until - now <= EXPIRY_WARNING_MS;
	return (
		<div className="space-y-1" data-testid="chatgpt-plan-subscription">
			<div className="flex flex-wrap items-center gap-2">
				{tier && tier !== "UNKNOWN" ? (
					<Badge status={tier === "FREE" ? "warning" : "info"}>
						{t(`tier.${tier}`)}
					</Badge>
				) : null}
				{tier === "FREE" ? (
					<Badge status="warning">{t("freeWarning")}</Badge>
				) : null}
			</div>
			{subscriptionActiveUntil ? (
				<p
					className={
						expired || expiring
							? "text-highlight text-xs"
							: "text-muted-foreground text-xs"
					}
				>
					{expired
						? t("expired", { date: day(subscriptionActiveUntil) })
						: expiring
							? t("expiring", {
									date: day(subscriptionActiveUntil),
								})
							: t("paidUntil", {
									date: day(subscriptionActiveUntil),
								})}
				</p>
			) : null}
		</div>
	);
}
