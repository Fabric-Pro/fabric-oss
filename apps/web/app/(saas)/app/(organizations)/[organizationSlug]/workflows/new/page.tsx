import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";
import { NewWorkflowRedirect } from "./redirect";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export default async function NewWorkflowPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// This page creates a workflow and redirects to the canvas
	return <NewWorkflowRedirect organizationSlug={organizationSlug} />;
}
