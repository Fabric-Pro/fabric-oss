/**
 * Weave Settings Page (Organization context)
 *
 * Configuration for fabric-weave multi-agent orchestration
 */

import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ProjectWeaveConfigSettings } from "@saas/weave/components";
import { notFound, redirect } from "next/navigation";

interface WeaveSettingsPageProps {
	params: Promise<{ id: string; organizationSlug: string }>;
}

export default async function WeaveSettingsPage({
	params,
}: WeaveSettingsPageProps) {
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
		<div className="container mx-auto py-6 px-4 max-w-4xl">
			<ProjectWeaveConfigSettings projectId={id} />
		</div>
	);
}
