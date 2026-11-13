import { AppearanceSettings } from "@saas/settings/components/AppearanceSettings";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("settings.account.appearance.title"),
	};
}

/**
 * Personal appearance settings (Fizzy #1444). Account-global like its
 * siblings under `account/` — nothing here is passed the organization, and the
 * high-contrast choice reads the same in every organization the person is in.
 */
export default async function AccountAppearancePage() {
	const t = await getTranslations("settings.account.appearance");

	return (
		<>
			<SettingsHero
				title={t("title")}
				label={t("label")}
				description={t("description")}
			/>
			<AppearanceSettings />
		</>
	);
}
