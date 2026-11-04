import { getOrganizationBySlug } from "@repo/database";
import { AgentEditRouter } from "@saas/agents/components/AgentEditRouter";
import { getSession } from "@saas/auth/lib/server";
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
		<div className="flex h-full min-h-0 flex-1 flex-col">
			<AgentEditRouter
				agentId={agentId}
				organizationId={organizationId}
				basePath={basePath}
			/>
		</div>
	);
}
