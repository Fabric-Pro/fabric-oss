/**
 * The caller's open proposals with the hashes of what they change (Fizzy
 * #2738 spec §14.2), as `GET /api/v1/projects/:projectId/instructions/proposals/open`
 * returns them for the CLI's skip of already proposed identical paths
 * (Fizzy #2739).
 *
 * The selection is `listOpenInstructionProposals` in `@repo/database`; this
 * module supplies the canonical repository identity port and shapes each row
 * for the wire. It never checks authorization: the route has already checked
 * the key's scope and the creator's live read permission, and the rows are
 * the creator's own by construction.
 */
import { listOpenInstructionProposals } from "@repo/database";
import {
	repositoryIdentity,
	repositoryKey,
} from "@repo/integrations/instruction-pull-requests";
import {
	type ProposalBranchView,
	proposalBranchView,
} from "./proposal-branch-view";

/** One open proposal on the wire (spec §14.2 "Response"). */
type OpenProposalDetails = {
	status: "RECEIVING" | "VALIDATING" | "READY" | "REJECTED" | "FAILED";
	pullRequest: {
		state:
			| "QUEUED"
			| "OPENING"
			| "OPEN"
			| "CLOSE_REQUESTED"
			| "BLOCKED"
			| "MERGED"
			| "CLOSED"
			| "CANCELED";
		url: string | null;
	} | null;
	changes: Array<{
		path: string;
		op: "put" | "delete";
		sha256: string | null;
	}>;
	/** The §10 branch block, which the CLI ignores. */
	branch: ProposalBranchView | null;
};

export type OpenProposalView = OpenProposalDetails &
	(
		| { snapshotId: string; version: number; baseSnapshotId: string }
		| {
				kind: "native";
				operationId: string;
				nativeBase: { generation: number; commitSha: string };
		  }
	);

/**
 * The open proposals of `userId` (the API key's creator) in the project and
 * organization the route resolved, newest version first, at most 20.
 */
export async function readOpenProposals(i: {
	projectId: string;
	organizationId: string;
	userId: string;
}): Promise<{ proposals: OpenProposalView[] }> {
	const rows = await listOpenInstructionProposals({
		projectId: i.projectId,
		organizationId: i.organizationId,
		userId: i.userId,
		naming: { repositoryIdentity, repositoryKey },
	});
	return {
		proposals: rows.map((row) => ({
			...(row.candidate.nativeBase
				? {
						kind: "native" as const,
						operationId: row.candidate.snapshotId,
						nativeBase: row.candidate.nativeBase,
					}
				: {
						snapshotId: row.candidate.snapshotId,
						version: row.candidate.version,
						baseSnapshotId: row.candidate.baseSnapshotId,
					}),
			status: row.status,
			pullRequest: row.pullRequest,
			// Field by field: a delete's `sha256` is present and exactly null.
			changes: row.changes.map((change) => ({
				path: change.path,
				op: change.op,
				sha256: change.op === "delete" ? null : change.sha256,
			})),
			branch: row.branch ? proposalBranchView(row.branch) : null,
		})),
	};
}
