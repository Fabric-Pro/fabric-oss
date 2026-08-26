import { getSession } from "@saas/auth/lib/server";
import { CreateInstanceForm } from "@saas/reports/components/CreateInstanceForm";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string; templateId: string }>;
};

export default async function CreateInstancePage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug, templateId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const basePath = `/app/${organizationSlug}/report-templates`;

	return (
		<div className="w-full py-6 space-y-6">
			<PageBreadcrumbs
				items={[
					{
						label: "Report Templates",
						href: basePath,
					},
					{
						label: "Template",
						href: `${basePath}/${templateId}`,
					},
					{ label: "New Instance" },
				]}
			/>
			<CreateInstanceForm templateId={templateId} basePath={basePath} />
		</div>
	);
}
