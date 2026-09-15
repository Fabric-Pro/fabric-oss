/**
 * List Stage Transition Requests
 *
 * AUTHORIZATION: requireProjectPermission(STORY_READ) — project-scoped.
 *
 * Governed projects record drafting-stage transitions as requests awaiting
 * an approver (plan Slice 5). This lists them for the inbox and the story
 * workspace. Tenant scope comes from the project; the database function
 * already restricts by `projectId`.
 */

import { listStageTransitionRequests } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

const stageRequestStatusSchema = z.enum([
	"PENDING",
	"APPROVED",
	"REJECTED",
	"SUPERSEDED",
]);

export const listStageRequestsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/stage-requests",
		tags: ["Projects", "Features", "Governance"],
		summary: "List drafting-stage transition requests",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			status: z
				.union([
					stageRequestStatusSchema,
					z.array(stageRequestStatusSchema),
				])
				.optional(),
			storyId: z.string().optional(),
			limit: z.number().int().min(1).max(200).optional(),
		}),
	)
	.handler(async ({ input }) => {
		const requests = await listStageTransitionRequests({
			projectId: input.projectId,
			status: input.status,
			storyId: input.storyId,
			limit: input.limit,
		});
		return { requests };
	});
