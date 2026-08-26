import { ORPCError } from "@orpc/client";
import { hasProjectAccess, setQuestionStatus } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * `maturation.restoreQuestion` (#5) — reactivate a soft-closed
 * (`POSSIBLY_RESOLVED`) question back to OPEN. The PO uses this when a Clean Spec
 * refresh dropped a question they still consider open. The reverse — soft-closing
 * a question the refresh no longer lists — happens automatically during
 * reconciliation (`extract-maturation-questions.ts`), so this is the one manual
 * lever and it only ever re-opens (it never deletes), preserving recall.
 *
 * PM-SYNC ISOLATION (§7.7): writes ONLY a Decision Log row's status, never
 * `description`/`acceptanceCriteria` — does not touch the Clean Spec, so it must
 * not trigger PM sync. This file does not import `enqueuePmSync`.
 */
export const restoreQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/restore-question",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Re-open a soft-closed (possibly-resolved) question",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** The question thread root id to re-open. */
			questionRootId: z.string(),
		}),
	)
	.output(z.object({ restored: z.boolean() }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const count = await setQuestionStatus({
			tenantFilter: {
				organizationId: organizationId ?? null,
				userId: context.user.id,
			},
			rootId: input.questionRootId,
			status: "OPEN",
		});
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", { message: "Question not found" });
		}
		return { restored: true };
	});
