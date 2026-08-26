/**
 * Weave Dashboard Page (Organization context)
 *
 * Overview of all weave plans and executions for a project
 */

import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { WeaveDashboard } from "@saas/weave/components";
import { notFound, redirect } from "next/navigation";

interface WeavePageProps {
	params: Promise<{ id: string; organizationSlug: string }>;
}

export default async function WeavePage({ params }: WeavePageProps) {
	const session = await getSession();
	const { id, organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		notFound();
	}

	return (
		<div className="container mx-auto py-6 px-4">
			<WeaveDashboard projectId={id} />
		</div>
	);
}
