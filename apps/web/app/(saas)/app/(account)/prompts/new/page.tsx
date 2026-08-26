import { getSession } from "@saas/auth/lib/server";
import { PromptCreator } from "@saas/prompts/components/PromptCreator";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function NewPromptPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Prompts", href: "/app/prompts" },
					{ label: "New Prompt" },
				]}
				className="mb-6"
			/>
			<PromptCreator />
		</div>
	);
}
