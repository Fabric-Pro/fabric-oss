"use client";

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
 * serves their own work here, so its status banner counts the plan too.
 */
export function AccountAiProvidersSettings() {
	const organizationName = useChatgptPlanServesOwnWorkIn();
	return (
		<AiProvidersSettingsForm
			chatgptPlan={organizationName ? { organizationName } : null}
		/>
	);
}
