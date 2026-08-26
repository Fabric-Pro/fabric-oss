import { getOrganizationBySlug } from "@repo/database";
import { AgentEditRouter } from "@saas/agents/components/AgentEditRouter";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
		agentId: string;
	}>;
};

export const metadata = {
	title: "Edit Agent - Fabric",
	description: "Edit your agent configuration",
};

export default async function AgentInstanceEditPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug, agentId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getOrganizationBySlug(organizationSlug);
	const organizationId = organization?.id;
	const basePath = `/app/${organizationSlug}`;

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Agents", href: `${basePath}/agents` },
					{
						label: "Agent Details",
						href: `${basePath}/agents/${agentId}`,
					},
					{ label: "Edit Agent" },
				]}
			/>
			<AgentEditRouter
				agentId={agentId}
				organizationId={organizationId}
				basePath={basePath}
			/>
		</div>
	);
}
