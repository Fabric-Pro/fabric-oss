import { ORPCError } from "@orpc/client";
import { createId } from "@paralleldrive/cuid2";
import { config } from "@repo/config";
import { hasPendingDirectCommit } from "@repo/database";
import { renderDirectCommitText } from "@repo/instructions";
import {
	READ_ONLY_MODE_ERROR_CODE,
	READ_ONLY_MODE_MESSAGE,
} from "@repo/utils/read-only-mode";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { assertNoOpenMigration } from "./migration-freeze";
import { commitTextRefused, wholeSecondsNow } from "./proposal-admission";
import { assertRepositoryWritable } from "./read-only-guard";
import {
	assertCommitOnBranch,
	loadCommitSource,
} from "./repository-sync/commit-source";
import { commitShaSchema } from "./repository-sync/compare-commits";
import {
	type RevertCommitAnswer,
	runRevertCommitWorkflow,
} from "./revert-commit-workflow";

/**
 * The refusals a revert can end in, each with the HTTP-shaped code and the
 * words the person needs. `data.code` is the stable value a client branches on.
 */
function revertRefusal(
	code: string,
): ORPCError<string, { code: string; errorCode?: string }> {
	switch (code) {
		case "REVERT_CONFLICT":
			return new ORPCError("CONFLICT", {
				message:
					"A later commit changed one of these files, so this change can't be undone on its own. Edit the files and commit the result instead.",
				data: { code },
			});
		case "REVERT_REJECTED":
			return new ORPCError("UNPROCESSABLE_CONTENT", {
				message:
					"Undoing this change would restore a file that looks like it contains a credential, so Fabric won't commit it.",
				data: { code },
			});
		case "REVERT_TOO_LARGE":
			return new ORPCError("UNPROCESSABLE_CONTENT", {
				message:
					"This change touches too many files, or a file that is too large, to undo from Fabric.",
				data: { code },
			});
		case "REVERT_EMPTY":
			return new ORPCError("UNPROCESSABLE_CONTENT", {
				message: "This commit changed nothing in the synced folder.",
				data: { code },
			});
		case "REVERT_UNSUPPORTED":
			return new ORPCError("UNPROCESSABLE_CONTENT", {
				message:
					"A merge commit, a repository's first commit, or a change to a file Fabric leaves out of the instructions (such as .fabricignore) can't be undone from Fabric.",
				data: { code },
			});
		case "COMMIT_NOT_ON_BRANCH":
			return new ORPCError("NOT_FOUND", {
				message: "That commit is not on the synced branch",
				data: { code: "COMMIT_NOT_FOUND" },
			});
		case "READ_ONLY_MODE":
			return new ORPCError("CONFLICT", {
				message: READ_ONLY_MODE_MESSAGE,
				data: { code, errorCode: READ_ONLY_MODE_ERROR_CODE },
			});
		default:
			return new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Couldn't undo the commit. Try again.",
				data: { code },
			});
	}
}

/**
 * Another revert of this project's branch, or a direct commit on its way to
 * it, is still open: both write the same tip, so a revert waits its turn
 * instead of racing them (`REVERT_BUSY`, 409; try again in a moment).
 */
