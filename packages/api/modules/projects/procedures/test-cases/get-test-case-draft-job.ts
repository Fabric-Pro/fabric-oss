import { ORPCError } from "@orpc/client";
import {
	getTestCaseDraftJob,
	getTestCaseDraftJobResultCases,
	parseFeatureOutcomes,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * One drafting run: its progress, its per-feature ledger, and the cases it
 * produced.
 *
 * This is what makes a finished batch reviewable and addressable. The run
 * already recorded exactly which cases it created, so the batch is identified by
 * the job rather than by a denormalized marker on every test case — a column
 * that would be written forever to serve a view that matters for minutes.
 */
export const getTestCaseDraftJobProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_CREATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-cases/draft-jobs/{jobId}",
		tags: ["Projects", "Test Cases"],
		summary: "Get one AI test-case drafting run and the cases it created",
	})
	.input(
		z.object({
			projectId: z.string(),
			jobId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_CREATE) gates project
		// access; the job read is scoped to the project so a cross-project job id
		// resolves to NOT_FOUND.
		const job = await getTestCaseDraftJob({
			jobId: input.jobId,
			projectId: input.projectId,
		});
		if (!job || job.requestedById !== context.user.id) {
			// A run belongs to the person who started it — someone else's run is
			// not theirs to read, and saying so would confirm it exists.
			throw new ORPCError("NOT_FOUND", {
				message: "Drafting run not found",
			});
		}

		const cases = await getTestCaseDraftJobResultCases({
			projectId: input.projectId,
			caseIds: job.createdCaseIds,
		});

		return {
			id: job.id,
			status: job.status,
			totalFeatures: job.totalFeatures,
			processedFeatures: job.processedFeatures,
			createdCaseIds: job.createdCaseIds,
			error: job.error,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
			outcomes: parseFeatureOutcomes(job.featureOutcomes),
			cases,
		};
	});
