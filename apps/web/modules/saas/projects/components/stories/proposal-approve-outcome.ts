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
	/**
	 * Why each update left out of the approve was held back (its target is
	 * not a work item in this project). Those items stay in review.
	 */
	heldBack?: string[];
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
 * The heading of every refused or failed approve, for one item (its title)
 * or for the whole proposal (null).
 */
export function approveRefusalTitle(itemTitle: string | null): string {
	return itemTitle
		? `Couldn't approve “${itemTitle}”`
		: "Couldn't approve proposal";
}

/**
 * The toast for the items an approve held back, or null when none was: each
 * names its item and target, and those items stay in review.
 */
export function heldBackToast(
	heldBack: readonly string[] | undefined,
): ApproveToast | null {
	if (!heldBack || heldBack.length === 0) {
		return null;
	}
	const single = heldBack.length === 1;
	return {
		variant: "error",
		title: single
			? "Couldn't approve 1 item"
			: `Couldn't approve ${heldBack.length} items`,
		description: [...heldBack, staysInReview(heldBack.length)].join("\n"),
	};
}

/** That `count` held-back items stay in review. */
function staysInReview(count: number): string {
	return count === 1 ? "It stays in review." : "They stay in review.";
}

/**
 * The held-back toast to show beside an approve's own toast, or null. A
 * failed approve's toast already names the items its errors name, so they
 * are not named twice in a second toast.
 */
export function approveHeldBackToast(
	result: ApproveOutcome,
): ApproveToast | null {
	const shown = new Set(result.status === "failed" ? result.errors : []);
	return heldBackToast(
		result.heldBack?.filter((reason) => !shown.has(reason)),
	);
}

/**
 * What an Apply Selected approves while it runs: the changes that apply out
 * of all the proposal's, and the updates held back because their target
 * ticket is not in this project (null when none is).
 */
export function approvedChangesText(
	submitted: number,
	total: number,
	heldBack: number,
): { approved: string; heldBack: string | null } {
	const applying = Math.max(submitted - heldBack, 0);
	return {
		approved: `Approved ${applying} of ${total} proposed changes`,
		heldBack:
			heldBack > 0
				? `${heldBack} held back: ${heldBack === 1 ? "its" : "their"} target ticket is not in this project.`
				: null,
	};
}

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
		// The items held back that the errors name are not toasted again
		// (`approveHeldBackToast`): this toast says they stay in review.
		const heldBack = new Set(result.heldBack);
		const named =
			result.errors?.filter((error) => heldBack.has(error)).length ?? 0;
		return {
			variant: "error",
			title: approveRefusalTitle(itemTitle),
			description: result.errors
				? [
						...result.errors,
						...(named > 0 ? [staysInReview(named)] : []),
					].join("\n")
				: "Some changes could not be applied.",
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
