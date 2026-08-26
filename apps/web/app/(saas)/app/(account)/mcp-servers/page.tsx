import { McpServersView } from "@saas/mcp/components/McpServersView";
import { SettingsReturnBanner } from "@saas/settings/components/SettingsReturnBanner";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";

export const metadata = {
	title: "MCP Servers",
	description: "Manage your Model Context Protocol server configurations",
};

export default function McpServersPage() {
	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "MCP Servers" }]} />

			{/* Shows a "Return to project setup" banner when the user arrived
			    here from the project wizard's "Configure MCP" link (returnTo
			    points at /projects/new...). Renders nothing on direct visits or
			    when arriving from an in-project context chip (whose returnTo is
			    the /app/{projectSlug} detail page, not a /projects/ path). */}
			<SettingsReturnBanner />

			<McpServersView organizationId={null} />
		</div>
	);
}
