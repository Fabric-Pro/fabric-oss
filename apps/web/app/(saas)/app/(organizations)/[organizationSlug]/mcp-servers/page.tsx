"use client";

import { McpServersView } from "@saas/mcp/components/McpServersView";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { SettingsReturnBanner } from "@saas/settings/components/SettingsReturnBanner";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";

export default function OrganizationMcpServersPage() {
	const { organizationId, organizationName, basePath } =
		useOrganizationContext();

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					...(organizationId
						? [
								{
									label: organizationName ?? "Organization",
									href: basePath,
								},
							]
						: []),
					{ label: "MCP Servers" },
				]}
			/>

			{/* Shows a "Return to project setup" banner when the user arrived
			    here from the project wizard's "Configure MCP" link. Renders
			    nothing on direct visits or from the in-project context chip. */}
			<SettingsReturnBanner />

			<McpServersView organizationId={organizationId} />
		</div>
	);
}
