import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listPendingStateChangesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pending-state-changes",
		tags: ["Projects", "PM Sync"],
		summary: "List pending PM state changes",
		description:
			"Get pending ADO state change proposals for a project with pagination",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			status: z
				.enum(["PENDING", "APPROVED", "DISMISSED"])
				.optional()
				.default("PENDING"),
			limit: z.number().int().min(1).max(100).optional().default(50),
			offset: z.number().int().min(0).optional().default(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const where = {
			projectId: input.projectId,
			status: input.status,
		};

		const [changes, total] = await Promise.all([
			db.pendingPmStateChange.findMany({
				where,
				orderBy: { createdAt: "desc" },
				take: input.limit,
				skip: input.offset,
			}),
			db.pendingPmStateChange.count({ where }),
		]);

		return { changes, total };
	});
