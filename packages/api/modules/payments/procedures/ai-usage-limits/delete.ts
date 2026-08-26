/**
 * `aiUsageLimits.delete` — soft-archive a single AiUsageLimit row.
 * +:
 * - Soft delete (sets `archivedAt = now`) — counters remain on disk for
 * historical reporting. The partial-unique index in
 * only enforces uniqueness for live (`archivedAt IS NULL`)
 * rows, so a future limit with the same scope can be created.
 * - Org context: `requireOrganizationAdmin` (owner | admin only).
 * - XOR re-check via `findFirst` before the write — cross-tenant access
 * (org admin trying to archive a personal limit, or vice versa) →
 * `NOT_FOUND` (not `FORBIDDEN`, to avoid leaking the existence of a
 * row in the other tenant scope).
 * - Audit log fired on success via the `[AuditLog]` precedent.
 * Exported as `delete_` because `delete` is a reserved keyword; the
 * router re-exposes it as `delete`
 * Per [`backend/api.md`] §"Procedure Structure", §"Authorization Pattern";
 * [`global/error-handling.md`] §"ORPCError"; [`backend/queries.md`]
 * §"Explicit `select`".
 */
import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	requireOrganizationAdmin,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

interface DeleteResult {
	archived: true;
}

export const delete_ = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/payments/ai-usage-limits/delete",
		tags: ["Payments"],
		summary: "Archive an AI usage limit",
		description:
			"Soft-deletes the AiUsageLimit row by setting `archivedAt`. Counters are preserved for historical reporting. Org context requires owner/admin.",
	})
	.input(inputSchema)
	.handler(
		async ({
			input,
			context: { user, session },
		}): Promise<DeleteResult> => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				session,
			);

			if (organizationId) {
				await requireOrganizationAdmin(organizationId, user.id).catch(
					() => {
						throw new ORPCError("FORBIDDEN", {
							message:
								"Only organization owners or admins can manage AI usage limits",
						});
					},
				);
			}

			// XOR re-check before the write. Returning NOT_FOUND on a
			// cross-tenant attempt avoids leaking the existence of a row in
			// the other tenant scope.
			const existing = await db.aiUsageLimit.findFirst({
				where: {
					id: input.id,
					...(organizationId
						? { organizationId, userId: null }
						: { userId: user.id, organizationId: null }),
					archivedAt: null,
				},
				select: { id: true },
			});

			if (!existing) {
				throw new ORPCError("NOT_FOUND", {
					message: "AI usage limit not found",
				});
			}

			await db.aiUsageLimit.update({
				where: { id: input.id },
				data: { archivedAt: new Date() },
			});

			// Audit log — fire-and-forget per.
			try {
				logger.info(
					{
						event: "aiUsageLimit.delete",
						limitId: input.id,
						tenant: organizationId ?? user.id,
						organizationId: organizationId ?? null,
						userId: organizationId ? null : user.id,
						by: user.id,
					},
					`[AuditLog] AiUsageLimit delete id=${input.id} tenant=${organizationId ?? user.id} by=${user.id}`,
				);
			} catch (error) {
				console.warn(
					"[AuditLog] Failed to log AI usage limit delete:",
					error,
				);
			}

			return { archived: true };
		},
	);
