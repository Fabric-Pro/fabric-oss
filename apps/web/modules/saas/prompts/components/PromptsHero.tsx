"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";

export function PromptsHero() {
	return (
		<PageHeader
			label="Prompt library"
			title="Prompts"
			getStartedPageId="prompts"
			description="Reusable instructions for agents, workflows, and repeatable AI work."
		/>
	);
}
