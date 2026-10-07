"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { isFullBleedRoute } from "@saas/shared/lib/shell-layout";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChatgptConnectCommand } from "./ChatgptConnectCommand";
import {
	useChatgptPlanStatus,
	useSetChatgptPlanOrganizationUse,
} from "./chatgpt-plan-status";

/**
 * The two ways out when a member's plan is on here but its sign-in must be
 * renewed: reconnect, or explicitly switch this organization back to its own
 * API billing. Fabric never makes the second choice for them.
 */
export function ChatgptPlanReconnectActions({
	showSettingsLink = true,
}: {
	showSettingsLink?: boolean;
}) {
	const t = useTranslations("settings.chatgptPlan");
	const { activeOrganization } = useActiveOrganization();
	const useOrganizationBilling = useSetChatgptPlanOrganizationUse({
		onSuccess: () => toast.success(t("usingOrganizationBilling")),
		onError: () => toast.error(t("updateFailed")),
	});

	return (
		<div className="space-y-3" data-testid="chatgpt-plan-reconnect-actions">
			<p className="text-sm">{t("reconnectCommandHint")}</p>
			<ChatgptConnectCommand />
			<div className="flex flex-wrap items-center gap-2">
				<Button
					autoLoading={false}
					disabled={useOrganizationBilling.isPending}
					onClick={() => useOrganizationBilling.mutate(false)}
					size="sm"
					type="button"
					variant="outline"
				>
					{t("useOrganizationBilling")}
				</Button>
				{showSettingsLink && activeOrganization?.slug ? (
					<Button asChild size="sm" variant="link">
						<Link
							href={`/app/${activeOrganization.slug}/settings/account/ai-providers`}
						>
							{t("openSettings")}
						</Link>
					</Button>
				) : null}
			</div>
		</div>
	);
}

/**
 * Shown on every page while the member's plan is on in this organization but
 * needs reconnecting — persistent, unlike the one-time prompt, because every
 * AI call they make here is refused until they choose.
 */
export function useChatgptPlanReconnectNoticeVisible(): boolean {
	const { query, currentOrganization } = useChatgptPlanStatus();
	return (
		query.data?.connected === true &&
		query.data.status === "NEEDS_RECONNECT" &&
		currentOrganization?.enabled === true
	);
}

export function ChatgptPlanReconnectNotice() {
	const t = useTranslations("settings.chatgptPlan");
	if (!useChatgptPlanReconnectNoticeVisible()) {
		return null;
	}
	return (
		<Alert
			className="mx-auto w-full max-w-5xl"
			data-testid="chatgpt-plan-reconnect-notice"
			variant="warning"
		>
			<AlertTitle>{t("reconnectTitle")}</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>{t("reconnectDescription")}</p>
				<ChatgptPlanReconnectActions />
			</AlertDescription>
		</Alert>
	);
}

/**
 * The same notice for the full-bleed pages (a feature, a document, the agent
 * workspaces), where the in-flow shell notices yield to the page's own
 * chrome. It floats in the chrome's bottom-right dock instead, beside the
 * other AI notices, so the two ways out are reachable on every page.
 */
export function ChatgptPlanReconnectDockNotice() {
	const t = useTranslations("settings.chatgptPlan");
	const pathname = usePathname();
	const visible = useChatgptPlanReconnectNoticeVisible();
	if (!visible || !isFullBleedRoute(pathname)) {
		return null;
	}
	return (
		<div className="pointer-events-auto w-full max-w-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
			<Alert
				className="w-full bg-card shadow-lg"
				data-testid="chatgpt-plan-reconnect-dock-notice"
				variant="warning"
			>
				<AlertTitle>{t("reconnectTitle")}</AlertTitle>
				<AlertDescription className="space-y-3">
					<p>{t("reconnectDescription")}</p>
					<ChatgptPlanReconnectActions />
				</AlertDescription>
			</Alert>
		</div>
	);
}
