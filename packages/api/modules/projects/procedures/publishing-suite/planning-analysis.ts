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
	getLatestPlanningAnalysis,
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
	.handler(async ({ input, context }) => {
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
			requestedById: context.user.id,
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
							actorUserId: context.user.id,
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
			await failPlanningAnalysis({
				id: attempt.analysisId,
				projectId: project.id,
				error:
					error instanceof Error
						? `Could not start generation: ${error.message}`
						: "Could not start generation",
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start the planning analysis",
			});
		}

		return {
			started: true as const,
			analysisId: attempt.analysisId,
			version: attempt.version,
		};
	});

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

		// TWO rows, deliberately. `latestReady` is what to render; `latestAttempt`
		// is what to say about it. Collapsing them to "the newest row" would blank
		// a perfectly good analysis the moment a regeneration failed, and hide it
		// again while the next one runs — precisely when a reader most wants the
		// last good one.
		//
		// Both are scoped by projectId inside the helper, so a topic from another
		// project yields the same empty answer a topic with no analysis does. No
		// separate existence check, because one would reintroduce the distinction
		// this deliberately erases.
		const { latestAttempt, latestReady } = await getLatestPlanningAnalysis({
			topicId: input.topicId,
			projectId: input.projectId,
		});

		return { latestAttempt, latestReady };
	});
