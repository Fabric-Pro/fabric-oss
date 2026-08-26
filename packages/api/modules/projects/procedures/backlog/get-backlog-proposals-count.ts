import { countPendingBacklogProposals } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Count of BACKLOG PendingBacklogProposal rows for a project across every
 * source (Teams / Slack / AI Update sidebar / monitored meeting). Backs the
 * Roadmap "Backlog (N)" pill — a deferred-proposal entry point that stays
 * reachable even when the pending count is zero, so a reviewer who backlogged
 * everything can still return to their backlog from the Roadmap. Consumers
 * refetch it after backlog / approve / reject outcomes to stay fresh without a
 * page reload.
 *
 * AUTHORIZATION + tenancy: `requireProjectPermission(PROJECT_READ)` is the
 * tenant guard — it verifies the caller may read this project within their
 * org/personal context. The count then filters by `projectId` alone, mirroring
 * the working `countPendingProposalsProcedure` (the "Review N proposals" pill).
 *
 * IMPORTANT: this deliberately does NOT re-do a
 * `db.project.findFirst({ organizationId, userId })` lookup. That pattern (still
 * present in the sibling `get-failed-proposals-count`) 404s for ORG-SHARED
 * projects the caller did not personally create — `project.userId` is the
 * creator, not every org member — which is exactly why the Backlog pill 404'd
 * on staging for org projects. `requireProjectPermission` already enforces the
 * correct org-membership access, so the extra lookup only adds a false 404.
 */
export const getBacklogProposalsCountProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/proposals/backlog-count",
		tags: ["Projects", "Backlog"],
		summary: "Count backlogged proposals",
		description:
			"Count of PendingBacklogProposal rows in BACKLOG state for the project.",
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
			"BACKLOG",
		]);
		return { count };
	});
