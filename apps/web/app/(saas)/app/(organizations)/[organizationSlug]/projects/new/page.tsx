import { getProjectSummaryById, isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ProjectCreationWizard } from "@saas/projects/components/ProjectCreationWizard";
import { SimplifiedProjectForm } from "@saas/projects/components/SimplifiedProjectForm";
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

	// Resolved server-side, and deliberately never mirrored into a
	// NEXT_PUBLIC_ variable: those are inlined at build time, which would put
	// the rollback lever back behind a redeploy (Fizzy #2247).
	const simplifiedCreation = await isFeatureEnabled(
		"SIMPLIFIED_PROJECT_CREATION",
		organization.id,
	);

	// Both paths need the project's name for the breadcrumb; the simplified
	// path also needs its status, to tell an unfinished DRAFT from a project
	// that is already live. `null` covers "no such project" and "no access"
	// alike, which is the behaviour we want at both call sites.
	const project = projectId
		? await getProjectSummaryById(
				projectId,
				session.user.id,
				organization.id,
			)
		: null;
	const projectName = project?.name ?? null;

	// An ACTIVE project has nothing to do on a creation form. The old "Edit
	// Project" link sends one here with `?step=1`, which is the
	// requirements/code mismatch the card names; it now lands on the edit
	// screen, which asks for the same four fields against the live project.
	// Gated on the flag so that turning the flag off restores the previous
	// route behaviour exactly, byte for byte.
	if (simplifiedCreation && project && project.status !== "DRAFT") {
		redirect(`/app/${organizationSlug}/projects/${project.id}/edit`);
	}

	// The unified wizard renders directly at `projects/new` — there is no
	// New-vs-Existing chooser (unified-project-setup spec §4.1). Resume/edit is
	// preserved: a valid `?projectId=` or a `?step=` short-circuits the
	// fresh-start path so progress is restored. A genuine fresh visit (neither
	// present) flags `freshStart` so the wizard drops any stale sessionStorage
	// snapshot before it can race `draftKey` into a duplicate DRAFT (§11).
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
			{simplifiedCreation ? (
				// `step` is deliberately not passed through: the simplified
				// form is one step, and a legacy `?step=` on the URL means
				// nothing to it.
				<SimplifiedProjectForm
					organizationId={organization.id}
					projectId={isEditMode ? projectId : undefined}
				/>
			) : (
				<ProjectCreationWizard
					organizationId={organization.id}
					initialStep={step ? Number.parseInt(step, 10) : undefined}
					projectId={projectId}
					freshStart={isFreshStart}
				/>
			)}
		</div>
	);
}
