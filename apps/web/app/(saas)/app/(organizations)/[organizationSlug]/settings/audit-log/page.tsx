/**
 * Org-context audit log viewer page.
 *
 * Server component. Resolves the organization, checks that the caller is
 * either an owner/admin of the org or a deployment admin (env-list
 * bypass), and renders the client-side table/filter shell. Non-admins
 * navigating directly to the URL see an editorial-restraint forbidden
 * panel rather than a stack trace (item 23 access control).
 *
 * Spec: docs/audit-log/README.md §8.1.
 */

import { Card, CardContent } from "@ui/components/card";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { getOrganizationMembership } from "@repo/database";
import { isDeploymentAdminEmail } from "@saas/settings/lib/deployment-admin";
import { AuditLogViewer } from "@saas/settings/components/audit-log/AuditLogViewer";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { XIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

/**
 * Whether the public audit-log REST API documentation UI is enabled in
 * this environment. Server-side env so the prod build doesn't advertise
 * the docs link. The endpoints themselves still work in prod — only the
 * Swagger UI is gated.
 */
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
	description: "Comprehensive audit trail for the organization",
};

export default async function OrganizationAuditLogPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const t = await getTranslations();
	const { organizationSlug } = await params;
	const [session, organization] = await Promise.all([
		getSession(),
		getActiveOrganization(organizationSlug),
	]);

	if (!organization) {
		return notFound();
	}

	const userId = session?.user?.id;
	const membership = userId
		? await getOrganizationMembership(organization.id, userId)
		: null;
	const role = membership?.role ?? null;
	const isAdminOrOwner = role === "owner" || role === "admin";
	const isDeploymentAdmin = isDeploymentAdminEmail(
		session?.user?.email ?? null,
	);
	const canView = isAdminOrOwner || isDeploymentAdmin;

	if (!canView) {
		return (
			<>
				<SettingsHero
					title={t("settings.auditLog.title")}
					label={t("settings.auditLog.label")}
					description={t("settings.auditLog.forbidden.description")}
				/>
				<Card className="border-destructive/30 bg-destructive/5">
					<CardContent className="flex flex-col items-start gap-3 p-6">
						<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
							<XIcon className="size-4" />
							{t("settings.auditLog.forbidden.title")}
						</div>
						<p className="max-w-2xl text-sm text-muted-foreground">
							{t("settings.auditLog.forbidden.description")}
						</p>
					</CardContent>
				</Card>
			</>
		);
	}

	const canExport = isAdminOrOwner || isDeploymentAdmin;

	return (
		<>
			<SettingsHero
				title={t("settings.auditLog.title")}
				label={t("settings.auditLog.label")}
				description={t("settings.auditLog.description")}
			/>
			<SettingsList>
				<AuditLogViewer
					mode="organization"
					organizationId={organization.id}
					viewerTimezone="UTC"
					canExport={canExport}
					currentUser={{
						id: session?.user?.id ?? "",
						email: session?.user?.email ?? "",
						name: session?.user?.name ?? null,
					}}
					docsEnabled={publicApiDocsEnabled()}
				/>
			</SettingsList>
		</>
	);
}
