import { getOrganizationBySlug } from "@repo/database";
import { AgentDuplicateRouter } from "@saas/agents/components/AgentDuplicateRouter";
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
	title: "Duplicate Agent - Fabric",
	description: "Create a new agent from an existing configuration",
};

export default async function AgentDuplicatePage({ params }: Props) {
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
					{ label: "Duplicate Agent" },
				]}
			/>
			<AgentDuplicateRouter
				agentId={agentId}
				organizationId={organizationId}
				basePath={basePath}
			/>
		</div>
	);
}
