import { getSession } from "@saas/auth/lib/server";
import { ReportTemplatesPageTabs } from "@saas/reports/components/ReportTemplatesPageTabs";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function ReportTemplatesPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 px-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Report Templates" }]} />
			<ReportTemplatesPageTabs basePath="/app/report-templates" />
		</div>
	);
}
