/**
 * Daily Brief — Regenerate Procedure
 *
 * Thin authorization + response-shaping wrapper over
 * {@link requestDailyBriefRegeneration}, which owns the idempotent
 * check-then-insert-then-start sequence (in-flight guard, 15-min stale
 * reclaim, 5-min rate limit, GENERATING-row insert, Temporal start).
 *
 * The procedure authorizes via project ownership/membership, then maps the
 * helper's status to this endpoint's stable response:
 *   - `rate_limited`  → TOO_MANY_REQUESTS
 *   - `unavailable`   → SERVICE_UNAVAILABLE
 *   - `started` / `in_flight` → { briefId, workflowId, inFlight }
 */
import { ORPCError } from "@orpc/server";
import {
	DEFAULT_DAILY_BRIEF_WINDOW,
	db,
	timeWindowKindSchema,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requestDailyBriefRegeneration } from "../lib/request-regeneration";

export const regenerateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			timeWindow: timeWindowKindSchema.default(
				DEFAULT_DAILY_BRIEF_WINDOW,
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorize via project ownership/membership.
		const project = await db.project.findFirst({
			where: organizationId
				? { id: input.projectId, organizationId }
				: {
						id: input.projectId,
						organizationId: null,
						userId: context.user.id,
					},
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const result = await requestDailyBriefRegeneration({
			projectId: input.projectId,
			project: {
				organizationId: project.organizationId,
				userId: project.userId,
			},
			triggeredByUserId: context.user.id,
			timeWindow: input.timeWindow,
		});

		if (result.status === "rate_limited") {
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message:
					"A Daily Brief for this project was generated within the last 5 minutes. Try again shortly.",
			});
		}
		if (result.status === "unavailable") {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Temporal is not available",
			});
		}

		// `started` | `in_flight` — reconstruct the endpoint's stable response.
		return {
			briefId: result.brief.id,
			workflowId: result.brief.temporalWorkflowId,
			inFlight: result.status === "in_flight",
		};
	});
