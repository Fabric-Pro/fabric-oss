import { ORPCError } from "@orpc/client";
import {
	dismissFinding,
	listFindings,
	mergeFindings,
	parseAnalysisDiff,
	promoteFindingToBug,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/**
 * Findings — the distinct failures a project's CI keeps reporting.
 *
 * A finding is the observation, a bug is the decision to act on it. That split
 * is the whole reason this surface exists: most failures are not worth a backlog
 * item, and a list that files one for each is a list nobody reads.
 */

const FINDING_STATUSES = ["OPEN", "RESOLVED", "PROMOTED", "IGNORED"] as const;

/**
 * This project's findings, most recently seen first. Read-gated by
 * TEST_CASE_READ; `requireProjectPermission` is the tenant boundary and the
 * query re-scopes by projectId.
 */
export const listQaFindingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa/findings",
		tags: ["Projects", "Test Cases"],
		summary: "List distinct CI failures tracked for this project",
	})
	.input(
		z.object({
			projectId: z.string(),
			status: z.enum(FINDING_STATUSES).optional(),
			limit: z.number().int().min(1).max(200).optional(),
			/**
			 * Narrow to the failures that belong to ONE feature, for the feature
			 * QA tab: results are associated with the feature or case the tool's
			 * API linked them to. Excludes failures Fabric tracks no case
			 * for — those cannot be attributed to a feature and stay on the
			 * project-level list.
			 */
			storyId: z.string().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const findings = await listFindings({
			projectId: input.projectId,
			storyId: input.storyId,
			status: input.status,
			limit: input.limit,
		});
		// `analysisDiff` is a Json column, so it leaves the database as `unknown`.
		// Narrowed HERE rather than in the component: this is the last server-side
		// point that can reject a malformed row, and the alternative — parsing in
		// the client — would mean shipping the validator into the browser bundle
		// from `@repo/database`, which drags Prisma with it.
		return findings.map((finding) => ({
			...finding,
			analysisDiff: parseAnalysisDiff(finding.analysisDiff),
		}));
	});

/**
 * Turn a finding into a tracked BUG.
 *
 * Write-gated by TEST_CASE_UPDATE. Deliberately a person's action rather than
 * something ingestion does: auto-filing every failure is how a backlog stops
 * being read, and the finding list exists precisely so a failure can be seen
 * without being triaged.
 *
 * Idempotent — promoting twice returns the first bug rather than opening a
 * second, so a double-click cannot litter the backlog.
 */
export const promoteQaFindingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/findings/{findingId}/promote",
		tags: ["Projects", "Test Cases"],
		summary: "Promote a finding to a tracked bug",
	})
	.input(z.object({ projectId: z.string(), findingId: z.string() }))
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		const user = context.user;

		let result: Awaited<ReturnType<typeof promoteFindingToBug>>;
		try {
			result = await promoteFindingToBug({
				projectId: input.projectId,
				findingId: input.findingId,
				createdById: user.id,
			});
		} catch (err) {
			// The query throws only when the finding is not in this project — the
			// projectId is in its WHERE, so a foreign id matches nothing. Surface
			// that as a 404 rather than a 500: it is a caller mistake (or a probe),
			// not a server fault.
			logger.warn("qa.finding.promote_failed", {
				projectId: input.projectId,
				findingId: input.findingId,
				userId: user.id,
				error: err instanceof Error ? err.message : String(err),
			});
			throw new ORPCError("NOT_FOUND", {
				message: "Finding not found in this project",
			});
		}

		// Only audit an actual promotion. A repeat click changed nothing, and a
		// ledger that records no-ops is a ledger people learn to skim.
		if (!result.alreadyPromoted) {
			// Through `recordAuditFromRequest`, not `recordAudit`: its
			// `resolveActor` is what fills the actor's email and name from the
			// request, and without them the audit log renders this as `system`
			// rather than as the person who pressed the button. It also carries
			// the ip / user agent / request id / session id a SOC 2 reader
			// expects on a human action. The owning organization is derived from
			// `projectId` in the write path.
			recordAuditFromRequest(context, {
				action: "story.created",
				category: "story",
				severity: "info",
				outcome: "success",
				projectId: input.projectId,
				resource: { type: "story", id: result.storyId },
				metadata: {
					source: "PIPELINE_FAILURE",
					promotedFromFindingId: input.findingId,
				},
			});
		}

		return result;
	});

