import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { TimeReport } from "@saas/time-tracking/components/TimeReport";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

export const metadata = {
	title: "Time report",
};

/**
 * A project's time report, opened from Project settings → Time tracking.
 * Who may read it is the report procedure's decision: a member without the
 * report permission sees the report's no-access state rather than a second,
 * client-side opinion of it.
 */
export default async function ProjectTimeReportPage({
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

	const result = await orpcClient.projects
		.get({ id, organizationId: organization.id })
		.catch(() => null);

	const project = result?.project;

	if (!project) {
		notFound();
	}

	return (
		<div className="w-full space-y-6 py-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: "Projects",
						href: `/app/${organizationSlug}/projects`,
					},
					{
						label: project.name,
						href: `/app/${organizationSlug}/projects/${id}?tab=settings&settingsTab=time-tracking`,
					},
					{ label: "Time report" },
				]}
			/>
			<TimeReport
				scope={{
					kind: "project",
					projectId: id,
					organizationId: organization.id,
				}}
			/>
		</div>
	);
}
