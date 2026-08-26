import { getOrganizationBySlug } from "@repo/database";
import { PromptEnhancePage } from "@saas/prompts/components/PromptEnhancePage";

type Props = {
	params: Promise<{ organizationSlug: string; id: string }>;
};

export default async function Page({ params }: Props) {
	const { organizationSlug, id } = await params;
	const organization = await getOrganizationBySlug(organizationSlug);

	if (!organization) {
		throw new Error("Organization not found");
	}

	return <PromptEnhancePage promptId={id} organizationId={organization.id} />;
}
