import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ConnectionsTabs } from "@saas/data-connections/components/ConnectionsTabs";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export const metadata = {
	title: "Connections",
	description:
		"The integrations and MCP servers your organization's agents can search, cite and call",
};

/**
 * Connections is a destination in its own right, like Workflows or
 * Workspaces, not a settings panel: it gets the same shell as its siblings
 * and no second menu. Provider and action detail pages keep their homes
 * under Settings, and the old /settings/integrations index redirects here.
 */
export default async function ConnectionsPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Connections" }]} />
			<ConnectionsTabs
				organizationId={organization.id}
				addHref={`/app/${organizationSlug}/settings/integrations/add`}
				settingsBasePath={`/app/${organizationSlug}/settings/integrations`}
			/>
		</div>
	);
}
