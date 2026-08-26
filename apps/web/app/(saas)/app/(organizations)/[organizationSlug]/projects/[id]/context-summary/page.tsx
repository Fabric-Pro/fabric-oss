/**
 * Context Summary full-page reader (organization context).
 *
 * Server component: resolves session + params + the active organization from
 * the slug, fetches the project's current COMPLETED summary via the
 * tenant-scoped `getLatestCompletedContextSummary`, and renders it in a
 * comfortable full-page layout. Feature-flagged: a direct hit while the feature
 * is off (or with no summary) redirects back to the project's Context tab.
 */

import {
	getLatestCompletedContextSummary,
	getProjectNameById,
	parseSummaryReferences,
} from "@repo/database";
import { isContextSummarizationEnabled } from "@repo/utils/feature-flag";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ContextSummaryPageView } from "@saas/projects/components/ContextSummaryPageView";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string; id: string }>;
};

export default async function OrganizationContextSummaryPage({
	params,
}: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug, id: projectId } = await params;

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		redirect("/app");
	}

	const backHref = `/app/${organizationSlug}/projects/${projectId}?tab=context`;

	if (!isContextSummarizationEnabled()) {
		redirect(backHref);
	}

	const summary = await getLatestCompletedContextSummary({
		projectId,
		userId: session.user.id,
		organizationId: organization.id,
	});
	if (!summary) {
		redirect(backHref);
	}

	const projectName = await getProjectNameById(
		projectId,
		session.user.id,
		organization.id,
	);
	if (!projectName) {
		redirect(backHref);
	}

	return (
		<>
			<TopRightControls />
			<ContextSummaryPageView
				backHref={backHref}
				summary={{
					projectId,
					projectName,
					content: summary.content,
					coveredThrough: summary.coveredThrough.toISOString(),
					coveredContextCount: summary.coveredContextCount,
					updatedAt: summary.updatedAt.toISOString(),
					summaryId: summary.id,
					organizationId: organization.id,
					references: parseSummaryReferences(summary.references),
				}}
			/>
		</>
	);
}
