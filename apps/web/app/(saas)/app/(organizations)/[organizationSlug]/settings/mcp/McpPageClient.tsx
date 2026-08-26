"use client";

import dynamic from "next/dynamic";

const OrgMcpSettingsForm = dynamic(
	() =>
		import("@saas/settings/components/OrgMcpSettingsForm").then(
			(m) => m.OrgMcpSettingsForm,
		),
	{ ssr: false },
);

export function McpPageClient() {
	return <OrgMcpSettingsForm />;
}
