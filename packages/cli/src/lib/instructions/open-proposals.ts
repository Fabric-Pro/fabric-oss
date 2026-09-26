/**
 * The caller's open proposals, read before `fabric instructions push` sends
 * anything (Fizzy #2739), so a change one of them already carries is not sent
 * a second time. Which of them count is `setAsideProposed`'s decision
 * (`push.ts`); this module only asks, and answers "unavailable" instead of
 * throwing.
 *
 * Unavailable means SEND EVERYTHING, with a warning, never refuse. What an
 * unchecked push costs is the duplicate this lookup exists to avoid, and the
 * server already handles that correctly: each proposal is diffed against its
 * own base. Refusing would make every push fail against a server that does
 * not have the lookup yet, and would turn a slow read into a blocked
 * suggestion.
 *
 * The answer decides which changes are left out, so it is checked for shape
 * before it is used, strictly: a malformed answer, or one naming a state
 * this CLI does not know, is unavailable as a whole, never a partial list.
 * Strict matters most where a field is missing — a deletion whose `sha256`
 * is absent rather than `null` is a server that has drifted from the
 * contract, and reading it leniently would leave a local deletion out with
 * no warning at all.
 */
import type {
	FabricClient,
	InstructionSnapshotStatus,
	OpenInstructionProposal,
	OpenInstructionProposalChange,
	ProposalPullRequestState,
} from "@fabricorg/sdk";
import { describeError } from "../command-boundary.js";

/**
 * The whole lookup's budget, retries included, in one mutable object so a
 * test can shorten it. Nothing in the CLI writes to it.
 */
export const openProposalTiming = { deadlineMs: 15_000 };

type OpenProposalLookup =
	| { kind: "found"; proposals: OpenInstructionProposal[] }
	/** `reason` finishes the sentence "Could not check your open proposals (…)". */
	| { kind: "unavailable"; reason: string };

/**
 * Every snapshot status and pull-request state the contract allows, as
 * records so the compiler fails if either union gains or loses a member
 * without this list following it.
 */
const SNAPSHOT_STATUSES: Record<InstructionSnapshotStatus, true> = {
	RECEIVING: true,
	VALIDATING: true,
	READY: true,
	REJECTED: true,
	FAILED: true,
};

const PULL_REQUEST_STATES: Record<ProposalPullRequestState, true> = {
	QUEUED: true,
	OPENING: true,
	OPEN: true,
	CLOSE_REQUESTED: true,
	BLOCKED: true,
	MERGED: true,
	CLOSED: true,
	CANCELED: true,
};

function isKnown(known: Record<string, true>, value: unknown): value is string {
	return typeof value === "string" && Object.hasOwn(known, value);
}

class OpenProposalDeadline extends Error {
	constructor(ms: number) {
		super(`it did not answer within ${Math.ceil(ms / 1000)} s`);
		this.name = "OpenProposalDeadline";
	}
}

export async function lookUpOpenProposals(
	client: FabricClient,
	projectId: string,
	options: { org?: string } = {},
): Promise<OpenProposalLookup> {
	const ms = openProposalTiming.deadlineMs;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new OpenProposalDeadline(ms)),
		ms,
	);
	let answer: unknown;
	try {
		answer = await client.instructions.getOpenProposals(projectId, {
			org: options.org,
			signal: controller.signal,
		});
	} catch (error) {
		// Classified by the signal, never by the error's name: the SDK
		// rejects a cancelled request with the signal's own reason.
		if (controller.signal.aborted) {
			return {
				kind: "unavailable",
				reason: describeError(controller.signal.reason),
			};
		}
		// The project was just read successfully through the same gate, so a
		// 404 here is the route, not the project.
		if ((error as { status?: number }).status === 404) {
			return {
				kind: "unavailable",
				reason: "this Fabric server does not list open proposals yet",
			};
		}
		return { kind: "unavailable", reason: describeError(error) };
	} finally {
		clearTimeout(timer);
	}
	if (!Array.isArray(answer) || !answer.every(isOpenProposal)) {
		return {
			kind: "unavailable",
			reason: "the server's answer was not a list of proposals",
		};
	}
	return { kind: "found", proposals: answer };
}

function isOpenProposal(value: unknown): value is OpenInstructionProposal {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const proposal = value as Record<string, unknown>;
	const pullRequest = proposal.pullRequest as
		| Record<string, unknown>
		| null
		| undefined;
	return (
		typeof proposal.snapshotId === "string" &&
		typeof proposal.version === "number" &&
		typeof proposal.baseSnapshotId === "string" &&
		isKnown(SNAPSHOT_STATUSES, proposal.status) &&
		(pullRequest === null ||
			(typeof pullRequest === "object" &&
				pullRequest !== undefined &&
				isKnown(PULL_REQUEST_STATES, pullRequest.state) &&
				(pullRequest.url === null ||
					typeof pullRequest.url === "string"))) &&
		Array.isArray(proposal.changes) &&
		proposal.changes.every(isChange)
	);
}

function isChange(value: unknown): value is OpenInstructionProposalChange {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const change = value as Record<string, unknown>;
	return (
		typeof change.path === "string" &&
		((change.op === "put" && typeof change.sha256 === "string") ||
			(change.op === "delete" && change.sha256 === null))
	);
}
