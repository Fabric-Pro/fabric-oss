import { ORPCError } from "@orpc/server";
import { db, rejectNewsletterSend } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { classifyReviewOutcome } from "../lib/review-outcome";

/** Mirrors the approve path: name the state the row is actually in (#2172). */
function reviewConflict(message: string, currentStatus: string | null) {
	return new ORPCError("CONFLICT", { message, data: { currentStatus } });
}

export const rejectSendProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
			reason: z.string().max(500).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
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
		// Guard cross-project sendId before the transition. `status` rides along
		// so a stale row is classified here rather than after a pointless
		// no-op transaction (#2172).
		const owned = await db.newsletterSend.findFirst({
			where: { id: input.sendId, projectId: input.projectId },
			select: { id: true, status: true },
		});
		if (!owned) {
			throw new ORPCError("NOT_FOUND", { message: "Send not found" });
		}
		const preflight = classifyReviewOutcome("reject", owned.status);
		if (preflight.kind === "incompatible") {
			throw reviewConflict(preflight.message, owned.status);
		}
		if (preflight.kind === "satisfied") {
			// Already rejected, or expired out from under the reviewer. Either
			// way the draft will not be sent — which is what they asked for.
			return {
				sendId: input.sendId,
				rejected: true,
				outcome: "already_resolved" as const,
				notice: preflight.notice,
			};
		}
		const { rejected } = await rejectNewsletterSend({
			sendId: input.sendId,
			reason: input.reason ?? null,
			audit: {
				reviewedByUserId: context.user.id,
				actorEmail: context.user.email ?? null,
				actorName: context.user.name ?? null,
				organizationId: project.organizationId ?? null,
				projectId: input.projectId,
			},
		});
		if (!rejected) {
			// Raced between the preflight and the conditional update. Re-read to
			// report what the row actually became.
			const current = await db.newsletterSend.findFirst({
				where: { id: input.sendId, projectId: input.projectId },
				select: { status: true },
			});
			const raced = classifyReviewOutcome(
				"reject",
				current?.status ?? "",
			);
			if (raced.kind === "satisfied") {
				return {
					sendId: input.sendId,
					rejected: true,
					outcome: "already_resolved" as const,
					notice: raced.notice,
				};
			}
			throw reviewConflict(
				raced.kind === "incompatible"
					? raced.message
					: "This newsletter was decided by someone else while you were reviewing it.",
				current?.status ?? null,
			);
		}
		return {
			sendId: input.sendId,
			rejected: true,
			outcome: "rejected" as const,
			notice: null,
		};
	});
