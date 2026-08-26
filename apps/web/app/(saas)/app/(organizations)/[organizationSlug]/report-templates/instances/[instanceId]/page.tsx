"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { TemplateInstanceDetail } from "@saas/reports/components/TemplateInstanceDetail";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
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

	const basePath = `${orgBasePath}/report-templates`;

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
					{ label: "Report Templates", href: basePath },
					{ label: "Instance" },
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
