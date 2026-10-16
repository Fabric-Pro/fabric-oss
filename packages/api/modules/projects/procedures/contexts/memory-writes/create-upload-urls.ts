/**
 * `projects.contexts.memoryWrites.createUploadUrls` — signed URLs to stage the
 * files of a Living Memory write straight into storage (ADR-022).
 *
 * A request body cannot carry a whole write (Vercel Function bodies are capped
 * at 4.5 MB), so a write stages its files first and names them in `submit`,
 * the way the Coding Instructions uploads do (`create-upload-urls.ts` there):
 * the same bucket and the same signed PUT, under
 * `memory-writes/<projectId>/<uuid>`. One URL is signed per file, for text of
 * at most the file bound (2 MiB), and the declared size is part of the
 * signature, so a URL cannot be used for a larger object. The URL expires
 * quickly (`createMemoryWriteUploadUrls`); nothing is registered, because a
 * staged file is nothing until `submit` names it, and `submit` reads it back
 * and checks its size and SHA-256 before it admits anything.
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then CONTEXT_CREATE,
 * then the hosting organization resolved server-side (`resolveContextSyncAccess`).
 */
import { ORPCError } from "@orpc/client";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { createMemoryWriteUploadUrls } from "../../../lib/memory-write/create-memory-write-upload-urls";
import { memoryWriteUploadFilesField } from "../../../lib/memory-write/memory-write-input";
import { resolveContextSyncAccess } from "../repository-sync/access";

export const createMemoryWriteUploadUrlsProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/memory-writes/upload-urls",
		tags: ["Projects", "Contexts"],
		summary:
			"Signed upload URLs to stage the files of a Living Memory write",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			files: memoryWriteUploadFilesField,
		}),
	)
	.handler(async ({ input, context }) => {
		await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_CREATE,
		);
		const result = await createMemoryWriteUploadUrls(input);
		if (!result) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "Storage provider does not support presigned uploads",
			});
		}
		return result;
	});
