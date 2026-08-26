"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ReportTemplateForm } from "@saas/reports/components/ReportTemplateForm";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";

export default function OrganizationNewReportTemplatePage() {
	const {
		organizationId,
		organizationName,
		basePath: orgBasePath,
	} = useOrganizationContext();

	const basePath = `${orgBasePath}/report-templates`;

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
					{ label: "Report Templates", href: basePath },
					{ label: "New Template" },
				]}
			/>
			<ReportTemplateForm
				basePath={basePath}
				organizationId={organizationId ?? undefined}
			/>
		</div>
	);
}
