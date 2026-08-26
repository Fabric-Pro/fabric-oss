import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { WorkflowEditor } from "@saas/workflows/components/WorkflowEditor";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string; id: string }>;
};

export default async function WorkflowEditorPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug, id } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return (
		// `flex-1 min-h-0`, not `h-full`: the shell's content column gets its
		// height from `flex-1`, which is not a definite height, so a
		// percentage height here resolves to `auto` and the whole editor
		// collapses to its content — a ~211px canvas on a 900px viewport.
		<div className="flex-1 min-h-0 flex flex-col">
			<WorkflowEditor workflowId={id} />
		</div>
	);
}
