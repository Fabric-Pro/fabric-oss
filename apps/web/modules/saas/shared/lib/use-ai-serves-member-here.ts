"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	useChatgptPlanServesOwnWork,
	useChatgptPlanStatusKnown,
	useSharedChatgptPlanServesOwnWork,
} from "@saas/settings/components/chatgpt-plan/chatgpt-plan-status";
import { aiConfigStatusQueryKey } from "@saas/shared/components/AiGatewayWarningBanner";
import { useTenantScopeResolved } from "@saas/shared/lib/use-tenant-scope-resolved";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";

/** What serves the member's chat and generation here, each answered on its own. */
export interface AiServingMember {
	/** A provider key the resolver lands on for them, organization's or own. */
	providerKey: boolean;
	/** Their own ChatGPT plan, turned on in this organization. */
	ownPlan: boolean;
	/** A ChatGPT account the organization shares with members. */
	sharedPlan: boolean;
}

/**
 * What serves the member's chat and generation in the
 * organization on screen (Fizzy #3087): a provider key the server's resolver
 * lands on for them — the organization's default or, failing that, their own
 * personal default, never an "Embeddings only" key — or a ChatGPT plan, their
 * own or one the organization shares, which runs before any key.
 *
 * The key half is the status procedure's `canResolveProvider`, so the rules
 * live on the server; the plan half is the plan status the chrome notices
 * read. Shares their status query by key.
 *
 * Null while either answer is still out for this organization — including
 * right after a switch, while the session still names the previous one — and
 * for a project guest, who is never asked about the host's setup. Callers
 * treat null as "do not warn yet", never as "nothing serves you".
 */
export function useAiServesMemberHere({
	enabled = true,
}: {
	enabled?: boolean;
} = {}): AiServingMember | null {
	const { organizationId } = useOrganizationContext();
	const tenantScopeResolved = useTenantScopeResolved();
	const isGuest = useIsGuestInOrg();
	const planStatusKnown = useChatgptPlanStatusKnown();
	const ownPlanServes = useChatgptPlanServesOwnWork();
	const sharedPlanServes = useSharedChatgptPlanServesOwnWork();
	const asked = enabled && !isGuest && tenantScopeResolved;
	const { data } = useQuery({
		queryKey: aiConfigStatusQueryKey(organizationId),
		queryFn: () =>
			orpcClient.aiConfig.resolution.getStatus({ organizationId }),
		enabled: asked,
		staleTime: 30_000,
	});

	if (!asked || !planStatusKnown || data === undefined) {
		return null;
	}
	return {
		providerKey: data.canResolveProvider,
		ownPlan: ownPlanServes,
		sharedPlan: sharedPlanServes,
	};
}

/** True when anything at all serves the member here; null while unknown. */
export function servesAnything(
	serving: AiServingMember | null,
): boolean | null {
	return serving === null
		? null
		: serving.providerKey || serving.ownPlan || serving.sharedPlan;
}
