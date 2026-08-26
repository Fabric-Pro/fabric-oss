import { listBackgroundJobsForUser } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { getJobRetentionDays } from "../lib/retention";

const listInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	limit: z.number().min(1).max(100).default(50),
});

/**
 * Background jobs for the Job Hub panel: everything currently running plus
 * anything that finished inside the retention window, newest first.
 *
 * Deliberately one indexed query with no per-job fan-out — the panel polls
 * every few seconds while a job is running, and the dashboard's history of
 * fanning a single poll into a dozen queries is not one to repeat.
 *
 * `requireInputOrgPermission` (not the plain `requirePermission`) because the
 * organization arrives from the client: it must be proven to be one the caller
 * belongs to before it is used as a filter.
 */
export const listJobsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/jobs",
		tags: ["Jobs"],
		summary: "List active and recent background jobs",
	})
	.input(listInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;

		const jobs = await listBackgroundJobsForUser({
			filter: { userId: context.user.id, organizationId },
			retentionDays: getJobRetentionDays(),
			limit: input.limit,
		});

		return {
			jobs: jobs.map((job) => ({
				id: job.id,
				kind: job.kind,
				status: job.status,
				title: job.title,
				sourceType: job.sourceType,
				sourceId: job.sourceId,
				counts: job.counts,
				steps: job.steps,
				error: job.error,
				errorClass: job.errorClass,
				projectId: job.projectId,
				projectName: job.projectName,
				startedAt: job.startedAt.toISOString(),
				completedAt: job.completedAt?.toISOString() ?? null,
			})),
			retentionDays: getJobRetentionDays(),
		};
	});
