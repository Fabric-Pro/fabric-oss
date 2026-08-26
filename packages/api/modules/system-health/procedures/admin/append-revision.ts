/**
 * Append a progress revision to a published announcement.
 *
 * Auth: `adminProcedure`, same reasoning as publishing.
 *
 * Revisions are append-only by design — no edit or delete path is exposed.
 * Rewriting what customers were already told defeats the purpose of publishing
 * a timeline, so a correction is a new revision, not an edit of an old one.
 */

import { ORPCError } from "@orpc/server";
import { appendStatusUpdateRevision } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { adminProcedure } from "../../../../orpc/procedures";

export const appendStatusRevisionProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/system-health/admin/status-updates/{statusUpdateId}/revisions",
		tags: ["System Health"],
		summary: "Append a progress revision to an announcement",
	})
	.input(
		z.object({
			statusUpdateId: z.string().min(1),
			lifecycle: z.enum([
				"INVESTIGATING",
				"IDENTIFIED",
				"MONITORING",
				"RESOLVED",
				"SCHEDULED",
				"IN_PROGRESS",
				"COMPLETED",
			]),
			body: z.string().trim().min(1).max(10_000),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			await appendStatusUpdateRevision({
				statusUpdateId: input.statusUpdateId,
				lifecycle: input.lifecycle,
				body: input.body,
				authorUserId: context.user.id,
			});
		} catch (error) {
			// The query helper throws a plain Error for a missing parent so it
			// stays free of transport concerns; map it here.
			if (
				error instanceof Error &&
				error.message.startsWith("StatusUpdate not found")
			) {
				throw new ORPCError("NOT_FOUND", {
					message: "Status announcement not found",
				});
			}
			throw error;
		}

		recordAuditFromRequest(context, {
			action: "statusUpdate.revised",
			category: "statusUpdate",
			outcome: "success",
			severity: "info",
			resource: { type: "status_update", id: input.statusUpdateId },
			metadata: { lifecycle: input.lifecycle },
		});

		return { ok: true };
	});
