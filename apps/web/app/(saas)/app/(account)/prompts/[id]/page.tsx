import { getSession } from "@saas/auth/lib/server";
import { PromptDetails } from "@saas/prompts/components/PromptDetails";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string }>;
};

export default async function PromptDetailsPage({ params }: Props) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { id } = await params;

	return (
		<div className="w-full py-6">
			<TopRightControls />
			<PromptDetails promptId={id} />
		</div>
	);
}