/**
 * Stop tracking a finding the team has decided not to act on.
 *
 * Separate from `RESOLVED`, which ingestion writes when the test passes again.
 * A dismissal is a judgement, and collapsing the two would let "we chose to
 * ignore this" render identically to "this is fixed".
 */
export const dismissQaFindingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/findings/{findingId}/dismiss",
		tags: ["Projects", "Test Cases"],
		summary: "Dismiss a finding without marking it resolved",
	})
	.input(z.object({ projectId: z.string(), findingId: z.string() }))
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();

		let result: Awaited<ReturnType<typeof dismissFinding>>;
		try {
			result = await dismissFinding({
				projectId: input.projectId,
				findingId: input.findingId,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("qa.finding.dismiss_failed", {
				projectId: input.projectId,
				findingId: input.findingId,
				userId: context.user.id,
				error: message,
			});
			// A promoted finding is a refusal the caller can act on, not a missing
			// row — saying "not found" would send them looking for the wrong thing.
			throw new ORPCError(
				message.includes("promoted") ? "BAD_REQUEST" : "NOT_FOUND",
				{
					message: message.includes("promoted")
						? "This finding already has a bug. Close the bug instead."
						: "Finding not found in this project",
				},
			);
		}

		if (!result.alreadyDismissed) {
			recordAuditFromRequest(context, {
				action: "project.qa_finding.dismissed",
				category: "project",
				severity: "info",
				outcome: "success",
				projectId: input.projectId,
				resource: { type: "project", id: input.projectId },
				metadata: { findingId: input.findingId },
			});
		}

		return result;
	});

/**
 * Fold duplicate findings into one.
 *
 * Exists because fingerprints are computed at insert: rows written before a
 * fingerprint change keep their old hash forever, so one fault can sit in the
 * list as several rows each reading "Seen 1 time". A backfill would have to
 * guess which rows were the same fault; the person reading the list knows.
 */
export const mergeQaFindingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/findings/{findingId}/merge",
		tags: ["Projects", "Test Cases"],
		summary: "Merge duplicate findings into one",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** The row that survives and accumulates the others' occurrences. */
			findingId: z.string(),
			// Capped: this is a hand-made selection from a list that shows at most
			// 200, and an unbounded array here would be an unbounded transaction.
			duplicateIds: z.array(z.string()).min(1).max(50),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();

		let result: Awaited<ReturnType<typeof mergeFindings>>;
		try {
			result = await mergeFindings({
				projectId: input.projectId,
				primaryId: input.findingId,
				duplicateIds: input.duplicateIds,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("qa.finding.merge_failed", {
				projectId: input.projectId,
				findingId: input.findingId,
				userId: context.user.id,
				error: message,
			});
			throw new ORPCError(
				message.includes("promoted") ? "BAD_REQUEST" : "NOT_FOUND",
				{
					message: message.includes("promoted")
						? "A finding that already has a bug cannot be merged away."
						: "Finding not found in this project",
				},
			);
		}

		if (result.mergedCount > 0) {
			recordAuditFromRequest(context, {
				action: "project.qa_finding.merged",
				category: "project",
				severity: "info",
				outcome: "success",
				projectId: input.projectId,
				resource: { type: "project", id: input.projectId },
				metadata: {
					primaryFindingId: result.primaryId,
					mergedFindingIds: input.duplicateIds,
					mergedCount: result.mergedCount,
				},
			});
		}

		return result;
	});
