/**
 * Publishing Suite deep-link page (organization context).
 *
 * Thin server wrapper for the design-locked `/projects/{id}/publishing`
 * route. Gates on the
 * `FABRIC_FEATURE_PUBLISHING_SUITE` server flag FIRST (off → `notFound()`,
 * before touching session/org/project data), then resolves the active
 * organization from the `[organizationSlug]` segment and fetches the
 * project through the SAME `getProjectById(id, userId, organizationId)`
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

import { isPublishingSuiteEnabled } from "@repo/utils/feature-flag";
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
	// Gate on BOTH flags FIRST (before session/org/project access). The server
	// flag (`isPublishingSuiteEnabled()`) gates the backend; the client
	// UI-rollout flag (`NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE`) is what
	// hides the tab + onboarding. Honoring it here too means a guessed
	// /publishing URL can't render the full list while the UI is intentionally
	// hidden (server-on / client-off = "backend live, UI hidden"). NOTE:
	// NEXT_PUBLIC_* vars are inlined at build time, so toggling this flag takes
	// effect on the next rebuild/redeploy — same constraint as the tab gate.
	if (
		!isPublishingSuiteEnabled() ||
		process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE !== "true"
	) {
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
