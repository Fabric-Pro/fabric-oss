import { getProjectNameById } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ProjectCreationWizard } from "@saas/projects/components/ProjectCreationWizard";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function NewProjectPage({
	params,
	searchParams,
}: {
	params: Promise<{ organizationSlug: string }>;
	searchParams: Promise<{ step?: string; projectId?: string }>;
}) {
	const session = await getSession();
	const { organizationSlug } = await params;
	const { step, projectId } = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// The unified wizard renders directly at `projects/new` — there is no
	// New-vs-Existing chooser (unified-project-setup spec §4.1). Resume/edit is
	// preserved: a valid `?projectId=` or a `?step=` short-circuits the
	// fresh-start path so progress is restored. A genuine fresh visit (neither
	// present) flags `freshStart` so the wizard drops any stale sessionStorage
	// snapshot before it can race `draftKey` into a duplicate DRAFT (§11).
	const projectName = projectId
		? await getProjectNameById(projectId, session.user.id, organization.id)
		: null;
	const isEditMode = !!projectId && !!projectName;
	const isContinuingWizard = !!step;
	const isFreshStart = !isEditMode && !isContinuingWizard;

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
					isEditMode
						? {
								label: projectName as string,
								href: `/app/${organizationSlug}/projects/${projectId}`,
							}
						: { label: "New Project" },
				]}
				className="mb-6"
			/>
			<ProjectCreationWizard
				organizationId={organization.id}
				initialStep={step ? Number.parseInt(step, 10) : undefined}
				projectId={projectId}
				freshStart={isFreshStart}
			/>
		</div>
	);
}
