import { countPendingBacklogProposals } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Count of FAILED PendingBacklogProposal rows for a project across every
 * source (Teams / Slack / AI Update sidebar). Surfaces how many proposals
 * need a retry from the Review proposals inbox's Failed group; consumers
 * refetch it after retry / dismiss outcomes to stay fresh without a page
 * reload.
 *
 * AUTHORIZATION + tenancy: `requireProjectPermission(PROJECT_UPDATE)` is the
 * tenant guard — it verifies the caller may edit this project within their
 * org/personal context (the Failed banner exposes retry/dismiss actions). The
 * count then filters by `projectId` alone, mirroring the working
 * `countPendingProposalsProcedure` (the "Review N proposals" pill).
 *
 * IMPORTANT: this deliberately does NOT re-do a
 * `db.project.findFirst({ organizationId, userId })` lookup. That pattern
 * required the caller to be the project's creator (`project.userId` is the
 * creator, not every org member), so it threw `NOT_FOUND` (404) for
 * ORG-SHARED projects any other member opened — the identical bug fixed for
 * the Backlog count in #1867. `requireProjectPermission` already enforces the
 * correct org-membership access, so the extra lookup only added a false 404.
 */
export const getFailedProposalsCountProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/proposals/failed-count",
		tags: ["Projects", "Backlog"],
		summary: "Count failed backlog proposals",
		description:
			"Count of PendingBacklogProposal rows in FAILED state for the project.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			count: z.number(),
		}),
	)
	.handler(async ({ input }) => {
		const count = await countPendingBacklogProposals(input.projectId, [
			"FAILED",
		]);
		return { count };
	});
