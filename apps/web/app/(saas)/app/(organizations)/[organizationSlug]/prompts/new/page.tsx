import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PromptCreator } from "@saas/prompts/components/PromptCreator";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export default async function NewOrganizationPromptPage({ params }: Props) {
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
						label: "Prompts",
						href: `/app/${organizationSlug}/prompts`,
					},
					{ label: "New Prompt" },
				]}
				className="mb-6"
			/>
			<PromptCreator organizationId={organization.id} />
		</div>
	);
}
