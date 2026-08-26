import { PromptEnhancePage } from "@saas/prompts/components/PromptEnhancePage";

type Props = {
	params: Promise<{ id: string }>;
};

export default async function Page({ params }: Props) {
	const { id } = await params;

	return <PromptEnhancePage promptId={id} />;
}
