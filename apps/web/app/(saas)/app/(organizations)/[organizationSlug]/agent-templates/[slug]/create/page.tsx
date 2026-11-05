import { CreateAgentFromTemplate } from "@saas/agent-templates/components/CreateAgentFromTemplate";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
		slug: string;
	}>;
};

export const metadata = {
	title: "Create Agent From Template - Fabric",
	description: "Create a new agent from an existing template",
};

export default async function OrganizationCreateAgentPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug, slug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	const basePath = `/app/${organizationSlug}/agent-templates`;

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col">
			<CreateAgentFromTemplate
				slug={slug}
				organizationId={organization.id}
				basePath={basePath}
			/>
		</div>
	);
}
