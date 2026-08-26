import { getActiveOrganization } from "@saas/auth/lib/server";
import { OrganizationMembersBlock } from "@saas/organizations/components/OrganizationMembersBlock";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("organizations.settings.title"),
	};
}

export default async function OrganizationSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		return notFound();
	}

	return (
		<>
			<SettingsHero
				title="Members"
				label="Organization"
				description="Manage team members, roles, and pending invitations."
			/>
			<SettingsList>
				<OrganizationMembersBlock organizationId={organization.id} />
			</SettingsList>
		</>
	);
}
