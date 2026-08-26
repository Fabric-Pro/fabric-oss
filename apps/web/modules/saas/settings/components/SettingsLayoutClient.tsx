"use client";

import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { usePathname } from "next/navigation";
import { type PropsWithChildren, useEffect, useMemo } from "react";
import { SettingsReturnBanner } from "./SettingsReturnBanner";

const settingsPageTitles: Record<string, string> = {
	general: "General Settings",
	security: "Security",
	"ai-providers": "AI Providers",
	"ai-models": "AI Models",
	"ai-gateway": "AI Gateway",
	"ai-memory": "AI Memory",
	"rag-providers": "RAG Providers",
	"search-providers": "Search Providers",
	mcp: "MCP Registry",
	openapi: "OpenAPI Services",
	agents: "Agent Registry",
	prompts: "Prompts",
	"api-keys": "API Keys",
	billing: "Billing",
	usage: "AI Usage",
	"danger-zone": "Danger Zone",
	firecrawl: "Firecrawl",
	integrations: "Integrations",
	"data-connections": "Integrations",
};

export function SettingsLayoutClient({ children }: PropsWithChildren) {
	const { setIsFullscreen } = useFullscreen();
	const pathname = usePathname();

	const breadcrumbItems = useMemo(() => {
		const items: { label: string; href?: string }[] = [
			{ label: "Settings", href: "/app/settings/general" },
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
	}, [pathname]);

	useEffect(() => {
		setIsFullscreen(true);
		return () => {
			setIsFullscreen(false);
		};
	}, [setIsFullscreen]);

	return (
		<>
			<TopRightControls />
			<div className="py-5">
				<PageBreadcrumbs items={breadcrumbItems} />
			</div>
			<SettingsReturnBanner />
			{children}
		</>
	);
}
