/**
 * A topic's Planning & Analysis prose — save an edit, and read its history
 * (Publishing Suite Phase 2A-4 follow-on, Fizzy #1851).
 *
 * Same read/write asymmetry as `topic-decisions.ts` and `planning-analysis.ts`,
 * for the same reason: `listAnalysisRevisionsProcedure` deliberately omits
 * `requireEligibleProjectForTopic()`. That ratchet also filters on
 * `status: "ACTIVE", deletedAt: null` — right for a write, which must not
 * start new work on a project that is gone, but wrong for a read: it would
 * 404 the Planning & Analysis tab's version history on an archived project
 * while the tab's own current-state read (`getPlanningAnalysisProcedure`,
 * which carries no such check either) kept rendering, leaving the page's own
 * panels disagreeing about whether the project exists. Reads stay
 * permissive; writes ratchet — saving a revision is new work, and must be
 * refused the same way starting a new analysis run is.
 *
 * `saveAnalysisRevisionProcedure` takes the ratchet, matching
 * `generatePlanningAnalysisProcedure`. The concurrency control (compare-and-set
 * on the current version) and the `sourceAnalysisVersion` existence check both
 * live inside `saveAnalysisRevision` itself, under the same project lock —
 * this procedure only translates the five outcomes that helper can return into
 * the right oRPC error. Every one of them must be mapped: falling through to
 * the default would turn "somebody else saved first" into a 500, which reads
 * to the caller as "the server is broken" instead of "refresh and try again".
 *
 * Both reads (and the write's own lookups) are scoped by `{ topicId,
 * projectId }`, so a topic id belonging to another project yields the same
 * empty or not-found answer a nonexistent topic id produces — this endpoint
 * pair cannot be used to probe for topics in projects the caller cannot see
 * (DV16).
 */

import { ORPCError } from "@orpc/client";
import { listAnalysisRevisions, saveAnalysisRevision } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { recordAnalysisRevisionOutcome } from "../../lib/publishing-outcome";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * Bound on a saved revision body.
 *
 * The same 40,000 the two long-form siblings in this directory use
 * (`blog-post.ts`, `case-study.ts`); `stakeholder-email.ts` is deliberately
 * lower at 24,000 because an email a person will actually send is short, and
 * that reasoning does not transfer — a planning analysis is a working document
 * of eight headed sections, the same shape as the drafts those two cap. It
 * exists to stop an unbounded write reaching a `@db.Text` column on an
 * append-only table that keeps every revision forever, not to impose a house
 * style. It is also one of the two factors that bound a history response:
 * `listAnalysisRevisions` pages the rows, this caps each row, and only both
 * together make that endpoint bounded — the page carries whole bodies.
 *
 * Deliberately NO `.min(1)`, unlike those siblings. An emptied document is a
 * legitimate authoring decision here — telling "somebody removed this on
 * purpose" apart from "nobody has written it yet" is the distinction the
 * whole feature is built on, and a floor of one character would make the
 * first of those unsavable.
 */
const BODY_MAX = 40000;

export const saveAnalysisRevisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/analysis-revisions",
		tags: ["Projects", "Publishing Suite"],
		summary: "Save a revision of a topic's planning analysis prose",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			body: z.string().max(BODY_MAX),
			expectedVersion: z.number().int().nonnegative().nullable(),
			sourceAnalysisVersion: z.number().int().positive(),
			changeSummary: z.string().max(200).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// Security ratchet, identical to generatePlanningAnalysis: the middleware
		// proved the caller is authorized for THIS project, never that the org
		// they named owns it. The tenant comes from the loaded Project row, and
		// `input.organizationId` is a guard only.
		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		const result = await saveAnalysisRevision({
			topicId: input.topicId,
			projectId: project.id,
			body: input.body,
			expectedVersion: input.expectedVersion,
			sourceAnalysisVersion: input.sourceAnalysisVersion,
			changeSummary: input.changeSummary ?? null,
			authorUserId: context.user.id,
		});

		switch (result.status) {
			case "saved":
				// Measurement only (Fizzy #1851 A9). Saving prose over the
				// AI's analysis is a human editing AI output, which is the
				// verdict `ACCEPTED_WITH_EDITS` exists for — one row per
				// revision, so the count is the revision count.
				await recordAnalysisRevisionOutcome({
					topicId: input.topicId,
					projectId: project.id,
					organizationId: project.organizationId,
					userId: context.user.id,
					revisionVersion: result.version,
					sourceAnalysisVersion: input.sourceAnalysisVersion,
				});
				return { saved: true as const, version: result.version };
			case "conflict":
				// Not a failure: nothing is wrong, the caller is acting on a view
				// that moved. Same register as the sibling in short-post.ts.
				throw new ORPCError("CONFLICT", {
					message:
						"The analysis changed while you were editing. Refresh and try again.",
				});
			case "unknown_source_version":
				throw new ORPCError("BAD_REQUEST", {
					message:
						"That analysis version no longer exists. Refresh and try again.",
				});
			case "not_found":
				throw new ORPCError("NOT_FOUND", {
					message: "Topic not found",
				});
			case "project_ineligible":
				throw new ORPCError("NOT_FOUND", {
					message: "Project not found",
				});
		}
	});

export const listAnalysisRevisionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/{topicId}/analysis-revisions",
		tags: ["Projects", "Publishing Suite"],
		summary: "List a topic's planning analysis revision history",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * The oldest version the caller already holds; the next page is
			 * strictly below it. A version, not an opaque token — see the
			 * keyset note on `listAnalysisRevisions`.
			 *
			 * Unvalidatable against this topic on purpose. A cursor naming a
			 * version that never existed, or one from another topic, yields an
			 * empty page rather than an error: it is a position in an ordering,
			 * not a claim about a row, and rejecting it would let a caller probe
			 * which versions exist.
			 */
			cursor: z.number().int().positive().optional(),
			/** Page size. The query clamps too, for non-oRPC callers. */
			limit: z.number().int().min(1).max(100).optional(),
		}),
	)
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// No project-eligibility ratchet (see module doc): the scoping that
		// matters for isolation — {topicId, projectId} inside the query below —
		// stays; requireProjectPermission above already proved the caller is
		// authorized for this project.
		const { revisions, nextCursor } = await listAnalysisRevisions({
			topicId: input.topicId,
			projectId: input.projectId,
			cursor: input.cursor,
			limit: input.limit,
		});

		// `nextCursor` is part of the contract even when null, so a client can
		// tell "no more pages" from "this server does not page" without
		// inspecting the row count against a limit it may not have sent.
		return { revisions, nextCursor };
	});
