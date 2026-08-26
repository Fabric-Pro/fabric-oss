import { ORPCError } from "@orpc/client";
import { hasProjectAccess, setWorkingNotes } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * `maturation.setWorkingNotes` — persist the human-owned Tab-1 Notes
 * (`workingNotesContent`). Notebook model: Notes are the PO's own source of
 * intent; the AI reads them but never writes them, so this is the ONLY writer.
 *
 * PM-SYNC ISOLATION (§7.7): writes ONLY `workingNotesContent`, never
 * `description`/`acceptanceCriteria` — does not touch the dev-facing Clean Spec
 * and must not trigger PM sync. This file does not import `enqueuePmSync`.
 */
export const setWorkingNotesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/working-notes",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Save the human-owned Tab-1 Notes",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Empty string clears the notes; cap matches a generous notebook.
			content: z.string().max(50_000),
		}),
	)
	.output(z.object({ saved: z.boolean() }))
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

		const trimmed = input.content.trim();
		const count = await setWorkingNotes({
			userStoryId: input.storyId,
			projectId: input.projectId,
			workingNotesContent: trimmed.length > 0 ? input.content : null,
		});
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}
		return { saved: true };
	});
