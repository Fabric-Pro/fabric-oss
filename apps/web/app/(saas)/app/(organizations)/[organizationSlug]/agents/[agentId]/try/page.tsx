"use client";

import { RegisteredAgentTryWorkspace } from "@saas/agents/components/RegisteredAgentTryWorkspace";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useParams } from "next/navigation";

export default function OrganizationAgentTryPage() {
	const params = useParams();
	const agentId = params.agentId as string;
	const { basePath, organizationId } = useOrganizationContext();

	return (
		<RegisteredAgentTryWorkspace
			agentId={agentId}
			basePath={basePath}
			organizationId={organizationId}
		/>
	);
}
