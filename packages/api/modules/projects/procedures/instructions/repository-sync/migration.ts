/**
 * Reading, canceling and retrying a move of uploaded coding instructions into
 * a repository (Fizzy #2878 §9). `migrate.ts` starts one; these are what a
 * client does with it afterwards.
 *
 * - `getRepositoryMigration` (INSTRUCTION_READ): the pointer with the pull
 *   request's own state (`RepositoryMigrationView`), or `null` when no move is
 *   open. A finished move leaves nothing here: the project reports its own
 *   source of truth.
 * - `cancelRepositoryMigration` (INSTRUCTION_CREATE and UPDATE): closes the
 *   pull request through the member branch's own close command; once the
 *   branch settles, the settlement step ends the move, deleting the sync row
 *   WITHOUT writing UPLOAD (uploads never stopped being the source) and
 *   clearing the pointer. A move whose pull request already ended is ended
 *   here and now. A pull request that merged cannot be canceled: its files are
 *   in the repository and the project switches.
 * - `retryRepositoryMigration` (INSTRUCTION_CREATE and UPDATE): what can help a
 *   move that is stuck. A pull request the repository refused to open is
 *   retried through the branch's own command; a push that was refused or lost
 *   and is waiting out its backoff is made due now; a merge whose switch did
 *   not happen is repeated; an ended pull request's cleanup is repeated. A
 *   failure no retry can fix (a name Fabric cannot use as the author of a
 *   commit, a folder that gained files) answers `MIGRATION_NOT_RETRYABLE`:
 *   cancel the move and start it again.
 */
import { ORPCError } from "@orpc/client";
import {
	abandonInstructionMigration,
	closeProposalBranch,
	completeInstructionMigration,
	expediteMigrationBranch,
	getInstructionRepositorySync,
	getMemberProposalBranch,
	rejectAbandonedInstructionSnapshot,
	requestProposalBranchRetry,
} from "@repo/database";
import { z } from "zod";
import { auditRequestFields, resolveActor } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";
import { wakeProposalBranchWorkflow } from "../proposal-branch";
import { readMove } from "./migration-read";

type Tenant = { projectId: string; organizationId: string };

function requesterOf(context: Parameters<typeof auditRequestFields>[0]) {
	const { impersonatedById: _impersonatedById, ...request } =
		auditRequestFields(context);
	return { actor: resolveActor(context, undefined), ...request };
}

/**
 * The project was switched to the repository by something other than the
 * move, so ending the move would delete a sync row that is not the move's:
 * its way out is "switch to upload mode".
 */
function sourceFlipped(): ORPCError<"CONFLICT", { reason: string }> {
	return new ORPCError("CONFLICT", {
		message:
			"This project was switched to its repository outside this move, so the move can't be canceled. Switch the project back to upload mode instead.",
		data: { reason: "MIGRATION_SOURCE_FLIPPED" },
	});
}

function notOpen(): ORPCError<"NOT_FOUND", { reason: string }> {
	return new ORPCError("NOT_FOUND", {
		message: "No move of this project's coding instructions is open.",
		data: { reason: "MIGRATION_NOT_OPEN" },
	});
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ).
 */
export const getRepositoryMigrationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/repository-sync/migration",
		tags: ["Projects", "Instructions"],
		summary: "Get the move of uploaded instructions into a repository",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const move = await readMove({
			projectId: input.projectId,
			organizationId,
		});
		const sync =
			move === null
				? null
				: await getInstructionRepositorySync(
						input.projectId,
						organizationId,
					);
		return {
			migration: move?.view ?? null,
			repository:
				sync === null || move === null
					? null
					: {
							provider: sync.repositoryIntegration.provider,
							owner: sync.repositoryIntegration.repositoryOwner,
							name: sync.repositoryIntegration.repositoryName,
							ref: sync.ref,
							folder: sync.rootPath,
						},
		};
	});

const moveCommandInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE), and INSTRUCTION_UPDATE
 * asserted in the handler, as `migrate`.
 */
