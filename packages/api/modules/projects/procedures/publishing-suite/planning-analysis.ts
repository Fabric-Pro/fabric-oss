/**
 * Planning & Analysis — start one run, and read the current state.
 * (Publishing Suite Phase 2A-2, Fizzy #1851.)
 *
 * The write side is a button; the read side is polled while it runs. Both are
 * scoped the same way, and the scoping is the interesting part: neither reads a
 * topic by id alone. `startPlanningAnalysisAttempt` re-scopes to
 * `{ id, projectId }` inside its Project-row lock, and `getLatestPlanningAnalysis`
 * filters both reads by `projectId` — so a real topic id belonging to another
 * project produces exactly the answer a missing one produces, and this endpoint
 * pair cannot be used to probe for topics in projects the caller cannot see
 * (DV16).
 */

import { ORPCError } from "@orpc/client";
import {
	failPlanningAnalysis,
	getEffectivePlanningAnalysis,
	getLatestPlanningAnalysis,
	logDraftRefusal,
	startPlanningAnalysisAttempt,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * Start a planning-analysis run for a topic.
 *
 * Lifted out of the procedure because there are now two ways in: the reader
 * pressing Generate, and a topic being marked SELECTED, which starts one before
 * anybody opens the page. Two copies of the Temporal-availability check, the
 * attempt row and its rollback would be two chances for the rollback to be
 * forgotten in one of them — and a forgotten rollback leaves a GENERATING row
 * holding the partial unique index, refusing every retry until the deadline
 * sweep.
 */
export async function startPlanningAnalysisRun(input: {
	projectId: string;
	topicId: string;
	organizationId?: string | null;
	requestedById: string;
}) {
	await assertPublishingSuiteFeatureEnabled(input.projectId);

	// Security ratchet, identical to generate-now.ts: the permission
	// middleware proved the caller is authorized for THIS project, but it
	// never inspects the org. The tenant is derived from the loaded Project
	// row, and `input.organizationId` is a guard only — never a scoping key.
	const project = await requireEligibleProjectForTopic({
		projectId: input.projectId,
		clientOrganizationId: input.organizationId,
	});

	// Temporal is checked BEFORE the row is created. Creating it first and
	// discovering the outage second would leave a GENERATING row holding the
	// partial unique index, so the button would go on refusing for ten
	// minutes over an outage that may already be over.
	const { isTemporalAvailable } = await import("@repo/temporal");
	if (!(await isTemporalAvailable())) {
		return { started: false as const, reason: "unavailable" as const };
	}

	const attempt = await startPlanningAnalysisAttempt({
		topicId: input.topicId,
		projectId: project.id,
		requestedById: input.requestedById,
	});
	// Two causes, two messages. The helper re-checks the project under its own
	// lock, so it can find the project archived between the ratchet above and
	// the transaction — reporting that as "Topic not found" would send a
	// reader looking for a topic that is perfectly fine.
	if (attempt.status === "project_ineligible") {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	if (attempt.status === "not_found") {
		throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
	}
	if (attempt.status === "in_flight") {
		// A double-click, or a poll that raced the first click. The row the UI
		// is about to poll already exists and a run is filling it.
		return { started: false as const, reason: "in-progress" as const };
	}

	const { getTemporalClient } = await import("@repo/temporal");
	const client = await getTemporalClient();

	try {
		await client.workflow.start(
			"generatePublishingPlanningAnalysisWorkflow",
			{
				taskQueue: "fabric-worker",
				// Keyed on the ATTEMPT, not the topic: each attempt is a distinct
				// row with its own terminal state, and reusing a topic-keyed id
				// would make a second run collide with a finished one's history.
				workflowId: `publishing-topic-pa:${attempt.analysisId}`,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				// Backstop for a run that never finds a worker at all: without it
				// the row would sit GENERATING until the deadline sweep, which is
				// the same ten minutes but with nothing recorded about why.
				workflowExecutionTimeout: "10m",
				args: [
					{
						analysisId: attempt.analysisId,
						topicId: input.topicId,
						projectId: project.id,
						organizationId: project.organizationId ?? null,
						actorUserId: input.requestedById,
					},
				],
			},
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkflowExecutionAlreadyStartedError"
		) {
			return {
				started: false as const,
				reason: "in-progress" as const,
			};
		}

		// Roll the row back, or the UI polls a GENERATING row no workflow will
		// ever complete — and the partial unique index refuses every retry
		// until the deadline sweep clears it.
		// The rollback can itself be refused, and silently dropping that is
		// how a row ends up GENERATING with nothing recorded about why: the
		// caller gets a 500, the panel keeps polling, and the deadline sweep
		// is the only thing that ever clears it. Reported, not retried —
		// every refusal reason means this attempt is no longer ours to write.
		const rollback = await failPlanningAnalysis({
			id: attempt.analysisId,
			projectId: project.id,
			error:
				error instanceof Error
					? `Could not start generation: ${error.message}`
					: "Could not start generation",
		});
		if (!rollback.persisted) {
			logDraftRefusal(
				"[publishing-planning] start rollback skipped",
				rollback.reason,
				{ analysisId: attempt.analysisId, projectId: project.id },
			);
		}
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Could not start the planning analysis",
		});
	}

	return {
		started: true as const,
		analysisId: attempt.analysisId,
		version: attempt.version,
	};
}

