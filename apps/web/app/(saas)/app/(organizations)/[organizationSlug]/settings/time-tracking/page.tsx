import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PageHeader } from "@saas/shared/components/PageHeader";
import { InfoHint } from "@saas/time-tracking/components/InfoHint";
import { OrganizationTimeTrackingSettings } from "@saas/time-tracking/components/OrganizationTimeTrackingSettings";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const metadata = {
	title: "Time tracking",
};

/**
 * Organization settings → Time tracking: the entry rules every project of the
 * organization starts from. Every member sees them; only administrators and
 * owners, who hold the organization update permission the save checks, can
 * change them.
 *
 * The settings layout already sends project guests away.
 */
export default async function OrgTimeTrackingSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const [session, organization] = await Promise.all([
		getSession(),
		getActiveOrganization(organizationSlug),
	]);

	if (!organization) {
		notFound();
	}

	const t = await getTranslations("timeTracking.settings");

	return (
		<div className="space-y-6">
			<PageHeader
				title={t("title")}
				titleAdornment={
					<InfoHint label={t("aboutTitle")}>{t("about")}</InfoHint>
				}
				getStartedPageId="app-settings"
			/>
			<OrganizationTimeTrackingSettings
				organizationId={organization.id}
				canEdit={isOrganizationAdmin(organization, session?.user)}
			/>
		</div>
	);
}
