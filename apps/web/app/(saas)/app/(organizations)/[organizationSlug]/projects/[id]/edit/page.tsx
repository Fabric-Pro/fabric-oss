/**
 * Edit a live project's basics (Fizzy #2247).
 *
 * The counterpart to the simplified creation form: the same four fields, asked
 * of a project that already exists. It writes name, brief, phase and expected
 * development start date and nothing else — the project's status is never
 * touched, and everything the old wizard collected beyond these lives in the
 * project's own tabs and settings.
 *
 * Two gates, both server-side and both resolved before anything renders:
 * `SIMPLIFIED_PROJECT_CREATION`, because this screen only exists as part of
 * that flow, and the caller's own update permission, so a member who may read
 * a project but not change it never reaches an edit form at all. `projects.get`
 * already computes that permission, so this asks the same source the mutation
 * will, rather than a second opinion that could disagree with it.
 */

import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { SimplifiedProjectForm } from "@saas/projects/components/SimplifiedProjectForm";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

export default async function EditProjectPage({
	params,
}: {
	params: Promise<{ organizationSlug: string; id: string }>;
}) {
	const session = await getSession();
	const { organizationSlug, id } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// Off, this screen does not exist: the wizard is still the edit surface,
	// and the header button still routes there.
	if (
		!(await isFeatureEnabled(
			"SIMPLIFIED_PROJECT_CREATION",
			organization.id,
		))
	) {
		notFound();
	}

	const result = await orpcClient.projects
		.get({ id, organizationId: organization.id })
		.catch(() => null);

	const project = result?.project;

	if (!project) {
		notFound();
	}

	if (!project.canUpdateProject) {
		// Not a 404: the project is one they can see, they simply cannot change
		// it. Sending them to the project itself is both truthful and useful.
		redirect(`/app/${organizationSlug}/projects/${id}`);
	}

	// A DRAFT has never been created, so it belongs in the creation flow, which
	// knows how to resume and then activate it.
	if (project.status === "DRAFT") {
		redirect(`/app/${organizationSlug}/projects/new?projectId=${id}`);
	}

	return (
		<div className="w-full py-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: organization.name,
						href: `/app/${organizationSlug}`,
					},
					{
						label: "Projects",
						href: `/app/${organizationSlug}/projects`,
					},
					{
						label: project.name,
						href: `/app/${organizationSlug}/projects/${id}`,
					},
					{ label: "Edit" },
				]}
				className="mb-6"
			/>
			<SimplifiedProjectForm
				organizationId={organization.id}
				projectId={id}
				mode="edit"
			/>
		</div>
	);
}
