/**
 * A change Parlume proposed in a meeting (organization context), where a
 * signed-in member with edit rights confirms or dismisses it. Chat posts link
 * here.
 *
 * Same gates as the Parlume page: session (back to this page after sign-in),
 * then the active organization, then `PARLUME_MEETINGS`, then project access.
 * The confirm and dismiss procedures check edit rights again; the page only
 * decides what to show.
 */

import { isFeatureEnabled } from "@repo/database";
import { loginPathReturningTo } from "@saas/auth/lib/login-redirect";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ParlumeActionPage } from "@saas/parlume/components/ParlumeActionPage";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{
		id: string;
		organizationSlug: string;
		actionId: string;
	}>;
	searchParams: Promise<{ intent?: string | string[] }>;
};

export default async function OrganizationParlumeActionPage({
	params,
	searchParams,
}: Props) {
	const { id, organizationSlug, actionId } = await params;
	const { intent } = await searchParams;
	const projectBasePath = `/app/${organizationSlug}/projects/${id}`;
	const ownPath = `${projectBasePath}/parlume/actions/${encodeURIComponent(actionId)}`;

	const session = await getSession();
	if (!session) {
		redirect(
			loginPathReturningTo(
				intent === "dismiss" ? `${ownPath}?intent=dismiss` : ownPath,
			),
		);
	}

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

	return (
		<div className="space-y-6">
			<PageBreadcrumbs
				items={[
					{
						label: "Projects",
						href: `/app/${organizationSlug}/projects`,
					},
					{
						label: projectResult.project.name,
						href: projectBasePath,
					},
					{ label: "Parlume", href: `${projectBasePath}/parlume` },
					{ label: "Proposed change" },
				]}
			/>
			<ParlumeActionPage
				projectId={id}
				actionId={actionId}
				projectBasePath={projectBasePath}
				dismissIntent={intent === "dismiss"}
			/>
		</div>
	);
}
