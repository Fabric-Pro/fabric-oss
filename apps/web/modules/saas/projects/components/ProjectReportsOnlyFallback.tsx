"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ui/components/skeleton";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { isProjectNotFound } from "./ProjectUnavailable";
import { ProjectReadinessPanel } from "./readiness/ProjectReadinessPanel";

const ProjectReports = dynamic(
	() => import("./ProjectReports").then((m) => m.ProjectReports),
	{
		loading: () => <Skeleton className="h-96 w-full rounded-lg" />,
		ssr: false,
	},
);

/**
 * What the project page shows when `projects.get` found no project for this
 * caller. An organization admin or owner, or a system admin who is a member,
 * inherits Project Editor on the reports of every live project, so they get its
 * Reports tab even with no project row. The other tabs' procedures still refuse
 * them, so only that tab is offered. Everyone else gets `unavailable`.
 */
export function ProjectReportsOnlyFallback({
	projectId,
	error,
	unavailable,
}: {
	projectId: string;
	error: unknown;
	unavailable: ReactNode;
}) {
	const { organizationId, basePath } = useOrganizationContext();
	const reportSuite = useFeatureFlag("REPORT_SUITE_V2");
	const enabled =
		reportSuite && organizationId !== null && isProjectNotFound(error);
	const { data, isLoading } = useQuery({
		...orpc.reports.project.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled,
		retry: false,
	});

	if (enabled && isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-32 w-full rounded-lg" />
				<Skeleton className="h-96 w-full rounded-lg" />
			</div>
		);
	}
	const project = enabled ? data?.project : undefined;
	if (!project) {
		return unavailable;
	}

	return (
		<div className="space-y-6">
			<PageBreadcrumbs
				items={[
					{
						label: "Projects",
						href: `${basePath}/projects`,
					},
					{ label: project.name },
					{ label: "Reports" },
				]}
			/>
			<header className="space-y-2">
				<h1 className="font-normal font-serif text-3xl text-foreground">
					{project.name}
				</h1>
				<p className="max-w-2xl text-muted-foreground text-sm">
					You have this project's reports through your organization
					role. Its other pages are for the project's members, so ask
					a project admin to add you if you need them.
				</p>
			</header>
			<ProjectReadinessPanel />
			<ProjectReports projectId={project.id} />
		</div>
	);
}
