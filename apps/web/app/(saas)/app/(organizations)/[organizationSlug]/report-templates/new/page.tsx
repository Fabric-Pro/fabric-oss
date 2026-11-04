"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ReportTemplateForm } from "@saas/reports/components/ReportTemplateForm";
import { useReportProjectContext } from "@saas/reports/hooks/use-report-project-context";
import { projectReportsHref } from "@saas/reports/lib/project-report-suite";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";

export default function OrganizationNewReportTemplatePage() {
	const {
		organizationId,
		organizationName,
		basePath: orgBasePath,
	} = useOrganizationContext();

	const basePath = `${orgBasePath}/report-templates`;
	const projectId = useReportProjectContext();
	const backHref = projectId
		? projectReportsHref(orgBasePath, projectId)
		: basePath;

	return (
		<div className="w-full py-6 px-6 space-y-6">
			<PageBreadcrumbs
				items={[
					...(organizationId
						? [
								{
									label: organizationName ?? "Organization",
									href: orgBasePath,
								},
							]
						: []),
					{
						label: projectId
							? "Project reports"
							: "Report Templates",
						href: backHref,
					},
					{ label: "New Template" },
				]}
			/>
			<ReportTemplateForm
				basePath={basePath}
				organizationId={organizationId ?? undefined}
				projectId={projectId}
				backHref={backHref}
			/>
		</div>
	);
}
