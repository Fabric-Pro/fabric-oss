import { AgentTemplatesPageTabs } from "@saas/agent-templates";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Agent Templates - Fabric",
	description: "Pre-built AI agents for every department",
};

type Props = {
	params: Promise<{ organizationSlug: string }>;
	searchParams: Promise<{ tab?: string }>;
};

export default async function OrganizationAgentTemplatesPage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;
	const { tab } = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	const defaultTab = tab === "agents" ? "agents" : "gallery";

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: organization.name,
						href: `/app/${organizationSlug}`,
					},
					{ label: "Agent Templates" },
				]}
			/>
			<AgentTemplatesPageTabs
				organizationId={organization.id}
				basePath={`/app/${organizationSlug}/agent-templates`}
				defaultTab={defaultTab}
			/>
		</div>
	);
}
