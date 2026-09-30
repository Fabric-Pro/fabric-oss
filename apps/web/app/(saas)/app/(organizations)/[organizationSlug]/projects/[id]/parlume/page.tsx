/**
 * Parlume page (organization context).
 *
 * Thin server wrapper in the shape of the `/publishing` route: session, then
 * the active organization from `[organizationSlug]`, then the single
 * availability gate `isFeatureEnabled("PARLUME_MEETINGS", organization.id)` —
 * off → `notFound()` before any project access. The project is loaded with the
 * RESOLVED organization id, never `null`.
 *
 * `canEdit` is `project.canManageMembers`, the same `PROJECT_MEMBERS_MANAGE`
 * capability the start and stop procedures enforce, so the controls appear
 * exactly for the people the server will accept. Presentation only.
 */

import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ParlumePage } from "@saas/parlume/components/ParlumePage";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string; organizationSlug: string }>;
};

export default async function OrganizationParlumePage({ params }: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id, organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		notFound();
	}

	if (!(await isFeatureEnabled("PARLUME_MEETINGS", organization.id))) {
		notFound();
	}

	let projectResult: Awaited<ReturnType<typeof orpcClient.projects.get>>;
	try {
		projectResult = await orpcClient.projects.get({
			id,
			organizationId: organization.id,
		});
	} catch {
		notFound();
	}

	const basePath = `/app/${organizationSlug}`;

	return (
		<div className="space-y-6">
			<PageBreadcrumbs
				items={[
					{ label: "Projects", href: `${basePath}/projects` },
					{
						label: projectResult.project.name,
						href: `${basePath}/projects/${id}`,
					},
					{ label: "Parlume" },
				]}
			/>
			<ParlumePage
				projectId={id}
				canEdit={projectResult.project.canManageMembers === true}
			/>
		</div>
	);
}
