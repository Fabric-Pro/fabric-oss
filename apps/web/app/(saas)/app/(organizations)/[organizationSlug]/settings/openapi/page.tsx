import { OrgOpenAPISettingsForm } from "@saas/settings/components/OrgOpenAPISettingsForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";

export default function Page() {
	return (
		<>
			<SettingsHero
				title="OpenAPI Services"
				label="Configuration"
				description="Register OpenAPI specifications to enable tool-calling from external services."
			/>
			<div className="space-y-6">
				<OrgOpenAPISettingsForm />
			</div>
		</>
	);
}
