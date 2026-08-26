"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";

export function AgentsHero() {
	return (
		<PageHeader
			label="AI agents"
			title="Agents"
			getStartedPageId="agents"
			description="Deploy agents that understand your codebase, conventions, and delivery workflow."
		/>
	);
}
