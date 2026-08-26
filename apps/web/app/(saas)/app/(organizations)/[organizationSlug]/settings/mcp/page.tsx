import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { McpPageClient } from "./McpPageClient";

export default function Page() {
	return (
		<>
			<SettingsHero
				title="MCP Registry"
				label="Configuration"
				description="Manage Model Context Protocol server connections and tool integrations."
			/>
			<div className="space-y-6">
				<McpPageClient />
			</div>
		</>
	);
}
