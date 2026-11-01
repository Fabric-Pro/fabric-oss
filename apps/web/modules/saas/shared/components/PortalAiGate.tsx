"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	useChatgptPlanServesOwnWork,
	useChatgptPlanStatusKnown,
	useSharedChatgptPlanServesOwnWork,
} from "@saas/settings/components/chatgpt-plan/chatgpt-plan-status";
import { useTenantScopeResolved } from "@saas/shared/lib/use-tenant-scope-resolved";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { aiConfigStatusQueryKey } from "./AiGatewayWarningBanner";

/** Mount a Portal AI runtime only after setup is known. Surrounding project
 * actions, including delegation to independently authenticated servers, stay mounted.
 * Guests cannot inspect organization configuration; retain their existing runtime path.
 */
export function PortalAiGate({
	children,
	fallback,
}: {
	children: ReactNode;
	fallback: ReactNode;
}) {
	const t = useTranslations("common");
	const { organizationId } = useOrganizationContext();
	const scopeResolved = useTenantScopeResolved();
	const guest = useIsGuestInOrg();
	const planKnown = useChatgptPlanStatusKnown();
	const ownPlan = useChatgptPlanServesOwnWork();
	const sharedPlan = useSharedChatgptPlanServesOwnWork();
	const status = useQuery({
		queryKey: aiConfigStatusQueryKey(organizationId),
		queryFn: () =>
			orpcClient.aiConfig.resolution.getStatus({ organizationId }),
		enabled: !guest && scopeResolved,
	});
	if (guest) {
		return children;
	}
	if (!scopeResolved || !planKnown || status.isPending) {
		return (
			<output aria-label={t("loading")} aria-busy="true">
				<Skeleton className="h-24 w-full" />
			</output>
		);
	}
	if (status.data?.canResolveProvider === false && !ownPlan && !sharedPlan) {
		return fallback;
	}
	// A failed configuration read is unknown, rather than proof of missing setup.
	return children;
}
