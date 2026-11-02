"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { orpcClient } from "@shared/lib/orpc-client";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { StreamModelInfo } from "../../../hooks/useDirectStream";
import type { SelectedAgent } from "./agent-selection";

export function chatModelQueryOptions(organizationId?: string | null) {
	return queryOptions({
		queryKey: ["ai-models-available", organizationId, "compose-picker"],
		queryFn: () =>
			orpcClient.aiConfig.models.listAvailable({
				organizationId: organizationId ?? null,
				taskType: "CHAT",
				// Advisor and Nexus run tool calling; use that task's plan model.
				planTaskType: "TOOL_CALLING",
			}),
		refetchOnWindowFocus: false,
	});
}

/**
 * Whether another model answered a provider-model pick (a ChatGPT plan or a
 * fallback served it): the served model's canonical name, or its id when it
 * has none, is not the pick's.
 */
export function isProviderPickNotApplied(
	agentId: string,
	served: StreamModelInfo | undefined,
): boolean {
	return (
		served !== undefined &&
		agentId.startsWith("model:") &&
		(served.canonicalName ?? served.id) !== agentId.slice("model:".length)
	);
}

function inactiveProviderPickNote(
	name: string,
	source: "own" | "shared",
	canManagePlan: boolean,
) {
	return `${source === "shared" ? "Your organization's shared" : "Your"} ChatGPT plan is on — ${source === "shared" && !canManagePlan ? "ask an organization admin to turn it off" : "turn it off"} to use ${name}.`;
}

export function useProviderPickStatus(
	organizationId: string | null | undefined,
	selectedAgents: readonly SelectedAgent[],
) {
	const {
		activeOrganization,
		isOrganizationAdmin,
		activeOrganizationUserRole,
	} = useActiveOrganization();
	const providerPicks = selectedAgents.filter((agent) =>
		agent.agentId.startsWith("model:"),
	);
	const { data, isSuccess } = useQuery({
		...chatModelQueryOptions(organizationId),
		enabled: providerPicks.length > 0,
		// Plan controls open in another tab; refresh when the member returns.
		refetchOnWindowFocus: true,
	});
	// The server accounts for spent plans and billing fallbacks in this field.
	// Keep the last listing through a background refetch so the status holds.
	const source = isSuccess ? data.chatgptPlan?.source : undefined;
	const isUnavailable = (agent: SelectedAgent) =>
		isSuccess &&
		!data.models.some(
			(model) =>
				model.canonicalName === agent.agentId.slice("model:".length),
		);
	// Shared-plan settings require an admin/owner membership, even for platform admins.
	const canManagePlan =
		source === "own" ||
		(source === "shared" &&
			activeOrganization?.id === organizationId &&
			isOrganizationAdmin &&
			(activeOrganizationUserRole === "admin" ||
				activeOrganizationUserRole === "owner"));
	return {
		source,
		canManagePlan,
		inactiveProviderPicks: providerPicks.filter(
			(agent) => source || isUnavailable(agent),
		),
		getInactiveNote: (agent: SelectedAgent | null | undefined) =>
			agent?.agentId.startsWith("model:")
				? source
					? inactiveProviderPickNote(
							agent.name,
							source,
							canManagePlan,
						)
					: isUnavailable(agent)
						? `${agent.name} isn't available from your organization's AI provider — pick another model.`
						: undefined
				: undefined,
	};
}
