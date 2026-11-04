import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { WorkflowsList } from "@saas/workflows/components/WorkflowsList";
import { redirect } from "next/navigation";

export default async function WorkflowsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return <WorkflowsList />;
}