export const generatePlanningAnalysisProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/planning-analysis",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate the planning analysis for a topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) =>
		startPlanningAnalysisRun({
			projectId: input.projectId,
			topicId: input.topicId,
			organizationId: input.organizationId,
			requestedById: context.user.id,
		}),
	);

export const getPlanningAnalysisProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/{topicId}/planning-analysis",
		tags: ["Projects", "Publishing Suite"],
		summary: "Get the planning analysis for a topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// TWO reads, deliberately. `latestAttempt` is what to SAY about the
		// analysis — running, failed, stranded past its deadline — and the
		// resolver below is what to RENDER. Collapsing them would blank a
		// perfectly good analysis the moment a regeneration failed, and hide it
		// again while the next one runs — precisely when a reader most wants the
		// last good one.
		//
		// The newest READY row itself is deliberately NOT returned. It was, as
		// `latestReady`, until the web tab moved onto the resolver (Fizzy #1851,
		// Task 11), and a caller that rendered it alongside `effective` would
		// silently ignore the author's own edit.
		//
		// Dropping it NARROWS that path; it does not close it, and reading this
		// as a guarantee would be wrong. `latestAttempt` is selected WITH
		// `content`, and whenever the newest attempt is READY — the steady state
		// — that row IS the newest READY row, so `latestAttempt.content` is the
		// same raw AI JSON `latestReady` used to carry. The web tab reads exactly
		// that, on purpose, as the seed for "replace with the newer analysis".
		// What is gone is the UNCONDITIONAL field: reaching the un-overridden
		// text now means taking it off an attempt row and owning the question of
		// whether that attempt is READY and is the version `aiVersion` names —
		// the check the tab's own `readyRow` guard makes, and the one that keeps
		// the row from being rendered as though it were the document.
		//
		// What a caller legitimately needs from that row travels as SCALARS
		// instead: its version, as the resolver's `aiVersion`, and its
		// provenance, as `aiModel` / `aiPromptSource` below.
		//
		// Both are scoped by projectId inside the helpers, so a topic from another
		// project yields the same empty answer a topic with no analysis does. No
		// separate existence check, because one would reintroduce the distinction
		// this deliberately erases.
		const [{ latestAttempt, latestReady }, resolved] = await Promise.all([
			getLatestPlanningAnalysis({
				topicId: input.topicId,
				projectId: input.projectId,
			}),
			getEffectivePlanningAnalysis({
				topicId: input.topicId,
				projectId: input.projectId,
			}),
		]);

		return {
			latestAttempt,
			// Provenance of the analysis on screen, taken from the READY row and
			// NOT from `latestAttempt`. The two are the same row only while
			// nothing newer has been tried; FAILED and stranded are terminal, so
			// a client that read provenance off the attempt would permanently
			// lose the model name and the prompt note on exactly the analyses a
			// reader is most likely to be scrutinising. Scalars, not the row:
			// they say how the text was produced without carrying the text.
			aiModel: latestReady?.model ?? null,
			// Whether the run fell back to the default prompt body — the one fact
			// about a run a reader cannot recover from the output itself, because
			// an analysis built from the default body because a bound prompt
			// would not render reads exactly like one built from the bound one.
			aiPromptSource: latestReady?.promptSource ?? null,
			// WHEN the analysis on screen was written. The tab compares answers
			// against this to say the document is behind them, and a version
			// number cannot carry that comparison: an amendment changes the
			// answer without changing any version, so equality of versions goes
			// on reading "already folded in" while the decision has just moved.
			aiCreatedAt: latestReady?.createdAt ?? null,
			// Spread, not enumerated: `getEffectivePlanningAnalysis` is the ONE
			// answer to "what is this topic's planning analysis right now", and
			// naming its fields one by one here would let a future field it adds
			// (it already grew `author` and `revisionCreatedAt` once) silently
			// fail to reach this response.
			...resolved,
		};
	});
