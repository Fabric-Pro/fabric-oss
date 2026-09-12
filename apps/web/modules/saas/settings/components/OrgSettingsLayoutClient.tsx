"use client";

import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { usePathname } from "next/navigation";
import { type PropsWithChildren, useMemo } from "react";
import { SettingsReturnBanner } from "./SettingsReturnBanner";

const settingsPageTitles: Record<string, string> = {
	general: "General",
	members: "Members",
	"ai-providers": "AI Providers",
	"ai-models": "AI Models",
	"ai-memory": "AI Memory",
	"rag-providers": "RAG Providers",
	"search-providers": "Search Providers",
	openapi: "OpenAPI Services",
	agents: "Agent Registry",
	prompts: "Prompts",
	"api-keys": "API Keys",
	"audit-log": "Audit Log",
	"user-activity": "User Activity",
	usage: "AI Usage",
	billing: "Billing",
	"danger-zone": "Danger Zone",
	// Detail pages for providers and actions still live under this slug;
	// the catalogue itself is at /app/{slug}/connections.
	integrations: "Integrations",
};

type OrgSettingsLayoutClientProps = PropsWithChildren<{
	organizationSlug: string;
	organizationName: string;
}>;

export function OrgSettingsLayoutClient({
	children,
	organizationSlug,
	organizationName,
}: OrgSettingsLayoutClientProps) {
	const pathname = usePathname();

	const breadcrumbItems = useMemo(() => {
		const items: { label: string; href?: string }[] = [
			{
				label: organizationName,
				href: `/app/${organizationSlug}`,
			},
			{
				label: "Settings",
				href: `/app/${organizationSlug}/settings/general`,
			},
		];

		const settingsMatch = pathname.match(/\/settings\/([^/]+)/);
		if (settingsMatch) {
			const pageSlug = settingsMatch[1];
			const pageTitle = settingsPageTitles[pageSlug];
			if (pageTitle) {
				items.push({ label: pageTitle });
			}
		}

		return items;
	}, [pathname, organizationSlug, organizationName]);

	return (
		<>
			<TopRightControls />
			<div className="pt-4 pb-3">
				<PageBreadcrumbs items={breadcrumbItems} />
			</div>
			<SettingsReturnBanner />
			{children}
		</>
	);
}
