import { DelegationSettingsForm } from "@saas/settings/components/DelegationSettingsForm";
import { SearchProvidersSettingsForm } from "@saas/settings/components/SearchProvidersSettingsForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";

export async function generateMetadata() {
	return {
		title: "Search Providers",
	};
}

export default function UserSearchProvidersSettingsPage() {
	return (
		<>
			<SettingsHero
				title="Search Providers"
				label="Configuration"
				description="Connect web search capabilities to enhance your agents with live data."
			/>
			<SettingsList>
				<SearchProvidersSettingsForm />
				<DelegationSettingsForm />
			</SettingsList>
		</>
	);
}
