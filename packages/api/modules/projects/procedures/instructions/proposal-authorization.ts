import { ORPCError } from "@orpc/client";
import { hasPermission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";

/**
 * Every value `proposalStatus` can hold. `MERGED` and `CLOSED` belong to a
 * REPOSITORY proposal, decided on its pull request (Fizzy #2563 spec §4.2);
 * neither makes a snapshot's content readable as published content.
 */
type ProposalStatus = "PENDING" | "APPROVED" | "REJECTED" | "MERGED" | "CLOSED";

type SnapshotMutationSubject = {
	userId: string;
	proposalStatus: ProposalStatus | null;
};

export async function canReviewInstructionProposals(input: {
	projectId: string;
	userId: string;
}): Promise<boolean> {
	const access = await resolveEffectiveProjectPermissions(
		input.projectId,
		input.userId,
	);
	return Boolean(
		access &&
			(access.source === "owner" ||
				hasPermission(
					access.permissions,
					Permissions.INSTRUCTION_UPDATE,
				)),
	);
}

export function isInstructionSnapshotContentReadable(snapshot: {
	status: string;
	proposalStatus: ProposalStatus | null;
}): boolean {
	return (
		snapshot.status === "READY" &&
		(snapshot.proposalStatus === null ||
			snapshot.proposalStatus === "APPROVED")
	);
}

/**
 * The upload/finalize permission split for instruction snapshots.
 *
 * Direct snapshots preserve the existing INSTRUCTION_CREATE requirement.
 * A pending proposal is narrower: its original proposer may finish the
 * staged upload while they continue to hold INSTRUCTION_READ. Reviewers and
 * other readers cannot adopt somebody else's staged bytes.
 */
export async function assertInstructionSnapshotMutationAccess(input: {
	projectId: string;
	userId: string;
	snapshot: SnapshotMutationSubject;
}): Promise<void> {
	const access = await resolveEffectiveProjectPermissions(
		input.projectId,
		input.userId,
	);
	const owner = access?.source === "owner";
	const permission =
		input.snapshot.proposalStatus === "PENDING"
			? Permissions.INSTRUCTION_READ
			: Permissions.INSTRUCTION_CREATE;
	const ownsPendingProposal =
		input.snapshot.proposalStatus !== "PENDING" ||
		input.snapshot.userId === input.userId;
	if (
		!access ||
		!ownsPendingProposal ||
		(!owner && !hasPermission(access.permissions, permission))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "You cannot modify this coding-instructions snapshot",
		});
	}
}

/** Dynamic permission check used by derive's direct/proposal split. */
export async function assertInstructionDeriveAccess(input: {
	projectId: string;
	userId: string;
	proposal: boolean;
}): Promise<void> {
	const access = await resolveEffectiveProjectPermissions(
		input.projectId,
		input.userId,
	);
	const permission = input.proposal
		? Permissions.INSTRUCTION_READ
		: Permissions.INSTRUCTION_CREATE;
	if (
		!access ||
		(access.source !== "owner" &&
			!hasPermission(access.permissions, permission))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: `Missing required permission: ${permission}`,
		});
	}
}

/**
 * Who may propose to a REPOSITORY destination (Fizzy #2563 spec §5.1 step 4,
 * §16.1): `INSTRUCTION_CREATE` by default, because the proposal pushes a
 * branch and pushing can start the repository's CI before anyone reviews it;
 * `INSTRUCTION_READ` too once the project's `allowReaderProposals` is on.
 *
 * The same live resolver as `assertInstructionDeriveAccess`, so an API key
 * is never broader than the tab: the route's scope check is the ceiling and
 * this is the per-call floor under it, wildcard keys included.
 */
export async function assertRepositoryProposalAccess(input: {
	projectId: string;
	userId: string;
	allowReaders: boolean;
}): Promise<void> {
	const access = await resolveEffectiveProjectPermissions(
		input.projectId,
		input.userId,
	);
	const allowed =
		access !== null &&
		(access.source === "owner" ||
			hasPermission(access.permissions, Permissions.INSTRUCTION_CREATE) ||
			(input.allowReaders &&
				hasPermission(
					access.permissions,
					Permissions.INSTRUCTION_READ,
				)));
	if (!allowed) {
		throw new ORPCError("FORBIDDEN", {
			message: input.allowReaders
				? "Missing required permission: instruction:read"
				: "Proposing a change to a repository-backed project pushes a branch to the repository, which needs permission to edit this project's coding instructions",
		});
	}
}
