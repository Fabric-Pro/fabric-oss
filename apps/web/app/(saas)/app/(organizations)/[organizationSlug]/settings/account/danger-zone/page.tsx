import { getSession } from "@saas/auth/lib/server";
import { DangerZoneHero } from "@saas/settings/components/DangerZoneHero";
import { DeleteAccountForm } from "@saas/settings/components/DeleteAccountForm";
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
			<DangerZoneHero />
			<SettingsList>
				<DeleteAccountForm />
			</SettingsList>
		</>
	);
}
