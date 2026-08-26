/**
 * Personal-context audit log viewer page.
 *
 * Server component. The viewer reads only the caller's own personal-
 * context events (`organizationId: null` AND `userId: <self>`). There is
 * no deployment-admin bypass on this page — personal events are user-
 * scoped by D14.
 *
 * Spec: docs/audit-log/README.md §8.1.
 */

import { getSession } from "@saas/auth/lib/server";
import { AuditLogViewer } from "@saas/settings/components/audit-log/AuditLogViewer";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

function publicApiDocsEnabled(): boolean {
	const raw = process.env.FABRIC_PUBLIC_API_DOCS_ENABLED;
	if (!raw) {
		return false;
	}
	const v = raw.trim().toLowerCase();
	return v === "true" || v === "1" || v === "yes";
}

export const metadata = {
	title: "Audit Log",
	description: "Authentication and lifecycle events for your account",
};

export default async function AccountAuditLogPage() {
	const t = await getTranslations();
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title={t("settings.auditLog.title")}
				label={t("settings.auditLog.personalLabel")}
				description={t("settings.auditLog.personalDescription")}
			/>
			<SettingsList>
				<AuditLogViewer
					mode="personal"
					organizationId={null}
					viewerTimezone="UTC"
					canExport={true}
					currentUser={{
						id: session.user.id,
						email: session.user.email,
						name: session.user.name ?? null,
					}}
					docsEnabled={publicApiDocsEnabled()}
				/>
			</SettingsList>
		</>
	);
}
