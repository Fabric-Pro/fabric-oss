import { createAgentChatServerClient } from "@repo/api/modules/agents/lib/agent-chat-server-client";
import { OrganizationAgentChatView } from "@saas/agents/components/OrganizationAgentChatView";
import {
	agentChatAiConfigQueryOptions,
	registeredAgentChatQueryOptions,
} from "@saas/agents/lib/agent-chat-queries";
import { getActiveOrganization } from "@saas/auth/lib/server";
import {
	logChatRequestTiming,
	measureCatalogRequestPhase,
} from "@saas/shared/lib/catalog-request-timing";
import { getServerQueryClient } from "@shared/lib/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export default async function OrganizationAgentChatPage({
	params,
}: {
	params: Promise<{ organizationSlug: string; agentId: string }>;
}) {
	logChatRequestTiming("registered-agent");
	const { organizationSlug, agentId } = await params;
	const organization = await measureCatalogRequestPhase(
		"chat_organization",
		() => getActiveOrganization(organizationSlug),
	);
	if (!organization) {
		return notFound();
	}
	const queryClient = getServerQueryClient();
	const serverClient = createAgentChatServerClient(
		new Headers(await headers()),
	);
	await Promise.all([
		queryClient.prefetchQuery({
			...registeredAgentChatQueryOptions(agentId, organization.id),
			queryFn: () =>
				measureCatalogRequestPhase("chat_registry", () =>
					serverClient.getRegisteredAgent({
						id: agentId,
						organizationId: organization.id,
					}),
				),
		}),
		queryClient.prefetchQuery({
			...agentChatAiConfigQueryOptions(organization.id),
			queryFn: () =>
				measureCatalogRequestPhase("chat_ai_config", () =>
					serverClient.getAiConfigStatus({
						organizationId: organization.id,
					}),
				),
		}),
	]);
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<OrganizationAgentChatView
				agentId={agentId}
				organization={{
					id: organization.id,
					slug: organization.slug,
					name: organization.name,
				}}
			/>
		</HydrationBoundary>
	);
}
