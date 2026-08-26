import { getSession } from "@saas/auth/lib/server";
import { TemplateInstanceDetail } from "@saas/reports/components/TemplateInstanceDetail";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ instanceId: string }>;
};

export default async function InstanceDetailPage({ params }: Props) {
	const session = await getSession();
	const { instanceId } = await params;

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
					{ label: "Instance" },
				]}
			/>
			<TemplateInstanceDetail
				instanceId={instanceId}
				basePath="/app/report-templates"
			/>
		</div>
	);
}
