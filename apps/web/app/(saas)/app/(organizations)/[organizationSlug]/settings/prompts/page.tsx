import { PromptManagementPage } from "@saas/prompts/components/PromptManagementPage";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export default async function Page({ params }: Props) {
	const { organizationSlug } = await params;

	// Pass organizationSlug - the component will resolve the ID via useOrganizationContext hook
	return <PromptManagementPage organizationSlug={organizationSlug} />;
}
