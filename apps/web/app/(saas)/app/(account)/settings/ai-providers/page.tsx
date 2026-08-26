import { AIGatewayHero } from "@saas/settings/components/AIGatewayHero";
import { AiProvidersSettingsForm } from "@saas/settings/components/AiProvidersSettingsForm";
import { SettingsList } from "@saas/shared/components/SettingsList";

export async function generateMetadata() {
	return {
		title: "AI Providers",
	};
}

export default function AiProvidersSettingsPage() {
	return (
		<>
			<AIGatewayHero />
			<SettingsList>
				<AiProvidersSettingsForm />
			</SettingsList>
		</>
	);
}
