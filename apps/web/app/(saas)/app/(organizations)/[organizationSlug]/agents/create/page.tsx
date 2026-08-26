import { CreateCustomAgent } from "@saas/agent-templates";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
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
		<div className="min-h-screen">
			<div className="w-full space-y-6 px-6 py-6">
				<TopRightControls />
				<PageBreadcrumbs
					items={[
						{
							label: organization.name,
							href: `/app/${organizationSlug}`,
						},
						{ label: "Agents", href: basePath },
						{ label: "Create Custom Agent" },
					]}
				/>
			</div>
			<CreateCustomAgent
				organizationId={organization.id}
				basePath={basePath}
			/>
		</div>
	);
}
