import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { CreateInstanceForm } from "@saas/reports/components/CreateInstanceForm";
import {
	projectReportsHref,
	withProjectContext,
} from "@saas/reports/lib/project-report-suite";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string; templateId: string }>;
	searchParams: Promise<{ projectId?: string | string[] }>;
};

export default async function CreateInstancePage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	const { organizationSlug, templateId } = await params;
	const { projectId: rawProjectId } = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const orgBasePath = `/app/${organizationSlug}`;
	const basePath = `${orgBasePath}/report-templates`;

	// Opened from a project's Reports tab: the new report belongs to that
	// project, and the page leads back there.
	const organization =
		typeof rawProjectId === "string"
			? await getActiveOrganization(organizationSlug)
			: null;
	const projectId =
		organization &&
		typeof rawProjectId === "string" &&
		(await isFeatureEnabled("REPORT_SUITE_V2", organization.id))
			? rawProjectId
			: undefined;

	return (
		<div className="w-full py-6 space-y-6">
			<PageBreadcrumbs
				items={[
					projectId
						? {
								label: "Project reports",
								href: projectReportsHref(
									orgBasePath,
									projectId,
								),
							}
						: {
								label: "Report Templates",
								href: basePath,
							},
					{
						label: "Template",
						href: withProjectContext(
							`${basePath}/${templateId}`,
							projectId,
						),
					},
					{ label: "New Instance" },
				]}
			/>
			<CreateInstanceForm
				templateId={templateId}
				basePath={basePath}
				projectId={projectId}
			/>
		</div>
	);
}
