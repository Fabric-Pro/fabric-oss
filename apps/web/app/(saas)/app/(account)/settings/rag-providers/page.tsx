import { RAGProvidersHero } from "@saas/settings/components/RAGProvidersHero";
import { UserRagProvidersSettingsForm } from "@saas/settings/components/UserRagProvidersSettingsForm";
import { SettingsList } from "@saas/shared/components/SettingsList";

export async function generateMetadata() {
	return {
		title: "RAG Extraction Providers",
	};
}

export default function UserRagProvidersSettingsPage() {
	return (
		<>
			<RAGProvidersHero />
			<SettingsList>
				<UserRagProvidersSettingsForm />
			</SettingsList>
		</>
	);
}
