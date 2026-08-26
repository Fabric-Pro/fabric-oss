import { getReportTemplate } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { ReportTemplateForm } from "@saas/reports/components/ReportTemplateForm";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{ templateId: string }>;
};

export default async function EditReportTemplatePage({ params }: Props) {
	const session = await getSession();
	const { templateId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const template = await getReportTemplate({
		id: templateId,
		userId: session.user.id,
	});
	if (!template) {
		notFound();
	}

	return (
		<div className="w-full py-6 space-y-6">
			<PageBreadcrumbs
				items={[
					{
						label: "Report Templates",
						href: "/app/report-templates",
					},
					{ label: template.name },
				]}
			/>
			<ReportTemplateForm
				templateId={templateId}
				basePath="/app/report-templates"
			/>
		</div>
	);
}
