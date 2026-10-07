/**
 * The member proposal branch procedures under `projects.instructions.proposals`
 * (Fizzy #2738 spec §10 "Procedures, REST v1 and SDK"): `myBranch`,
 * `myBranchFile`, `closeBranch`, `startOverBranch`, `retryBranch`,
 * `stopTrackingBranch`, `retryConflict` (Try again) and `proposeAgain`.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ), then the live owner-or-reviewer
 * and proposer checks in the services (`proposal-branch.ts`). The tenant is
 * the project's hosting organization, never the request's.
 */
import { z } from "zod";
import { auditRequestFields, resolveActor } from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import {
	closeMyProposalBranch,
	PROPOSAL_BRANCH_OWNERS_MAX_LIMIT,
	proposeMyBranchChangeAgain,
	readMyProposalBranch,
	readMyProposalBranchFile,
	readProposalBranchesForReviewer,
	refreshProposalBranch,
	retryMyBranchConflict,
	retryMyProposalBranch,
	startOverMyProposalBranch,
	stopTrackingMyProposalBranch,
} from "./proposal-branch";

const BRANCH_FILE_MAX = 200_000;

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

const branchCommandInput = projectInput.extend({
	branchId: z.string().max(128),
	expectedAttempt: z.number().int().min(0),
});

const proposalCommandInput = projectInput.extend({
	snapshotId: z.string().max(128),
});

/** The audit request half, from this request. */
function requesterOf(context: Parameters<typeof auditRequestFields>[0]) {
	const { impersonatedById: _impersonatedById, ...request } =
		auditRequestFields(context);
	return { actor: resolveActor(context, undefined), ...request };
}

const branchProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ));

/**
 * The member's branch (spec §10 "Tab", "Editor"): the accepting branch, its
 * live change count and projection, and every branch the panel shows.
 * `userId` names another member's, for a reviewer only.
 */
export const getMyProposalBranchProcedure = branchProcedure
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/proposal-branch",
		tags: ["Projects", "Instructions"],
		summary: "Get your coding-instructions proposal branch",
	})
	.input(projectInput.extend({ userId: z.string().max(128).optional() }))
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		return readMyProposalBranch({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			...(input.userId !== undefined ? { forUserId: input.userId } : {}),
		});
	});

/**
 * Every member with a tracked branch in the project, read-only (Fizzy #2738
 * spec §10 "Reviewers see every member's branches read-only"): reviewer-only,
 * independent of the proposal list's own pagination — a member whose
 * proposals are not on the tab's current page still gets a panel from this.
 */
export const getProposalBranchesForReviewerProcedure = branchProcedure
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/proposal-branches",
		tags: ["Projects", "Instructions"],
		summary:
			"List every member's coding-instructions proposal branch, for a reviewer",
	})
	.input(
		projectInput.extend({
			cursor: z.string().max(128).optional(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(PROPOSAL_BRANCH_OWNERS_MAX_LIMIT)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		return readProposalBranchesForReviewer({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
			...(input.limit !== undefined ? { limit: input.limit } : {}),
		});
	});

/**
 * One `written` file on a branch, from the stored file Fabric wrote there
 * (spec §10 `myBranchFile`): text paged, a binary as a signed URL.
 */
export const getMyProposalBranchFileProcedure = branchProcedure
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/proposal-branches/:branchId/file",
		tags: ["Projects", "Instructions"],
		summary: "Read one file of a coding-instructions proposal branch",
	})
	.input(
		projectInput.extend({
			branchId: z.string().max(128),
			path: z.string().max(4096),
			offset: z.number().int().min(0).default(0),
			maxLength: z.number().int().min(1).max(BRANCH_FILE_MAX).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		return readMyProposalBranchFile({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			branchId: input.branchId,
			path: input.path,
			offset: input.offset,
			...(input.maxLength !== undefined
				? { maxLength: input.maxLength }
				: {}),
		});
	});

function branchCommandProcedure(
	action: "close" | "start-over" | "retry" | "stop-tracking",
	summary: string,
	run: typeof closeMyProposalBranch,
) {
	return branchProcedure
		.route({
			method: "POST",
			path: `/projects/:projectId/instructions/proposal-branches/:branchId/${action}`,
			tags: ["Projects", "Instructions"],
			summary,
		})
		.input(branchCommandInput)
		.handler(async ({ input, context }) => {
			const organizationId = await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			);
			return run({
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
				branchId: input.branchId,
				expectedAttempt: input.expectedAttempt,
				requester: requesterOf(context),
			});
		});
}

/** Close pull request (spec Decision 11), by the branch's owner. */
export const closeProposalBranchProcedure = branchCommandProcedure(
	"close",
	"Close your coding-instructions pull request",
	closeMyProposalBranch,
);

/** Start over on a new branch (spec Decision 11), by the branch's owner. */
export const startOverProposalBranchProcedure = branchCommandProcedure(
	"start-over",
	"Start your coding-instructions branch over",
	startOverMyProposalBranch,
);

/** Retry opening (spec Decision 17), by the branch's owner. */
export const retryProposalBranchProcedure = branchCommandProcedure(
	"retry",
	"Retry opening your coding-instructions pull request",
	retryMyProposalBranch,
);

/** Stop tracking (spec Decision 19), by the branch's owner or a reviewer. */
export const stopTrackingProposalBranchProcedure = branchCommandProcedure(
	"stop-tracking",
	"Stop tracking a coding-instructions proposal branch",
	stopTrackingMyProposalBranch,
);

/** Ask Fabric to observe this branch's pull request now. */
export const refreshProposalBranchProcedure = branchProcedure
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/proposal-branches/:branchId/refresh",
		tags: ["Projects", "Instructions"],
		summary: "Refresh a coding-instructions proposal branch pull request",
	})
	.input(branchCommandInput)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		return refreshProposalBranch({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			branchId: input.branchId,
			expectedAttempt: input.expectedAttempt,
		});
	});

/** Try again (spec §4.3), by the change's author, at the attempt the card showed. */
export const retryProposalConflictProcedure = branchProcedure
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/proposals/:snapshotId/try-again",
		tags: ["Projects", "Instructions"],
		summary: "Try adding a coding-instructions change to your branch again",
	})
	.input(
		proposalCommandInput.extend({
			expectedAttempt: z.number().int().min(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		return retryMyBranchConflict({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			snapshotId: input.snapshotId,
			expectedAttempt: input.expectedAttempt,
			requester: requesterOf(context),
		});
	});

/** Propose again (spec Decision 14), by the change's author. */
export const proposeAgainProcedure = branchProcedure
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/proposals/:snapshotId/propose-again",
		tags: ["Projects", "Instructions"],
		summary: "Propose a coding-instructions change again",
	})
	.input(proposalCommandInput)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		return proposeMyBranchChangeAgain({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			snapshotId: input.snapshotId,
			requester: requesterOf(context),
		});
	});
