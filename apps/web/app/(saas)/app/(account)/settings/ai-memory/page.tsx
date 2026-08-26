import { OrchestratorMemoryForm } from "@saas/settings/components/OrchestratorMemoryForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";

export const metadata = {
	title: "AI Memory",
};

export default function AiMemorySettingsPage() {
	return (
		<>
			<SettingsHero
				title="AI Memory"
				label="Configuration"
				description="Configure how the AI retains context and learns from your conversations."
			/>
			<SettingsList>
				<OrchestratorMemoryForm organizationId={null} />
			</SettingsList>
		</>
	);
}
