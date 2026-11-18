/**
 * What the Proposal Inbox tells a reviewer after an approve: the toast for
 * the answer, whether the open proposal closes, and what a refused action's
 * CONFLICT means. Pure, so each case is tested without rendering the inbox.
 */

/** An approve door's answer, as the inbox reads it. */
export type ApproveOutcome = {
	/**
	 * `applied`: nothing is left to review. `pending`: other items are back
	 * in review. `dispatched`: an apply workflow runs and settles the
	 * proposal later. `failed`: nothing was applied.
	 */
	status: "applied" | "pending" | "dispatched" | "failed";
	errors?: string[];
	/** Creates that matched an existing ticket and were not duplicated. */
	skipped?: Array<{
		changeIndex: number;
		existingIdentifier: string;
		existingId: string;
		title: string;
	}>;
	createdStoryIds?: string[];
	/** Items still waiting for review; counted on `pending` / `applied`. */
	remainingChangeCount?: number | null;
};

/** The approve as the reviewer made it. */
export type ApproveRequest = {
	source: string;
	/** Set when one item was approved on its own. */
	changeIndex?: number;
	itemTitle?: string;
	/** That item was the proposal's last undecided one. */
	lastItem?: boolean;
	/** The ticket the approved item updates, when it is an update. */
	targetStoryId?: string;
};

export type ApproveToast = {
	variant: "success" | "error";
	title: string;
	description?: string;
	/** The ticket to offer as "Open ticket" once the proposal closes. */
	ticketId?: string;
};

const ROADMAP_RECOMMENDATION_SOURCE = "ROADMAP_RECOMMENDATION";

/**
 * Whether the open proposal closes. A whole-proposal approve closes unless
 * items are left or its apply still runs. A single item closes it when it
 * was the last one: settled at once, or handed to a workflow.
 */
export function approveClosesDetail(
	result: ApproveOutcome,
	request: ApproveRequest,
): boolean {
	if (request.changeIndex === undefined) {
		return result.status !== "pending" && result.status !== "dispatched";
	}
	return (
		result.status === "applied" ||
		(result.status === "dispatched" && request.lastItem === true)
	);
}

function itemTicketId(
	result: ApproveOutcome,
	request: ApproveRequest,
): string | undefined {
	return (
		result.createdStoryIds?.[0] ??
		result.skipped?.[0]?.existingId ??
		request.targetStoryId
	);
}

function itemToast(
	result: ApproveOutcome,
	request: ApproveRequest,
	itemTitle: string,
): ApproveToast {
	let description = "The other items stay in review.";
	if (result.status === "dispatched") {
		description =
			"Applying in the background — the ticket appears on the roadmap when it is ready.";
	} else if (result.status === "applied") {
		description = "That was the last item in this proposal.";
	}
	const ticketId = approveClosesDetail(result, request)
		? itemTicketId(result, request)
		: undefined;
	return {
		variant: "success",
		title:
			result.skipped && result.skipped.length > 0
				? `“${itemTitle}” is already on the roadmap`
				: `Approved “${itemTitle}”`,
		description,
		...(ticketId ? { ticketId } : {}),
	};
}

export function approveOutcomeToast(
	result: ApproveOutcome,
	request: ApproveRequest,
): ApproveToast {
	const itemTitle =
		request.changeIndex === undefined
			? null
			: (request.itemTitle ?? "This item");
	if (result.status === "failed") {
		return {
			variant: "error",
			title: itemTitle
				? `Couldn't apply “${itemTitle}”`
				: "Proposal approval failed",
			description:
				result.errors?.join("\n") ??
				"Some changes could not be applied.",
		};
	}
	if (itemTitle) {
		return itemToast(result, request, itemTitle);
	}
	if (result.skipped && result.skipped.length > 0) {
		// Some creates matched existing roadmap items by title and were not
		// duplicated: say so, since the approval did not produce every row.
		const skippedList = result.skipped
			.map((s) => `${s.existingIdentifier} (${s.title})`)
			.join(", ");
		const anyCreated = (result.createdStoryIds?.length ?? 0) > 0;
		return {
			variant: "success",
			title: anyCreated
				? "Proposal approved — some items already on the roadmap"
				: "Proposal approved — all items were already on the roadmap",
			description: `${result.skipped.length} already existed: ${skippedList}`,
		};
	}
	if (
		result.status === "dispatched" &&
		request.source === ROADMAP_RECOMMENDATION_SOURCE
	) {
		return {
			variant: "success",
			title: "Recommendations accepted",
			description:
				"Accepting in the background — features appear on the Roadmap as they are created; any you didn't accept stay in the inbox.",
		};
	}
	if (result.status === "dispatched") {
		return {
			variant: "success",
			title: "Proposal approved",
			description:
				"Applying in the background — items appear on the roadmap as they are created.",
		};
	}
	const remaining = result.remainingChangeCount ?? 0;
	if (result.status === "pending" && remaining > 0) {
		return {
			variant: "success",
			title: "Selected items approved",
			description: `${remaining} item${remaining === 1 ? "" : "s"} still waiting for review.`,
		};
	}
	return { variant: "success", title: "Proposal approved" };
}

export const PROPOSAL_CONFLICT_MESSAGE =
	"This proposal has already been approved or rejected perhaps by another user.";

/**
 * The toast for a refused proposal action, or null when the error is not a
 * CONFLICT. A proposal that changed after it was opened keeps the server's
 * own wording; any other conflict means another reviewer acted first. A
 * message match covers an error that reaches the client without its code.
 */
export function proposalConflictMessage(error: unknown): string | null {
	if (!(error instanceof Error)) {
		return null;
	}
	if (error.message.includes("changed after you opened it")) {
		return error.message;
	}
	if (
		("code" in error && error.code === "CONFLICT") ||
		error.message.includes("already been approved or rejected")
	) {
		return PROPOSAL_CONFLICT_MESSAGE;
	}
	return null;
}
