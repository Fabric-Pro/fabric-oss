/**
 * Publishing Suite deep-link page (organization context).
 *
 * Thin server wrapper for the design-locked `/projects/{id}/publishing`
 * route. The client UI-rollout flag (`NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE`)
 * gates FIRST, since it needs no data access. The server gate resolves
 * per-organization, so it CANNOT run before the organization is known: session
 * resolves next, then the active organization from the `[organizationSlug]`
 * segment, then `isFeatureEnabled("PUBLISHING_SUITE", organization.id)` — off →
 * `notFound()`, still before any project access. Only then does the page fetch
 * the project through the SAME `getProjectById(id, userId, organizationId)`
 * path `getProjectProcedure` (`projects.get`) uses — passing the RESOLVED
 * org id, never `null`. Passing `null` here would search personal projects
 * only and incorrectly 404 an org member (F2).
 *
 * `canEdit` is `project.canPublish`, already resolved by `getProjectProcedure`
 * via `resolveEffectiveProjectPermissions` (Task 4a) — never a raw
 * `project.userRole` string check. Topic *creation* itself re-derives its
 * tenant tuple from the Project row (`resolveProjectTenant`), so it never
 * depends on this loader (F2).
 */

import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PublishingSuiteList } from "@saas/projects/components/publishing-suite";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string; organizationSlug: string }>;
};

export default async function OrganizationPublishingSuitePage({
	params,
}: Props) {
	// The client UI-rollout flag still gates here (removed in slice 3, when
	// Layer 0 moves to runtime resolution). Checked first because it needs no
	// data access.
	if (process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE !== "true") {
		notFound();
	}

	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id, organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		notFound();
	}

	// The server gate resolves against THIS organization. It cannot run before
	// the organization is resolved, which is why it no longer sits above the
	// session read.
	if (!(await isFeatureEnabled("PUBLISHING_SUITE", organization.id))) {
		notFound();
	}

	let projectResult: Awaited<ReturnType<typeof orpcClient.projects.get>>;
	try {
		// F2: resolve with the ACTIVE org id — never `null` — so an org
		// member authorized only via their org role (no explicit
		// `ProjectMember` row) is found via org access instead of 404ing.
		projectResult = await orpcClient.projects.get({
			id,
			organizationId: organization.id,
		});
	} catch {
		notFound();
	}

	return (
		<PublishingSuiteList
			projectId={id}
			organizationId={organization.id}
			canEdit={projectResult.project.canPublish ?? false}
		/>
	);
}
