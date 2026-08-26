import { DeleteOrganizationForm } from "@saas/organizations/components/DeleteOrganizationForm";
import { DangerZoneHero } from "@saas/settings/components/DangerZoneHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("organizations.settings.dangerZone.title"),
	};
}

export default function OrganizationSettingsPage() {
	return (
		<>
			<DangerZoneHero />
			<SettingsList>
				<DeleteOrganizationForm />
			</SettingsList>
		</>
	);
}
