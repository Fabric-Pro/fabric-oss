import { getSession } from "@saas/auth/lib/server";
import { CreateInstanceForm } from "@saas/reports/components/CreateInstanceForm";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ templateId: string }>;
};

export default async function CreateInstancePage({ params }: Props) {
	const session = await getSession();
	const { templateId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<PageBreadcrumbs
				items={[
					{
						label: "Report Templates",
						href: "/app/report-templates",
					},
					{
						label: "Template",
						href: `/app/report-templates/${templateId}`,
					},
					{ label: "New Instance" },
				]}
			/>
			<CreateInstanceForm
				templateId={templateId}
				basePath="/app/report-templates"
			/>
		</div>
	);
}
