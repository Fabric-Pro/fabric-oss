import { getActiveOrganization } from "@saas/auth/lib/server";
import { TimeReport } from "@saas/time-tracking/components/TimeReport";
import { notFound } from "next/navigation";

export const metadata = {
	title: "Time reports",
};

/**
 * Organization settings → Time reports: everyone's time on the organization's
 * projects, a month at a time. The menu offers it to administrators and
 * owners, who alone hold the report permission; anyone else who opens the URL
 * gets the report's own no-access state from the server's refusal.
 */
export default async function OrgTimeReportsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		notFound();
	}

	return (
		<TimeReport
			scope={{ kind: "organization", organizationId: organization.id }}
		/>
	);
}
