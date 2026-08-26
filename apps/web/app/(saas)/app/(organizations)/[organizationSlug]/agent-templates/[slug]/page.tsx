import { AgentTemplateDetail } from "@saas/agent-templates";
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

export default async function OrganizationAgentTemplateDetailPage({
	params,
}: Props) {
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
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: organization.name,
						href: `/app/${organizationSlug}`,
					},
					{ label: "Agent Templates", href: basePath },
					{ label: "Template Details" },
				]}
			/>
			<AgentTemplateDetail
				slug={slug}
				organizationId={organization.id}
				basePath={basePath}
			/>
		</div>
	);
}
