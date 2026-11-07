"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";
import { useTranslations } from "next-intl";

export function AgentTemplatesHero() {
	const t = useTranslations("deliveryStarters");
	return (
		<PageHeader
			label="Agent templates"
			title={t("galleryTitle")}
			getStartedPageId="agent-templates"
			description={t("galleryDescription")}
		/>
	);
}
