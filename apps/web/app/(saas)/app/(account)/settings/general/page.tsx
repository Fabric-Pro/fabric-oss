import { config } from "@repo/config";
import { getSession } from "@saas/auth/lib/server";
import { OrganizationBrandColorForm } from "@saas/organizations/components/OrganizationBrandColorForm";
import { ChangeEmailForm } from "@saas/settings/components/ChangeEmailForm";
import { ChangeNameForm } from "@saas/settings/components/ChangeNameForm";
import { DefaultFunctionTagsForm } from "@saas/settings/components/DefaultFunctionTagsForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { UserAvatarForm } from "@saas/settings/components/UserAvatarForm";
import { UserLanguageForm } from "@saas/settings/components/UserLanguageForm";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("settings.account.title"),
	};
}

export default async function AccountSettingsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title="General Settings"
				label="Account"
				description="Update your profile, display name, and language preferences."
			/>
			<SettingsList>
				<UserAvatarForm />
				{config.i18n.enabled && <UserLanguageForm />}
				<ChangeNameForm />
				<ChangeEmailForm />
				<OrganizationBrandColorForm />
				<DefaultFunctionTagsForm />
			</SettingsList>
		</>
	);
}
