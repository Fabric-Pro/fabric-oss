import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { TemplatesList } from "@saas/automation-templates/components/TemplatesList";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Automation Templates - Fabric",
	description: "Reusable browser automations you can replay with inputs",
};

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export default async function OrganizationAutomationTemplatesPage({
	params,
}: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return (
		<div>
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: organization.name,
						href: `/app/${organizationSlug}`,
					},
					{ label: "Automation Templates" },
				]}
			/>
			<TemplatesList organizationId={organization.id} />
		</div>
	);
}
