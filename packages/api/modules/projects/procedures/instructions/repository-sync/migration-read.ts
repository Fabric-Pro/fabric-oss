/**
 * Reading the open move of a project's uploaded coding instructions into its
 * repository (Fizzy #2878 §9): the stored pointer, the pull request's own
 * rows, and the evidence only the project and the branch can give. Shared by
 * the procedures that read, cancel and retry the move (`migration.ts`) and by
 * the one that decides whether switching back to upload mode may end it
 * (`disable.ts`), which is why it is not in either.
 */
import {
	getMemberProposalBranch,
	getProjectInstructionSettings,
	type InstructionMigrationPointer,
	mergedElsewhere,
	proposalBranchIdOf,
} from "@repo/database";
import {
	type ProposalPullRequestView,
	readProposalPullRequest,
} from "../proposal-pull-request";
import {
	type RepositoryMigrationEvidence,
	type RepositoryMigrationView,
	repositoryMigrationView,
} from "./migration-view";

type Tenant = { projectId: string; organizationId: string };

/**
 * The open move's pointer, its proposal's pull request, the branch it is on
 * now and the evidence the move's own rows cannot give (the project flipped
 * behind it, a merge into the wrong branch); null when none is open.
 */
export async function readMove(i: Tenant): Promise<{
	pointer: InstructionMigrationPointer;
	proposal: ProposalPullRequestView | null;
	branchId: string | null;
	evidence: RepositoryMigrationEvidence;
	view: RepositoryMigrationView;
} | null> {
	const settings = await getProjectInstructionSettings(
		i.projectId,
		i.organizationId,
	);
	const pointer = settings.migration;
	if (pointer === null) {
		return null;
	}
	const proposal =
		pointer.snapshotId === null
			? null
			: await readProposalPullRequest({
					snapshotId: pointer.snapshotId,
					projectId: i.projectId,
					organizationId: i.organizationId,
				});
	// The proposal row says which branch it is on now; the pointer's is where it
	// started (a start over rehomes it).
	const branchId =
		pointer.snapshotId === null
			? pointer.branchId
			: ((await proposalBranchIdOf({
					snapshotId: pointer.snapshotId,
					organizationId: i.organizationId,
				})) ?? pointer.branchId);
	const branch =
		branchId === null
			? null
			: await getMemberProposalBranch({ branchId, ...i });
	const evidence: RepositoryMigrationEvidence = {
		// A move that is proposing has never flipped the project: one that is
		// repository-backed now was flipped by something else.
		sourceFlipped:
			pointer.state === "PROPOSING" &&
			settings.sourceOfTruth === "REPOSITORY",
		targetMismatch: mergedElsewhere(branch?.pullRequestObservation),
	};
	return {
		pointer,
		proposal,
		branchId,
		evidence,
		view: repositoryMigrationView(pointer, proposal, branchId, evidence),
	};
}
