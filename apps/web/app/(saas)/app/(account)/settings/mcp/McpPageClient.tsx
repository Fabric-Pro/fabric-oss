"use client";

import dynamic from "next/dynamic";

const UserMcpSettingsForm = dynamic(
	() =>
		import("@saas/settings/components/UserMcpSettingsForm").then(
			(m) => m.UserMcpSettingsForm,
		),
	{ ssr: false },
);

export function McpPageClient() {
	return <UserMcpSettingsForm />;
}
