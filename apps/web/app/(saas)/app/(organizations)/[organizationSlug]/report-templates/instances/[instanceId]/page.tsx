"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { TemplateInstanceDetail } from "@saas/reports/components/TemplateInstanceDetail";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { use } from "react";

type Props = {
	params: Promise<{ instanceId: string }>;
};

export default function OrganizationInstanceDetailPage({ params }: Props) {
	const { instanceId } = use(params);
	const {
		organizationId,
		organizationName,
		basePath: orgBasePath,
	} = useOrganizationContext();
	const reportSuite = useFeatureFlag("REPORT_SUITE_V2");

	const basePath = `${orgBasePath}/report-templates`;

	// Same query as the detail below, so it is served from the cache. A
	// project's report links back to that project's Reports tab.
	const { data: instance } = useQuery({
		...orpc.reports.instances.get.queryOptions({
			input: {
				id: instanceId,
				organizationId: organizationId ?? undefined,
			},
		}),
		enabled: reportSuite,
	});
	const projectId = reportSuite ? instance?.projectId : null;

	return (
		<div className="w-full py-6 space-y-6">
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
					projectId
						? {
								label: "Project reports",
								href: `${orgBasePath}/projects/${projectId}?tab=reports`,
							}
						: { label: "Report Templates", href: basePath },
					{ label: instance?.name ?? "Instance" },
				]}
			/>
			<TemplateInstanceDetail
				instanceId={instanceId}
				basePath={basePath}
				organizationId={organizationId ?? undefined}
			/>
		</div>
	);
}
