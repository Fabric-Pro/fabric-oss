import { getSession } from "@saas/auth/lib/server";
import { TemplatesList } from "@saas/automation-templates/components/TemplatesList";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function AutomationTemplatesPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div>
			<TopRightControls />
			<TemplatesList />
		</div>
	);
}
