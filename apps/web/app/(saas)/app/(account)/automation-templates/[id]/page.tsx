import { getSession } from "@saas/auth/lib/server";
import { TemplateEditor } from "@saas/automation-templates/components/TemplateEditor";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string }>;
};

export default async function TemplateDetailsPage({ params }: Props) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { id } = await params;

	return (
		<div className="w-full py-6">
			<TopRightControls />
			<TemplateEditor templateId={id} />
		</div>
	);
}
