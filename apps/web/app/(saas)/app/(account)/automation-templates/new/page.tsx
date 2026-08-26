import { getSession } from "@saas/auth/lib/server";
import { TemplateEditor } from "@saas/automation-templates/components/TemplateEditor";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function NewTemplatePage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6">
			<TopRightControls />
			<TemplateEditor />
		</div>
	);
}
