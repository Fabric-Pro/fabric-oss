/**
 * `projects.contexts.memoryWrites.validate` — would this write into a Living
 * Memory write folder be admitted now? (ADR-022)
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then
 * CONTEXT_CREATE, then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`); the request carries no organization.
 *
 * Answers `{ ok, digest, target, problems }`, and reports EVERY problem, each
 * with a closed `code`, a `path` where it is about one, and a `detail` that
 * is a reason word, a rule id or a number. A secret hit names the rule that
 * fired and never the text that matched. `digest` identifies the request: the
 * same project, target version, message and entries digest alike in any
 * order. `target` and `digest` are null only when the target could not be
 * resolved.
 *
 * Only STATIC checks (`evaluateMemoryWrite`). Whether a path is created or
 * replaced, the folder's `.contextignore` at the branch tip and per-path
 * conflicts are the write workflow's, because the tip can move after
 * admission anyway.
 *
 * VALIDATION ONLY: nothing is persisted and nothing is started. Admitting a
 * write arrives with the write workflow.
 */
import { MAX_CONTEXT_FILE_BYTES } from "@repo/temporal/context-sync-rules";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import {
	MAX_MEMORY_WRITE_ENTRIES,
	MAX_MEMORY_WRITE_MESSAGE_LENGTH,
} from "../../../lib/memory-write/evaluate";
import { validateMemoryWrite } from "../../../lib/memory-write/validate-memory-write";
import { resolveContextSyncAccess } from "../repository-sync/access";
import { MAX_CONTEXT_SYNC_PATH_LENGTH } from "../repository-sync/paths";

/**
 * The input bound on one file's text, in characters. A file over
 * `MAX_CONTEXT_FILE_BYTES` is a problem the answer reports (`CONTENT_TOO_LARGE`)
 * rather than a refused request, so this only keeps an unbounded string out of
 * the handler: any text over the file limit in characters is over it in bytes.
 */
const MAX_CONTENT_CHARS = 2 * MAX_CONTEXT_FILE_BYTES;

export const validateMemoryWriteProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/memory-writes/validate",
		tags: ["Projects", "Contexts"],
		summary: "Check a write into a Living Memory write folder",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			targetId: z.string().min(1).max(128),
			message: z.string().min(1).max(MAX_MEMORY_WRITE_MESSAGE_LENGTH),
			entries: z
				.array(
					z.object({
						path: z.string().max(MAX_CONTEXT_SYNC_PATH_LENGTH),
						op: z.enum(["PUT", "DELETE"]),
						content: z.string().max(MAX_CONTENT_CHARS).optional(),
						ifMatchOid: z.string().max(128).optional(),
					}),
				)
				.min(1)
				.max(MAX_MEMORY_WRITE_ENTRIES),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_CREATE,
		);
		return validateMemoryWrite({
			projectId: input.projectId,
			organizationId,
			targetId: input.targetId,
			message: input.message,
			entries: input.entries,
		});
	});
