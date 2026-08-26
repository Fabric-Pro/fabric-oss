"use client";

import { AgentInboxView } from "@saas/agents/components/AgentInboxView";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";

export default function AgentInboxPage() {
	return (
		<div className="w-full py-8 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Agents", href: "/app/agents" },
					{ label: "Inbox" },
				]}
			/>
			<AgentInboxView basePath="/app" />
		</div>
	);
}
