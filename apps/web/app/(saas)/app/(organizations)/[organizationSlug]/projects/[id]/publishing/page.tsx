/**
 * Publishing Suite deep-link page (organization context).
 *
 * Thin server wrapper for the design-locked `/projects/{id}/publishing` route.
 * Availability is decided by ONE gate: `isFeatureEnabled("PUBLISHING_SUITE",
 * organization.id)`. It cannot run before the organization is known, so session
 * resolves first, then the active organization from the `[organizationSlug]`
 * segment, then the gate — off → `notFound()`, still before any project access.
 *
 * There was a second, build-time `NEXT_PUBLIC_*` guard above all of this until
 * the flag became org-scoped. It was removed rather than kept as a belt: a
 * build-time value carries one answer for every organization, so leaving it in
 * place would have meant an enrolled organization could still be refused by a
 * deployment-wide switch nobody would think to look at.
 *
 * The project fetch happens only after that gate passes, through the SAME
 * `getProjectById(id, userId, organizationId)` path `getProjectProcedure`
 * (`projects.get`) uses — passing the RESOLVED org id, never `null`. Passing
 * `null` here would search personal projects only and incorrectly 404 an org
 * member (F2).
 *
 * `canEdit` is `project.canPublish`, already resolved by `getProjectProcedure`
 * via `resolveEffectiveProjectPermissions` — never a raw `project.userRole`
 * string check. Topic *creation* itself re-derives its tenant tuple from the
 * Project row (`resolveProjectTenant`), so it never depends on this loader (F2).
 *
 * The breadcrumb trail lives HERE rather than inside `PublishingSuiteList`,
 * because that component has two mounts: this route, and the `publishing-suite`
 * tab inside `ProjectDetails` — which renders `PageBreadcrumbs` itself. A trail
 * owned by the component would render twice on the tab. This route is the mount
 * with no chrome of its own, so it supplies its own, in the shape the `Testing`
 * tab uses: the project name links back to the project, and the section is the
 * trailing crumb.
 */

import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PublishingSuiteList } from "@saas/projects/components/publishing-suite";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string; organizationSlug: string }>;
};

export default async function OrganizationPublishingSuitePage({
	params,
}: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id, organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		notFound();
	}

	// The only availability gate, and it resolves against THIS organization —
	// which is why it sits below the session and organization reads rather
	// than above them: there is no org id to resolve against until they run.
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

	const basePath = `/app/${organizationSlug}`;

	return (
		<div className="space-y-6">
			{/* "Publishing Suite" is written out rather than read from `tabs`
			    (`lib/project-tabs.ts`), matching how `ProjectDetails` writes
			    "Testing" into the same slot: a crumb names a location to a
			    reader, and the tab strip's own label is free to diverge from it
			    without either becoming wrong. */}
			<PageBreadcrumbs
				items={[
					{ label: "Projects", href: `${basePath}/projects` },
					{
						label: projectResult.project.name,
						href: `${basePath}/projects/${id}`,
					},
					{ label: "Publishing Suite" },
				]}
			/>
			<PublishingSuiteList
				projectId={id}
				organizationId={organization.id}
				canEdit={projectResult.project.canPublish ?? false}
			/>
		</div>
	);
}
