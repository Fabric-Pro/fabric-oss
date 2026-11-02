"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";
import type { ReactNode } from "react";

export function AgentsHero({
	actions,
	className,
}: {
	actions?: ReactNode;
	className?: string;
} = {}) {
	return (
		<PageHeader
			label="AI agents"
			title="Agents"
			getStartedPageId="agents"
			description="Deploy agents that understand your codebase, conventions, and delivery workflow."
			actions={actions}
			className={className}
		/>
	);
}
