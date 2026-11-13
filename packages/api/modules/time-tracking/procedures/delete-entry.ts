import { ORPCError } from "@orpc/server";
import { deleteTimeEntry, findTimeEntryForAuthor } from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	assertProjectPermission,
	Permissions,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertProjectVisible } from "../lib/project-access";

export const deleteTimeEntryInputSchema = z.object({
	entryId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * Delete one of the caller's own time entries. Someone else's entry answers
 * NOT_FOUND, exactly as a missing one does. The caller must still see the
 * entry's project and hold TIME_LOG on it; the project is only known once the
 * entry is loaded, so both checks run in the handler.
 */
export const deleteTimeEntryProcedure = tenantProtectedProcedure
	.route({
		method: "DELETE",
		path: "/time-tracking/entries/{entryId}",
		tags: ["Time tracking"],
		summary: "Delete a logged time entry",
		description: "Deletes one of the caller's own time entries.",
	})
	.input(deleteTimeEntryInputSchema)
	.handler(async ({ input, context }) => {
		const existing = await findTimeEntryForAuthor({
			id: input.entryId,
			userId: context.user.id,
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Time entry not found",
			});
		}
		await assertProjectVisible(existing.projectId, context.user.id);
		await assertProjectPermission(
			existing.projectId,
			context.user.id,
			Permissions.TIME_LOG,
		);

		const deleted = await deleteTimeEntry({
			id: existing.id,
			userId: context.user.id,
		});
		if (!deleted) {
			throw new ORPCError("NOT_FOUND", {
				message: "Time entry not found",
			});
		}
		return { id: existing.id, deleted: true };
	});
