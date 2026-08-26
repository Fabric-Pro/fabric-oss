import { getSession } from "@saas/auth/lib/server";
import { WorkflowEditor } from "@saas/workflows/components/WorkflowEditor";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string }>;
};

export default async function WorkflowEditorPage({ params }: Props) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { id } = await params;

	return (
		// `flex-1 min-h-0`, not `h-full` — see the organization-context page.
		<div className="flex-1 min-h-0 flex flex-col">
			<WorkflowEditor workflowId={id} />
		</div>
	);
}
