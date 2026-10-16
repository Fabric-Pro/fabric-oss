"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import {
	useChatgptPlanServesOwnWork,
	useChatgptPlanStatusKnown,
	useSharedChatgptPlanServesOwnWork,
} from "@saas/settings/components/chatgpt-plan/chatgpt-plan-status";
import { getProviderDisplayName } from "@saas/settings/lib/ai-providers";
import { PERSONAL_AI_PROVIDERS_PATH } from "@saas/settings/lib/personal-ai-providers-path";
import { useTenantScopeResolved } from "@saas/shared/lib/use-tenant-scope-resolved";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { KeyRoundIcon, SettingsIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { aiConfigStatusQueryKey } from "./AiGatewayWarningBanner";
import { CollapsedNotice, useNoticeDismissal } from "./ai-notice-dismissal";

/**
 * The notice shown when, inside an organization, the caller's chat and
 * generation run on THEIR OWN personal provider key (Fizzy #3082).
 *
 * The resolver falls back to the member's personal default when the
 * organization has no usable provider of its own. That keeps AI working, and
 * it also bills the member's own account for work done for the organization —
 * which nobody had told them. This says so, once per organization, and points
 * at the keys involved.
 *
 * It shares the AI-setup reminder's mount, query and guards:
 *
 * 1. A project guest holds no organization membership, so the status call
 *    would 403; a guest is never asked about, or told about, the host's setup.
 * 2. Nothing is asked or shown until the URL's organization has resolved —
 *    a null organization id reads as personal to the procedure.
 * 3. It never shows beside "AI provider required": that one needs
 *    `canResolveProvider` false, this one needs it true.
 *
 * And one guard of its own: a ChatGPT plan — the member's own or one the
 * organization shares — is consulted before any key, so while one serves the
 * member's own work, their key is not what runs and nothing is billed to it.
 */
export function PersonalKeyNotice() {
	const t = useTranslations("settings.aiProviders.personalKeyNotice");
	const { organizationId, isOrgContext, isOrganizationAdmin } =
		useOrganizationContext();
	const tenantScopeResolved = useTenantScopeResolved();
	const isGuest = useIsGuestInOrg();
	const personalSettingsPath = useContextPath(PERSONAL_AI_PROVIDERS_PATH);
	const organizationSettingsPath = useContextPath("settings/ai-providers");
	// Until the plan status is in for THIS organization — still loading, or
	// the session still on the previous one after a switch — both plan hooks
	// answer false, which would show "billed to you" to someone whose work
	// here runs on a plan. Wait for the answer.
	const planStatusKnown = useChatgptPlanStatusKnown();
	const ownWorkOnOwnPlan = useChatgptPlanServesOwnWork();
	const ownWorkOnSharedPlan = useSharedChatgptPlanServesOwnWork();
	const { dismissed, dismiss, restore } = useNoticeDismissal(
		`personal-key:${organizationId ?? "personal"}`,
	);

	// The sibling reminder's query, by its key: one request serves both.
	const { data: configStatus, isLoading } = useQuery({
		queryKey: aiConfigStatusQueryKey(organizationId),
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			});
		},
		enabled: !isGuest && tenantScopeResolved,
	});

	if (
		isGuest ||
		!tenantScopeResolved ||
		!isOrgContext ||
		isLoading ||
		!planStatusKnown ||
		dismissed === undefined
	) {
		return null;
	}

	if (
		configStatus?.canResolveProvider !== true ||
		configStatus.resolvedProviderSource !== "user" ||
		!configStatus.resolvedProvider ||
		ownWorkOnOwnPlan ||
		ownWorkOnSharedPlan
	) {
		return null;
	}

	if (dismissed) {
		return <CollapsedNotice label={t("show")} onOpen={restore} />;
	}

	return (
		<div className="pointer-events-auto w-full max-w-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
			<Alert
				aria-label={t("label")}
				className="flex w-full flex-col gap-3 border-highlight/40 bg-card text-highlight-ink shadow-lg"
			>
				<div className="flex items-start gap-3">
					<KeyRoundIcon
						className="mt-0.5 size-4 shrink-0 text-highlight"
						aria-hidden="true"
					/>
					<div className="min-w-0 flex-1">
						<AlertTitle>{t("title")}</AlertTitle>
						<AlertDescription>
							{t("body", {
								provider: getProviderDisplayName(
									configStatus.resolvedProvider,
								),
							})}
						</AlertDescription>
					</div>
					<Button
						variant="ghost"
						size="icon"
						className="-mt-1.5 -mr-1.5 size-8 shrink-0"
						onClick={dismiss}
						aria-label={t("dismiss")}
					>
						<XIcon className="size-4" />
					</Button>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-2">
					<Button asChild size="sm" variant="outline">
						<Link href={personalSettingsPath}>
							<KeyRoundIcon className="size-4" />
							{t("manage")}
						</Link>
					</Button>
					{/* Only an admin can give the organization a provider of
					 * its own; for anyone else that page is read-only. */}
					{isOrganizationAdmin ? (
						<Button asChild size="sm" variant="outline">
							<Link href={organizationSettingsPath}>
								<SettingsIcon className="size-4" />
								{t("configure")}
							</Link>
						</Button>
					) : null}
				</div>
			</Alert>
		</div>
	);
}
