import { getOrganizationBySlug } from "@repo/database";
import { AgentInstanceEdit } from "@saas/agent-templates/components/AgentInstanceEdit";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
		instanceId: string;
	}>;
};

export const metadata = {
	title: "Edit Agent - Fabric",
	description: "Edit your agent configuration",
};

export default async function AgentInstanceEditPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug, instanceId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	// Get organization ID from slug
	const organization = await getOrganizationBySlug(organizationSlug);
	const organizationId = organization?.id;

	const basePath = `/app/${organizationSlug}/agent-templates`;

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col">
			<AgentInstanceEdit
				instanceId={instanceId}
				organizationId={organizationId}
				basePath={basePath}
			/>
		</div>
	);
}
