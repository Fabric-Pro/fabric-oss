import { db } from "@repo/database";
import { SubscriptionSubjectTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertSubjectInProject } from "../lib/subscriptions";

/**
 * Opt in to change notifications for a document or feature. Idempotent: a
 * repeat subscribe is a no-op (upsert on the `(userId, subjectType, subjectId)`
 * unique). Read access to the parent project is required — enforced by
 * `requireProjectPermission(PROJECT_READ)`, which reads `projectId` from input.
 */
export const subscribeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/subscriptions",
		tags: ["Subscriptions"],
		summary: "Subscribe to a document or feature",
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
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// PROJECT_READ proves access to input.projectId, not that the subject
		// lives there — verify the linkage so we can't write an orphan watch row
		// against a project the caller can't access.
		await assertSubjectInProject({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			projectId: input.projectId,
		});

		await db.subscription.upsert({
			where: {
				userId_subjectType_subjectId: {
					userId: context.user.id,
					subjectType: input.subjectType,
					subjectId: input.subjectId,
				},
			},
			create: {
				userId: context.user.id,
				organizationId,
				subjectType: input.subjectType,
				subjectId: input.subjectId,
			},
			// The scope may have drifted (e.g. a personal project moved into an
			// org); keep the stored organizationId current on re-subscribe.
			update: { organizationId },
			select: { id: true },
		});

		return { subscribed: true as const };
	});
