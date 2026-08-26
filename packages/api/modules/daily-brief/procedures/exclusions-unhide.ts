/**
 * Daily Brief — Unhide Release-Note Procedure (Fizzy 1869 follow-up).
 *
 * Symmetric to `hideReleaseNoteProcedure`: hard-deletes a per-project
 * release-notes exclusion by id, records the `unhidden` audit row atomically
 * (`recordAuditTx` inside `db.$transaction`), and best-effort regenerates the
 * VIEWED brief window so the restored PR/story reappears immediately.
 *
 * The exclusion is HARD-deleted, so the audit resource/metadata are captured
 * from the PRE-DELETE row (`deleteReleaseNoteExclusion` returns it) — those
 * target details no longer exist in the table after the delete. Both the
 * audit and the regeneration are gated on an ACTUAL delete (`deleted === true`)
 * so a no-op unhide of a missing row writes no audit and forces no regen.
 */
import { ORPCError } from "@orpc/server";
import {
	db,
	deleteReleaseNoteExclusion,
	recordAuditTx,
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

const inputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	id: z.string(),
	// The window the user is viewing — regenerate THAT brief.
	timeWindow: timeWindowKindSchema.optional(),
});

export const unhideReleaseNoteProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Re-fetch under the resolved tenant scope: a foreign-tenant caller
		// gets NOT_FOUND, and the delete's tenant columns come from the VERIFIED
		// project, never from raw input.
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

		const tenant = {
			projectId: project.id,
			organizationId: project.organizationId ?? null,
			userId: project.userId,
		};

		const result = await db.$transaction(async (tx) => {
			const deletion = await deleteReleaseNoteExclusion(
				tx,
				tenant,
				input.id,
			);
			// Audit is gated on an ACTUAL delete: a no-op unhide of a missing
			// row (deleted === false) emits no audit row. The PRE-DELETE row
			// supplies the target details that no longer exist after the hard
			// delete.
			if (deletion.deleted) {
				await recordAuditTx(tx, {
					action: "dailyBrief.releaseNote.unhidden",
					actor: {
						type: "user",
						userId: context.user.id,
						emailSnapshot: context.user.email,
						nameSnapshot: context.user.name,
					},
					organizationId: tenant.organizationId,
					projectId: tenant.projectId,
					resource: {
						type: "daily_brief_release_note_exclusion",
						id: deletion.row.id,
						name: deletion.row.targetKey,
					},
					metadata: {
						kind: deletion.row.kind,
						targetKey: deletion.row.targetKey,
					},
				});
			}
			return deletion;
		});

		// Regenerate ONLY on an actual delete (deleted === true). A no-op unhide
		// of a missing row must NOT force a regen (force bypasses the rate
		// limit).
		if (result.deleted) {
			// Best-effort — never fails or rolls back the persisted delete.
			try {
				await requestDailyBriefRegeneration({
					projectId: project.id,
					project: {
						organizationId: tenant.organizationId,
						userId: tenant.userId,
					},
					triggeredByUserId: context.user.id,
					force: true,
					// Regenerate the VIEWED window (helper defaults if absent).
					// CUSTOM has no fixed start/end (resolveTimeWindow
					// throws), so normalize it to the helper's default preset
					// — the exclusion is window-agnostic at generation time,
					// so a default-window regen still applies it rather than
					// throwing into the best-effort catch and starting
					// nothing.
					timeWindow:
						input.timeWindow === "CUSTOM"
							? undefined
							: input.timeWindow,
				});
			} catch {
				/* swallow — delete persists; the forced regen / workflow self-rerun applies it */
			}
		}

		return { deleted: result.deleted };
	});
