import { getAgentTemplate } from "@repo/database";
import { CreateAgentFromTemplate } from "@saas/agent-templates/components/CreateAgentFromTemplate";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
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

	// Fetch template to get the display name for breadcrumb
	const template = await getAgentTemplate(slug);
	const templateName = template?.displayName || "Template";

	const basePath = `/app/${organizationSlug}/agent-templates`;

	return (
		<div className="min-h-screen">
			<div className="w-full py-6 px-6 space-y-6">
				<TopRightControls />
				<PageBreadcrumbs
					items={[
						{
							label: organization.name,
							href: `/app/${organizationSlug}`,
						},
						{ label: "Agent Templates", href: basePath },
						{ label: templateName, href: `${basePath}/${slug}` },
						{ label: "Create Agent From Template" },
					]}
				/>
			</div>
			<CreateAgentFromTemplate
				slug={slug}
				organizationId={organization.id}
				basePath={basePath}
			/>
		</div>
	);
}
