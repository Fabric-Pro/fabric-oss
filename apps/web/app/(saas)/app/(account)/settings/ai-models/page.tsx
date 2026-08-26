import { AiModelPreferencesForm } from "@saas/settings/components/AiModelPreferencesForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";

export async function generateMetadata() {
	return {
		title: "AI Model Preferences",
	};
}

export default function AiModelPreferencesPage() {
	return (
		<>
			<SettingsHero
				title="AI Models"
				label="Configuration"
				description="Choose which models power each task type — chat, reasoning, embeddings, and more."
			/>
			<SettingsList>
				<AiModelPreferencesForm />
			</SettingsList>
		</>
	);
}
