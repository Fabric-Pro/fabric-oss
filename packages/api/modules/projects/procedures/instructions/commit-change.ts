import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { MAX_CHANGES } from "./change-set";
import { assertRepositoryWritable } from "./read-only-guard";
import { submitInstructionChange } from "./submit-change";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE), and the same live check again
 * inside `submitInstructionChange` (`mode: "commit"`).
 *
 * "Commit to <branch>" (Fizzy #2878 §10): a member with write rights commits a
 * change straight to a repository-backed project's synced branch, as they would
 * with git. The change is derived, validated and secret-scanned like any other
 * (so no git write can precede the scan), and the response returns the
 * snapshot at once; what became of the commit arrives on that snapshot.
 *
 * ## What the caller polls
 *
 * `get` (and `list`) on the returned `snapshotId` carry `status` and
 * `commitOutcome`. While `commitOutcome` is null the commit is pending (or the
 * scan is still running); a snapshot whose `status` is `REJECTED` was refused
 * by the scan with its findings in `rejection`, and nothing was pushed.
 * `commitOutcome` is exactly one of:
 *
 * - `{ outcome: "committed", sha, ref }`
 * - `{ outcome: "unchanged", sha }`: the branch already held this content
 * - `{ outcome: "pull-request", operationId, reason: "protected" | "busy" }`:
 *   the same change was opened as a pull request on the member's branch; its
 *   URL and state are the snapshot's ordinary `pullRequest` block
 *   (`instructions.proposals.getPullRequestStatus`)
 * - `{ outcome: "branch-moved" }`: a teammate changed one of these files on the
 *   branch since the base; nothing was written
 * - `{ outcome: "failed", code, retryable }`
 *
 * Only a repository-backed project accepts it (`NOT_REPOSITORY_SOURCED`,
 * 412), only with `INSTRUCTION_CREATE` (a reader is refused with 403 whatever
 * the project's proposal opt-in), never while the project is in Read-only mode
 * (CONFLICT, `data.errorCode` `PROJECT_READ_ONLY`: a commit is a write against
 * a connected external source), and the commit message is the committer's own
 * words, refused as 422 naming `message` (never quoting it) when empty, too
 * long, or carrying what looks like a credential. The author is the member's
 * display name with the deployment's `noreply@` address; the committer is
 * Fabric.
 *
 * `baseSnapshotId` is the published snapshot the change was stated against; a
 * base that is no longer published is `BASE_NOT_PUBLISHED` (409), as in every
 * inline change.
 */
export const commitChangeProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/commit",
		tags: ["Projects", "Instructions"],
		summary: "Commit a change to a repository-backed project's branch",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for shape parity with the sibling procedures and
			// ignored: the project supplies the tenant.
			organizationId: z.string().nullable().optional(),
			baseSnapshotId: z.string().min(1).max(128),
			message: z.string().min(1).max(10_000),
			changes: z
				.array(
					z.discriminatedUnion("op", [
						z.object({
							op: z.literal("put"),
							path: z.string().min(1).max(4096),
							content: z.string(),
							encoding: z.enum(["utf8", "base64"]).optional(),
						}),
						z.object({
							op: z.literal("delete"),
							path: z.string().min(1).max(4096),
						}),
					]),
				)
				.min(1)
				.max(MAX_CHANGES),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertRepositoryWritable(input.projectId);
		const result = await submitInstructionChange({
			userId: context.user.id,
			projectId: input.projectId,
			baseSnapshotId: input.baseSnapshotId,
			changes: input.changes,
			mode: "commit",
			message: input.message,
			audit: context,
			via: "orpc",
		});
		return {
			snapshotId: result.snapshotId,
			version: result.version,
			baseSnapshotId: result.baseSnapshotId,
			fileCount: result.fileCount,
			putCount: result.putCount,
			deleteCount: result.deleteCount,
			status: result.status,
		};
	});
