"use client";

import { isFullBleedRoute } from "@saas/shared/lib/shell-layout";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useChatgptPlanStatus } from "./chatgpt-plan-status";

/**
 * Whether the member's own plan window is spent here and the organization's
 * shared plan is serving their work until it resets (Fizzy #2770). A warning,
 * not a block: their work carries on.
 */
export function useChatgptPlanSharedFallbackVisible(): boolean {
	const { query, currentOrganization } = useChatgptPlanStatus();
	return (
		currentOrganization?.enabled === true &&
		query.data?.ownPlanSpent?.servedBySharedPlan === true
	);
}

function SharedFallbackAlert({
	className,
	testId,
}: {
	className: string;
	testId: string;
}) {
	const t = useTranslations("settings.chatgptPlan.sharedFallback");
	const { query } = useChatgptPlanStatus();
	const resetAt = query.data?.ownPlanSpent?.resetAt ?? null;
	return (
		<Alert className={className} data-testid={testId} variant="warning">
			<AlertTitle>{t("title")}</AlertTitle>
			<AlertDescription>
				{resetAt
					? t("descriptionUntil", {
							time: new Intl.DateTimeFormat(undefined, {
								hour: "2-digit",
								minute: "2-digit",
							}).format(new Date(resetAt)),
						})
					: t("description")}
			</AlertDescription>
		</Alert>
	);
}

export function ChatgptPlanSharedFallbackNotice() {
	if (!useChatgptPlanSharedFallbackVisible()) {
		return null;
	}
	return (
		<SharedFallbackAlert
			className="mx-auto w-full max-w-5xl"
			testId="chatgpt-plan-shared-fallback-notice"
		/>
	);
}

/** The same warning on full-bleed pages, in the chrome's bottom-right dock. */
export function ChatgptPlanSharedFallbackDockNotice() {
	const pathname = usePathname();
	const visible = useChatgptPlanSharedFallbackVisible();
	if (!visible || !isFullBleedRoute(pathname)) {
		return null;
	}
	return (
		<div className="pointer-events-auto w-full max-w-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
			<SharedFallbackAlert
				className="w-full bg-card shadow-lg"
				testId="chatgpt-plan-shared-fallback-dock-notice"
			/>
		</div>
	);
}
