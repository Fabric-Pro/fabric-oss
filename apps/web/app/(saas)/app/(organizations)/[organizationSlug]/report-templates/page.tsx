"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ReportTemplatesPageTabs } from "@saas/reports/components/ReportTemplatesPageTabs";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";

export default function OrganizationReportTemplatesPage() {
	const {
		organizationId,
		organizationName,
		basePath: orgBasePath,
	} = useOrganizationContext();

	const basePath = `${orgBasePath}/report-templates`;

	return (
		<div className="w-full py-6 px-6 space-y-6">
			<TopRightControls />
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
					{ label: "Report Templates" },
				]}
			/>
			<ReportTemplatesPageTabs
				basePath={basePath}
				organizationId={organizationId ?? undefined}
			/>
		</div>
	);
}
