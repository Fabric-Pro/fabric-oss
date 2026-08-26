import { SubscriptionSubjectTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertSubjectInProject, isSubscribed } from "../lib/subscriptions";

/**
 * Whether the caller is subscribed to a document or feature. Cheap point
 * lookup used to re-hydrate the toggle when the detail payload's seeded
 * `isSubscribed` may be stale (e.g. after a mutation elsewhere).
 */
export const getSubscriptionStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/subscriptions/status",
		tags: ["Subscriptions"],
		summary: "Get subscription status for an item",
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
		await assertSubjectInProject({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			projectId: input.projectId,
		});

		const subscribed = await isSubscribed({
			userId: context.user.id,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
		});
		return { subscribed };
	});
