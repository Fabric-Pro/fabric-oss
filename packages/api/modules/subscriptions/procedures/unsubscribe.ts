import { db } from "@repo/database";
import { SubscriptionSubjectTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Opt out of change notifications for a document or feature. Idempotent:
 * deletes the caller's own subscription row if present, no-op otherwise.
 * Scoped to `userId` so a member can only remove their own subscription.
 */
export const unsubscribeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "DELETE",
		path: "/subscriptions",
		tags: ["Subscriptions"],
		summary: "Unsubscribe from a document or feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			subjectType: SubscriptionSubjectTypeSchema,
			subjectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const result = await db.subscription.deleteMany({
			where: {
				userId: context.user.id,
				subjectType: input.subjectType,
				subjectId: input.subjectId,
			},
		});

		return { subscribed: false as const, removed: result.count };
	});
