"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";
import type { ReactNode } from "react";

export function PagesHero({ actions }: { actions?: ReactNode }) {
	return (
		<PageHeader
			label="Pages for your organization"
			title="Pages"
			getStartedPageId="pages"
			description="Interactive pages, dashboards, and tools built by Fabric Agent. Share them with your organization or keep them private."
			actions={actions}
		/>
	);
}
