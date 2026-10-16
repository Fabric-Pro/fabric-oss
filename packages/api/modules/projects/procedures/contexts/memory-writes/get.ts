/**
 * `projects.contexts.memoryWrites.get` — the receipt of a Living Memory write:
 * where it stands and how it ended (ADR-022).
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then CONTEXT_READ,
 * then the hosting organization resolved server-side (`resolveContextSyncAccess`),
 * the same as the write folders' `list`: a read-only member sees the receipts of
 * the project. A receipt that is not this project's is `NOT_FOUND`, the same
 * answer as one that does not exist.
 *
 * Answers the status (`PENDING` until the workflow settles it), the typed
 * outcome (`null` while pending: a commit, a pull request, per-path verdicts
 * for a conflict or a refusal, or a failure code), the folder and mode the
 * write was admitted against, the paths and operations of the write, and the
 * timestamps. No file content, no message and no staged key.
 */
import { ORPCError } from "@orpc/client";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { getMemoryWriteView } from "../../../lib/memory-write/memory-write-views";
import { resolveContextSyncAccess } from "../repository-sync/access";

export const getMemoryWriteProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/memory-writes/:writeId",
		tags: ["Projects", "Contexts"],
		summary: "Get a Living Memory write",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			writeId: z.string().min(1).max(128),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_READ,
		);
		const view = await getMemoryWriteView({
			writeId: input.writeId,
			projectId: input.projectId,
			organizationId,
		});
		if (!view) {
			throw new ORPCError("NOT_FOUND", { message: "Write not found" });
		}
		return view;
	});
