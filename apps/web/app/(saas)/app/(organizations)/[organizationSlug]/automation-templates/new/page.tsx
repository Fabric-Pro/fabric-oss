import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { TemplateEditor } from "@saas/automation-templates/components/TemplateEditor";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export const metadata = {
	title: "New Automation Template - Fabric",
	description: "Create a reusable browser automation",
};

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export default async function OrganizationNewAutomationTemplatePage({
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
		<div className="w-full py-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: organization.name,
						href: `/app/${organizationSlug}`,
					},
					{
						label: "Automation Templates",
						href: `/app/${organizationSlug}/automation-templates`,
					},
					{ label: "New Template" },
				]}
			/>
			<TemplateEditor organizationId={organization.id} />
		</div>
	);
}
