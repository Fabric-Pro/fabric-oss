"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";

export function WorkspacesHero() {
	return (
		<PageHeader
			label="Document intelligence"
			title="Workspaces"
			getStartedPageId="workspaces"
			description="Organize documents for retrieval, search, and agent context."
		/>
	);
}
