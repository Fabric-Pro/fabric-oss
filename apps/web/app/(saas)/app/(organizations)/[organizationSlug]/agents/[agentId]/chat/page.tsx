import { OrganizationAgentChatView } from "@saas/agents/components/OrganizationAgentChatView";
import {
	agentChatAiConfigQueryOptions,
	registeredAgentChatQueryOptions,
} from "@saas/agents/lib/agent-chat-queries";
import { getActiveOrganization } from "@saas/auth/lib/server";
import { getServerQueryClient } from "@shared/lib/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { notFound } from "next/navigation";

export default async function OrganizationAgentChatPage({
	params,
}: {
	params: Promise<{ organizationSlug: string; agentId: string }>;
}) {
	const { organizationSlug, agentId } = await params;
	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		return notFound();
	}
	const queryClient = getServerQueryClient();
	await Promise.all([
		queryClient.prefetchQuery(
			registeredAgentChatQueryOptions(agentId, organization.id),
		),
		queryClient.prefetchQuery(
			agentChatAiConfigQueryOptions(organization.id),
		),
	]);
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<OrganizationAgentChatView agentId={agentId} />
		</HydrationBoundary>
	);
}
