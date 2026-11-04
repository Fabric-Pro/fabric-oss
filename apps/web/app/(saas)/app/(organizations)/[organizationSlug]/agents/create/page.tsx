import { CreateCustomAgent } from "@saas/agent-templates";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
	}>;
};

export const metadata = {
	title: "Create Custom Agent - Fabric",
	description: "Create a custom AI agent from scratch",
};

export default async function CreateAgentPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	const basePath = `/app/${organizationSlug}/agents`;

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col">
			<CreateCustomAgent
				organizationId={organization.id}
				basePath={basePath}
			/>
		</div>
	);
}
