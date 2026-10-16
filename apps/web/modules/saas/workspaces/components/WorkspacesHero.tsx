"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";
import type { ReactNode } from "react";

export function WorkspacesHero({ actions }: { actions?: ReactNode }) {
	return (
		<PageHeader
			label="Pages for your organization"
			title="Workspaces"
			getStartedPageId="workspaces"
			description="Pages Fabric Agent writes for your organization, shared with everyone in it unless you ask for one to stay private. Describe what you want to see and it builds the page."
			actions={actions}
		/>
	);
}
