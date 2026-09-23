import { ORPCError } from "@orpc/server";
import { db, isFeatureEnabled } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertCapabilityAvailable } from "../../../capabilities/assert";
import { roadmapRecommendationWorkflowId } from "./workflow-id";

/** Generating recommendations shapes the Roadmap, so it needs project update. */
const RECOMMEND_FEATURES_PERMISSION = Permissions.PROJECT_UPDATE;

const ENTRY_POINTS = [
	"EMPTY_ROADMAP",
	"MATURE_ROADMAP",
	"DO_BOTH_AFTER_PULL",
] as const;

function isNamed(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name;
}

/**
 * Start a roadmap-recommendation run (Fizzy #2208): a background workflow
 * that reads the project's context and live Roadmap and stores 25+ Feature
 * candidates as ONE ROADMAP_RECOMMENDATION batch in the review inbox.
 *
 * Door order: the project (NOT_FOUND) → the ROADMAP_RECOMMENDATIONS flag for
 * the project's organization (off = NOT_FOUND) → a run already in flight
 * (returned as `alreadyRunning`, no gate check) → the
 * `roadmap.recommend-features` capability gate → the workflow start.
 *
 * The organization is always the project's own; the input carries none.
 */
export const generateRecommendationsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(RECOMMEND_FEATURES_PERMISSION))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/recommendations",
		tags: ["Projects", "Backlog"],
		summary: "Recommend Features from project context",
		description:
			"Starts a background run that proposes new Roadmap Features from the project's context, delivered to the review inbox as one batch.",
	})
	.input(
		z.object({
			projectId: z.string(),
			entryPoint: z.enum(ENTRY_POINTS),
		}),
	)
	.output(
		z.object({
			workflowId: z.string(),
			alreadyRunning: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const enabled = await isFeatureEnabled(
			"ROADMAP_RECOMMENDATIONS",
			project.organizationId ?? undefined,
		);
		if (!enabled) {
			throw new ORPCError("NOT_FOUND", { message: "Not found" });
		}

		const workflowId = roadmapRecommendationWorkflowId(input.projectId);
		const client = await getTemporalClient();

		try {
			const description = await client.workflow
				.getHandle(workflowId)
				.describe();
			if (description.status.name === "RUNNING") {
				return { workflowId, alreadyRunning: true };
			}
		} catch (error) {
			if (!isNamed(error, "WorkflowNotFoundError")) {
				throw error;
			}
		}

		await assertCapabilityAvailable({
			capabilityKey: "roadmap.recommend-features",
			projectId: input.projectId,
			userId: context.user.id,
			organizationId: project.organizationId,
		});

		try {
			await client.workflow.start(
				"roadmapRecommendationWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					workflowIdReusePolicy: "ALLOW_DUPLICATE",
					workflowIdConflictPolicy: "FAIL",
					// Read back by `recommendationStatus` while the run is too
					// new to answer its progress query.
					memo: { entryPoint: input.entryPoint },
					args: [
						{
							projectId: input.projectId,
							userId: context.user.id,
							organizationId: project.organizationId ?? undefined,
							entryPoint: input.entryPoint,
							requestedAt: new Date().toISOString(),
						},
					],
				}),
			);
		} catch (error) {
			if (isNamed(error, "WorkflowExecutionAlreadyStartedError")) {
				return { workflowId, alreadyRunning: true };
			}
			logger.error("[RoadmapRecommendation] Failed to start run", {
				projectId: input.projectId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start the recommendation run",
			});
		}

		logger.info("[RoadmapRecommendation] Run started", {
			projectId: input.projectId,
			workflowId,
			entryPoint: input.entryPoint,
		});
		return { workflowId, alreadyRunning: false };
	});
