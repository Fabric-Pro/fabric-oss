/**
 * `projects.contexts.memoryWrites.submit` — write files into a Living Memory
 * write folder (ADR-022): admit the request, store its receipt and start the
 * workflow that commits it or opens a pull request.
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then CONTEXT_CREATE,
 * then the hosting organization resolved server-side (`resolveContextSyncAccess`);
 * the request carries no organization.
 *
 * Each PUT names its file one of two ways: inline `content` (all of a request's
 * inline text together at most 3 MiB), or a file staged through `createUploadUrls`
 * as `{stagedKey, sha256, bytes}`. The server reads staged files back and checks
 * their size and hash, stages inline text itself, and judges the request on the
 * real bytes (`admitMemoryWrite`: every static rule of `validate`, plus the
 * bytes). A request that cannot be admitted is `BAD_REQUEST` with `data.problems`
 * (every problem, not the first) and writes no receipt.
 *
 * An admitted request stores a receipt, with the folder, mode, branch and
 * repository integration frozen, and starts `memory-write-<writeId>`. An
 * identical request from the same member that is in flight or landed (within two
 * hours) returns its receipt with `deduplicated: true` instead of writing twice;
 * a member with five writes pending in the project is refused
 * (`TOO_MANY_PENDING_WRITES`, 429). Audited as
 * `project.context.memory_write_submitted`. Answers `{writeId, status, digest,
 * deduplicated}`; the outcome is read with `get`.
 *
 * The admission, the receipt and the workflow start are `submitMemoryWriteRequest`,
 * shared with the CLI's REST route and the MCP tool; this is the app's door.
 */
import { ORPCError } from "@orpc/client";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { memoryWriteSubmitFields } from "../../../lib/memory-write/memory-write-input";
import { submitMemoryWriteRequest } from "../../../lib/memory-write/submit-memory-write-request";
import { resolveContextSyncAccess } from "../repository-sync/access";

export const submitMemoryWriteProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/memory-writes",
		tags: ["Projects", "Contexts"],
		summary: "Write files into a Living Memory write folder",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			...memoryWriteSubmitFields,
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_CREATE,
		);

		const result = await submitMemoryWriteRequest({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			via: "APP",
			oauthClientId: null,
			targetId: input.targetId,
			message: input.message,
			entries: input.entries,
			audit: context,
		});
		switch (result.kind) {
			case "refused":
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This write cannot be admitted. Every problem is in data.problems.",
					data: {
						code: "MEMORY_WRITE_REFUSED",
						problems: result.problems,
					},
				});
			case "too-many-pending":
				throw new ORPCError("TOO_MANY_REQUESTS", {
					message: `At most ${result.limit} of your writes can be pending in a project. Wait for one to finish.`,
					data: {
						code: "TOO_MANY_PENDING_WRITES",
						limit: result.limit,
					},
				});
			case "start-failed":
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "The write could not be started. Try again.",
					data: { code: "WORKFLOW_START_FAILED" },
				});
			case "accepted":
				return {
					writeId: result.writeId,
					status: result.status,
					digest: result.digest,
					deduplicated: result.deduplicated,
				};
			default: {
				const unreachable: never = result;
				return unreachable;
			}
		}
	});
