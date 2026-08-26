/**
 * Daily Brief — Mark-Read Procedure
 *
 * Single-transaction upsert of DailyBriefView AND ProjectBriefCursor. Idempotent.
 * Advances the caller's per-user cursor so the "since my last review" filter
 * has a valid anchor on next page load.
 */
import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const markReadProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			briefId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorize via project.
		const project = await db.project.findFirst({
			where: organizationId
				? { id: input.projectId, organizationId }
				: {
						id: input.projectId,
						organizationId: null,
						userId: context.user.id,
					},
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Confirm the brief belongs to this project.
		const brief = await db.dailyBrief.findFirst({
			where: { id: input.briefId, projectId: input.projectId },
			select: { id: true },
		});
		if (!brief) {
			throw new ORPCError("NOT_FOUND", { message: "Brief not found" });
		}

		const now = new Date();

		await db.$transaction(async (tx) => {
			await tx.dailyBriefView.upsert({
				where: {
					dailyBriefId_userId: {
						dailyBriefId: input.briefId,
						userId: context.user.id,
					},
				},
				create: {
					dailyBriefId: input.briefId,
					userId: context.user.id,
					organizationId: project.organizationId ?? null,
				},
				update: { viewedAt: now },
			});

			await tx.projectBriefCursor.upsert({
				where: {
					projectId_userId: {
						projectId: input.projectId,
						userId: context.user.id,
					},
				},
				create: {
					projectId: input.projectId,
					userId: context.user.id,
					organizationId: project.organizationId ?? null,
					lastReviewedAt: now,
				},
				update: { lastReviewedAt: now },
			});
		});

		return { success: true, lastReviewedAt: now };
	});
