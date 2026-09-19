import { ORPCError } from "@orpc/client";
import { hasPermission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";

type SnapshotMutationSubject = {
	userId: string;
	proposalStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
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
	proposalStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
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
