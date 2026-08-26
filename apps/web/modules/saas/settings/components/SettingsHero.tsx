"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";

interface SettingsHeroProps {
	title: string;
	description: string;
	label?: string;
	/**
	 * Which "Get started" page tour the header Compass opens. Defaults to the
	 * settings-menu tour; a settings page that is also a distinct destination
	 * with its own tour (e.g. Integrations) passes its own id so it doesn't
	 * double up with a page-level launcher below.
	 */
	getStartedPageId?: string;
	/** @deprecated colorTheme is no longer used */
	colorTheme?: string;
}

export function SettingsHero({
	title,
	description,
	label,
	getStartedPageId = "app-settings",
}: SettingsHeroProps) {
	return (
		<PageHeader
			label={label ?? "Configuration"}
			title={title}
			getStartedPageId={getStartedPageId}
			description={description}
		/>
	);
}
