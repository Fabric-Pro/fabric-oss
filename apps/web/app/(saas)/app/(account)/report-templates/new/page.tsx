import { getSession } from "@saas/auth/lib/server";
import { ReportTemplateForm } from "@saas/reports/components/ReportTemplateForm";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { redirect } from "next/navigation";

export default async function NewReportTemplatePage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 px-6 space-y-6">
			<PageBreadcrumbs
				items={[
					{
						label: "Report Templates",
						href: "/app/report-templates",
					},
					{ label: "New Template" },
				]}
			/>
			<ReportTemplateForm basePath="/app/report-templates" />
		</div>
	);
}