export const cancelRepositoryMigrationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/repository-sync/migration/cancel",
		tags: ["Projects", "Instructions"],
		summary: "Cancel the move of uploaded instructions into a repository",
	})
	.input(moveCommandInput)
	.handler(async ({ input, context }) => {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.INSTRUCTION_UPDATE,
		);
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const tenant = { projectId: input.projectId, organizationId };
		const move = await readMove(tenant);
		if (move === null) {
			throw notOpen();
		}
		const { pointer, view, branchId, evidence } = move;
		if (evidence.sourceFlipped) {
			// Closing the pull request would end nothing: the move cannot be
			// ended while its project belongs to something else. Switching
			// back to upload mode is the way out.
			throw sourceFlipped();
		}
		if (view.state === "SWITCHING" || view.state === "MERGED") {
			throw new ORPCError("CONFLICT", {
				message:
					"The pull request was merged, so the move can't be canceled: the files are in the repository and the project is switching to them.",
				data: { reason: "MIGRATION_MERGED" },
			});
		}
		const end = async (reason: "canceled" | "pull_request_closed") => {
			const result = await abandonInstructionMigration({
				...tenant,
				syncId: pointer.syncId,
				reason,
				actorUserId: context.user.id,
			});
			if (result === "source_flipped") {
				throw sourceFlipped();
			}
		};
		if (view.state === "ABANDONED") {
			// The pull request ended and the step that ends the move was lost.
			await end("pull_request_closed");
			return { state: "ABANDONED" as const };
		}
		if (branchId === null) {
			// No branch yet: nothing is open in the repository. A proposal that is
			// still being received is closed out; one that has been handed to the
			// workflow but not joined yet is the sweeper's to attach, so asking
			// again in a moment is the honest answer.
			if (pointer.snapshotId !== null) {
				const rejected = await rejectAbandonedInstructionSnapshot({
					snapshotId: pointer.snapshotId,
					...tenant,
					source: "migration_canceled",
				});
				if (!rejected.changed) {
					throw new ORPCError("CONFLICT", {
						message:
							"The move is still being prepared. Try again in a moment.",
						data: { reason: "MIGRATION_PREPARING" },
					});
				}
			}
			await end("canceled");
			return { state: "ABANDONED" as const };
		}
		const branch = await getMemberProposalBranch({
			branchId,
			...tenant,
		});
		if (branch === null) {
			await end("canceled");
			return { state: "ABANDONED" as const };
		}
		const closed = await closeProposalBranch({
			branchId,
			...tenant,
			expectedAttempt: branch.attempt,
			requester: requesterOf(context),
		});
		switch (closed.kind) {
			case "done":
				break;
			case "stale":
				throw new ORPCError("CONFLICT", {
					message:
						"The pull request changed just now. Refresh and try again.",
					data: { reason: "MIGRATION_CHANGED" },
				});
			case "not_found":
				await end("canceled");
				return { state: "ABANDONED" as const };
			case "not_applicable":
				throw new ORPCError("CONFLICT", {
					message:
						"The pull request is being settled. Refresh to see how it ended.",
					data: { reason: "MIGRATION_CHANGED" },
				});
			default: {
				const unreachable: never = closed;
				return unreachable;
			}
		}
		await wakeProposalBranchWorkflow({
			branchId,
			...tenant,
			correlation: true,
		}).catch((error: unknown) => {
			console.error(
				"[instructions] could not wake the branch of a canceled move; the sweeper will",
				{ branchId },
				error,
			);
		});
		return { state: "CANCELING" as const };
	});

/**
 * AUTHORIZATION: as `cancelRepositoryMigration`.
 */
export const retryRepositoryMigrationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/repository-sync/migration/retry",
		tags: ["Projects", "Instructions"],
		summary: "Retry the move of uploaded instructions into a repository",
	})
	.input(moveCommandInput)
	.handler(async ({ input, context }) => {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.INSTRUCTION_UPDATE,
		);
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const tenant = { projectId: input.projectId, organizationId };
		const move = await readMove(tenant);
		if (move === null) {
			throw notOpen();
		}
		const { pointer, view, branchId, proposal, evidence } = move;
		const notRetryable = () =>
			new ORPCError("PRECONDITION_FAILED", {
				message:
					"A retry can't fix this. Cancel the move and start it again.",
				data: {
					reason: "MIGRATION_NOT_RETRYABLE",
					failure: view.failure,
				},
			});
		switch (view.state) {
			case "MERGED": {
				// The pull request merged and the step that switches the project
				// was lost: repeat it. By the settlement hook's own rule: a
				// merge into a branch the sync does not read put the files
				// where the project will never look, so it ends the move
				// instead (the view reads that as `ABANDONED`; this is the
				// same decision, taken again on the evidence read with it).
				if (branchId === null) {
					throw notRetryable();
				}
				if (evidence.targetMismatch) {
					const ended = await abandonInstructionMigration({
						...tenant,
						syncId: pointer.syncId,
						reason: "pull_request_closed",
						actorUserId: context.user.id,
					});
					if (ended === "source_flipped") {
						throw sourceFlipped();
					}
					return { retried: true as const };
				}
				await completeInstructionMigration({
					...tenant,
					branchId,
					pullRequestUrl: view.pullRequest?.url ?? null,
				});
				return { retried: true as const };
			}
			case "ABANDONED": {
				const ended = await abandonInstructionMigration({
					...tenant,
					syncId: pointer.syncId,
					reason: "pull_request_closed",
					actorUserId: context.user.id,
				});
				if (ended === "source_flipped") {
					throw sourceFlipped();
				}
				return { retried: true as const };
			}
			case "BLOCKED":
			case "PROPOSING":
			case "OPEN":
				break;
			case "SWITCHING":
				throw notRetryable();
			default: {
				const unreachable: never = view.state;
				return unreachable;
			}
		}
		if (branchId === null || view.failure === null) {
			throw notRetryable();
		}
		const branch = await getMemberProposalBranch({ branchId, ...tenant });
		if (branch === null) {
			throw notRetryable();
		}
		if (
			branch.state === "BLOCKED" &&
			view.failure.code === "PR_CREATION_REFUSED"
		) {
			const retried = await requestProposalBranchRetry({
				branchId,
				...tenant,
				expectedAttempt: branch.attempt,
				requester: requesterOf(context),
			});
			if (retried.kind !== "done") {
				throw notRetryable();
			}
		} else if (
			view.failure.retryable &&
			(branch.state === "PENDING" || branch.state === "OPENING") &&
			proposal !== null
		) {
			const due = await expediteMigrationBranch({
				branchId,
				organizationId,
				expectedAttempt: branch.attempt,
			});
			if (!due) {
				throw new ORPCError("CONFLICT", {
					message:
						"The pull request changed just now. Refresh and try again.",
					data: { reason: "MIGRATION_CHANGED" },
				});
			}
		} else {
			throw notRetryable();
		}
		await wakeProposalBranchWorkflow({
			branchId,
			...tenant,
			correlation: true,
		}).catch((error: unknown) => {
			console.error(
				"[instructions] could not wake the branch of a retried move; the sweeper will",
				{ branchId },
				error,
			);
		});
		return { retried: true as const };
	});
