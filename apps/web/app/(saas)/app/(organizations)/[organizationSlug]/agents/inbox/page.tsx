"use client";

import { AgentInboxView } from "@saas/agents/components/AgentInboxView";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";

export default function OrganizationAgentInboxPage() {
	const { organizationId, organizationName, basePath } =
		useOrganizationContext();

	return (
		<div className="w-full py-8 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					...(organizationId
						? [
								{
									label: organizationName ?? "Organization",
									href: basePath,
								},
							]
						: []),
					{ label: "Agents", href: `${basePath}/agents` },
					{ label: "Inbox" },
				]}
			/>
			<AgentInboxView
				organizationId={organizationId}
				basePath={basePath}
			/>
		</div>
	);
}
