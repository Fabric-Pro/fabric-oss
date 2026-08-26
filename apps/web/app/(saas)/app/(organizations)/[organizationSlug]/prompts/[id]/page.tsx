import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PromptDetails } from "@saas/prompts/components/PromptDetails";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string; organizationSlug: string }>;
};

export default async function OrganizationPromptDetailsPage({ params }: Props) {
	const session = await getSession();
	const { id, organizationSlug } = await params;

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
			<PromptDetails
				promptId={id}
				organizationId={organization.id}
				organizationSlug={organizationSlug}
			/>
		</div>
	);
}
