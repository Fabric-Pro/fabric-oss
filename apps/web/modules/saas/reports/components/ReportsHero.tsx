"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";

export function ReportsHero() {
	return (
		<PageHeader
			label="Report templates"
			title="Report Template Gallery"
			getStartedPageId="reports-hub"
			description="Use pre-configured templates for summaries, sprint reports, meeting notes, and scheduled reporting."
		/>
	);
}
