import { config } from "@repo/config";
import { AttachmentRetentionForm } from "@saas/organizations/components/AttachmentRetentionForm";
import { ChangeOrganizationNameForm } from "@saas/organizations/components/ChangeOrganizationNameForm";
import { OrganizationBrandColorForm } from "@saas/organizations/components/OrganizationBrandColorForm";
import { OrganizationLogoForm } from "@saas/organizations/components/OrganizationLogoForm";
import { RequireTwoFactorForm } from "@saas/organizations/components/RequireTwoFactorForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("organizations.settings.title"),
	};
}

export default function OrganizationSettingsPage() {
	return (
		<>
			<SettingsHero
				title="General Settings"
				label="Organization"
				description="Update your organization name, logo, and general preferences."
			/>
			<SettingsList>
				<OrganizationLogoForm />
				<ChangeOrganizationNameForm />
				<OrganizationBrandColorForm />
				<AttachmentRetentionForm />
				{config.auth.enableTwoFactor && <RequireTwoFactorForm />}
			</SettingsList>
		</>
	);
}
