import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization } from "@saas/auth/lib/server";
import { ReportTemplatesHub } from "@saas/reports/components/ReportTemplatesHub";
import { redirect } from "next/navigation";

export default async function OrganizationReportTemplatesPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// With the report suite on, templates and reports are managed from each
	// project's Reports tab. Only this list page moves: template, instance and
	// new-template pages stay reachable, since notification emails link to
	// report instances.
	if (await isFeatureEnabled("REPORT_SUITE_V2", organization.id)) {
		redirect(`/app/${organizationSlug}/projects`);
	}

	return <ReportTemplatesHub />;
}
