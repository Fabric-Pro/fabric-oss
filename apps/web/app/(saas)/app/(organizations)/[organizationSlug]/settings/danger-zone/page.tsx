import { isOrganizationOwner } from "@repo/auth/lib/helper";
import { ORGANIZATION_RETENTION_DAYS } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { DeleteOrganizationForm } from "@saas/organizations/components/DeleteOrganizationForm";
import { DangerZoneHero } from "@saas/settings/components/DangerZoneHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("organizations.settings.dangerZone.title"),
	};
}

export default async function OrganizationSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;

	// The nav entry is owner-gated, but hiding a link is not access control:
	// this page had no check of its own, so anyone who knew the URL reached the
	// delete control regardless of role. The server refuses the deletion itself,
	// so this was never an isolation hole — but showing a destructive button to
	// someone who cannot use it is how the admin-gets-a-403 report started
	// (Fizzy #2462, AC-4). Refuse the page, not just the link.
	const [session, organization] = await Promise.all([
		getSession(),
		getActiveOrganization(organizationSlug),
	]);

	if (!organization) {
		redirect("/app");
	}

	if (!isOrganizationOwner(organization, session?.user)) {
		redirect(`/app/${organizationSlug}/settings/general`);
	}

	return (
		<>
			<DangerZoneHero />
			<SettingsList>
				<DeleteOrganizationForm
					retentionDays={ORGANIZATION_RETENTION_DAYS}
				/>
			</SettingsList>
		</>
	);
}