function revertBusy(): ORPCError<"CONFLICT", { code: string }> {
	return new ORPCError("CONFLICT", {
		message:
			"Another change to this project's branch is still being made. Try again in a moment.",
		data: { code: "REVERT_BUSY" },
	});
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE); the member's authority is
 * checked again inside the workflow's activity, immediately before the push.
 *
 * "Revert" on a commit of a repository-backed project's History (Fizzy #2878
 * §10): rollback is a revert commit, as with git. The commit's change within
 * the synced folder is undone by one new commit on the branch tip, authored as
 * the member (their display name with the deployment's `noreply@` address)
 * and committed by Fabric, with git's own message: `Revert "<subject>"` and
 * `This reverts commit <sha>.`.
 *
 * `sha` must be a full object id of a commit on the synced branch (404
 * otherwise, as a missing commit is). The revert reads the commit's change
 * from git, restores the entries its parent held, and refuses, writing
 * nothing, when:
 *
 *  - a later commit changed one of the files (`REVERT_CONFLICT`, 409);
 *  - a file it would restore has a credential-shaped name or holds a
 *    credential (`REVERT_REJECTED`, 422): the secret gate applies to what a
 *    revert writes as to what a person types;
 *  - the commit is a merge or a root commit, or changed a path the rules of a
 *    version leave out (`.fabricignore`, the always-excluded globs, the
 *    published version's own ignore rules), a file Fabric's copy never held
 *    (`REVERT_UNSUPPORTED`), changed nothing in the folder (`REVERT_EMPTY`), or
 *    is too large to undo from here (`REVERT_TOO_LARGE`), all 422.
 *
 * A project in Read-only mode refuses it (409, `data.errorCode`
 * `PROJECT_READ_ONLY`, as every write against a connected external source
 * does), before anything is read and again by the activity just before it
 * pushes.
 *
 * `REVERT_BUSY` (409): another revert of this project's branch is still open
 * (one workflow per project, `workflowIdConflictPolicy: "FAIL"`), or a direct
 * commit is still on its way to the branch. Both write the same tip, so the
 * revert is refused rather than racing them; try again in a moment.
 *
 * `BRANCH_PROTECTED` (409): the branch refused the push; unlike a commit, a
 * revert has no staged change to turn into a pull request, so the member
 * reverts it in the repository. `BRANCH_BUSY` (409): the branch kept moving.
 *
 * There is no snapshot row: the answer is the workflow's result. It is
 * `reverted` with the new commit, or `unchanged` when the branch already holds
 * the restored files, or `pending` when the revert outlived the request's
 * 60-second wait (it keeps running; refresh History). Fabric's published copy
 * follows the branch through the confirming sync a successful revert starts.
 */
export const revertCommitProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/revert",
		tags: ["Projects", "Instructions"],
		summary: "Revert a commit on a repository-backed project's branch",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for shape parity with the sibling procedures and
			// ignored: the project supplies the tenant.
			organizationId: z.string().nullable().optional(),
			sha: commitShaSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		await assertRepositoryWritable(input.projectId);
		// A revert writes the branch tip a move that has just merged is about
		// to be read from (Fizzy #2878 §9): it waits for the first sync.
		await assertNoOpenMigration({
			projectId: input.projectId,
			organizationId: await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			),
		});
		const source = await loadCommitSource({
			projectId: input.projectId,
			userId: context.user.id,
		});
		if (
			await hasPendingDirectCommit({
				projectId: input.projectId,
				organizationId: source.organizationId,
			})
		) {
			throw revertBusy();
		}
		await assertCommitOnBranch(source, input.sha);

		const rendered = renderDirectCommitText({
			message: "Revert",
			proposerName: context.user.name ?? "",
			mailFrom: config.mails.from,
		});
		if (!rendered.ok) {
			return commitTextRefused(rendered.code);
		}
		const requestId = createId();
		const answer: RevertCommitAnswer = await runRevertCommitWorkflow({
			projectId: input.projectId,
			organizationId: source.organizationId,
			userId: context.user.id,
			sha: input.sha,
			requestId,
			author: rendered.author,
			committer: rendered.committer,
			committedAt: wholeSecondsNow(),
		});
		switch (answer.kind) {
			case "reverted":
				return {
					outcome: "reverted" as const,
					sha: answer.sha,
					ref: answer.ref,
					fileCount: answer.fileCount,
				};
			case "unchanged":
				return { outcome: "unchanged" as const, sha: answer.sha };
			case "pending":
				return { outcome: "pending" as const, requestId };
			case "in_progress":
				throw revertBusy();
			case "refused":
				throw revertRefusal(answer.code);
			case "protected":
				throw new ORPCError("CONFLICT", {
					message: `"${source.ref}" is protected, so Fabric can't push a revert to it. Revert the commit in your repository instead.`,
					data: { code: "BRANCH_PROTECTED" },
				});
			case "busy":
				throw new ORPCError("CONFLICT", {
					message: `"${source.ref}" changed while the revert was being made. Try again.`,
					data: { code: "BRANCH_BUSY" },
				});
			case "failed":
				throw revertRefusal(answer.code);
			default: {
				const unreachable: never = answer;
				return unreachable;
			}
		}
	});
