/**
 * Context Summary full-page reader (personal / account context).
 *
 * Server component: resolves session + params, fetches the project's current
 * COMPLETED summary via the tenant-scoped `getLatestCompletedContextSummary`,
 * and renders it in a comfortable full-page layout. Feature-flagged: a direct
 * hit while the feature is off (or with no summary) redirects back to the
 * project's Context tab.
 */

import {
	getLatestCompletedContextSummary,
	getProjectNameById,
	parseSummaryReferences,
} from "@repo/database";
import { isContextSummarizationEnabled } from "@repo/utils/feature-flag";
import { getSession } from "@saas/auth/lib/server";
import { ContextSummaryPageView } from "@saas/projects/components/ContextSummaryPageView";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string }>;
};

export default async function PersonalContextSummaryPage({ params }: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id: projectId } = await params;
	const backHref = `/app/projects/${projectId}?tab=context`;

	if (!isContextSummarizationEnabled()) {
		redirect(backHref);
	}

	const summary = await getLatestCompletedContextSummary({
		projectId,
		userId: session.user.id,
		organizationId: null,
	});
	if (!summary) {
		redirect(backHref);
	}

	const projectName = await getProjectNameById(projectId, session.user.id);
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
					organizationId: null,
					references: parseSummaryReferences(summary.references),
				}}
			/>
		</>
	);
}
