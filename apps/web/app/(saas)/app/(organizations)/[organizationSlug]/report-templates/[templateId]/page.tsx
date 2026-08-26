"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ReportTemplateForm } from "@saas/reports/components/ReportTemplateForm";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { use } from "react";

type Props = {
	params: Promise<{ templateId: string }>;
};

export default function OrganizationEditReportTemplatePage({ params }: Props) {
	const { templateId } = use(params);
	const {
		organizationId,
		organizationName,
		basePath: orgBasePath,
		loaded,
	} = useOrganizationContext();

	const basePath = `${orgBasePath}/report-templates`;

	// Fetch template to get its name for breadcrumbs
	// Gate on loaded to prevent sending organizationId: null before org context is ready
	const { data: template, isLoading } = useQuery({
		...orpc.reports.templates.get.queryOptions({
			input: { id: templateId, organizationId: organizationId ?? null },
		}),
		enabled: loaded,
	});

	if (!loaded || isLoading) {
		return (
			<div className="w-full py-6 flex items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (!template) {
		notFound();
	}

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
					{ label: template.name },
				]}
			/>
			<ReportTemplateForm
				templateId={templateId}
				basePath={basePath}
				organizationId={organizationId ?? undefined}
			/>
		</div>
	);
}
