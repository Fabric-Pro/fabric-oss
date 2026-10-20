"use client";

import { useAiServesMemberHere } from "@saas/shared/lib/use-ai-serves-member-here";
import { AiProvidersSettingsForm } from "../AiProvidersSettingsForm";
import { useChatgptPlanStatus } from "./chatgpt-plan-status";

/**
 * The organization on screen, when the member's own ChatGPT plan serves
 * their own work there: connected, signed in, and turned on here.
 */
function useChatgptPlanServesOwnWorkIn(): string | null {
	const { query, currentOrganization } = useChatgptPlanStatus();
	return query.data?.connected === true &&
		query.data.status === "ACTIVE" &&
		currentOrganization?.enabled === true
		? currentOrganization.name
		: null;
}

/**
 * The account AI Providers form, told whether the member's ChatGPT plan
 * serves their own work here, so its status banner counts the plan too, and
 * whether the organization already serves it, so a member without keys of
 * their own is not told that nothing is configured.
 */
export function AccountAiProvidersSettings() {
	const organizationName = useChatgptPlanServesOwnWorkIn();
	// Read only when the member has no personal key, so a key that serves
	// them is the organization's. Their own plan is told apart: the form
	// has its own notice for it.
	const serving = useAiServesMemberHere();
	const organizationServesWork =
		serving === null ? null : serving.providerKey || serving.sharedPlan;
	return (
		<AiProvidersSettingsForm
			chatgptPlan={organizationName ? { organizationName } : null}
			organizationServesWork={organizationServesWork}
		/>
	);
}
