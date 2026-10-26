/**
 * The turn token ledger's admission arithmetic (pure). The reservation
 * transaction (`reserveConversationTurnAttempt`) runs it on the turn row it
 * has locked; the finalization synthesis runs the same functions on a ledger
 * reading to size its request to the room a reservation will find, so the
 * two cannot disagree about what fits.
 */

/** The ledger totals the admission arithmetic reads. */
export interface ConversationTurnRoomTotals {
	allowance: number;
	finalizationReserve: number;
	/** Settled usage. */
	measured: number;
	/** Unsettled reservations plus UNKNOWN conservative charges. */
	outstanding: number;
}

/** The attempt kinds the arithmetic distinguishes. */
export type ConversationTurnRoomKind =
	| "EXPLORATION"
	| "FINALIZATION"
	| "AUXILIARY";

/**
 * Tokens a request of `kind` may still reserve:
 *
 *   allowance − measured − outstanding
 *             − finalizationReserve (unless the request is FINALIZATION)
 *
 * May be zero or negative when the allowance is used up.
 */
export function conversationTurnRoom(
	totals: ConversationTurnRoomTotals,
	kind: ConversationTurnRoomKind,
): number {
	const reserve = kind === "FINALIZATION" ? 0 : totals.finalizationReserve;
	return totals.allowance - reserve - totals.measured - totals.outstanding;
}

export type ConversationTurnReservationPlan =
	| {
			outcome: "fits";
			/**
			 * The output cap to send (an enforced model), or null when the
			 * model cannot be capped.
			 */
			outputCap: number | null;
			/** What the reservation charges: input plus the output it allows. */
			reservedTokens: number;
	  }
	| {
			outcome: "exhausted";
			/** Tokens left for this kind of request (never negative). */
			room: number;
			/** Tokens the smallest acceptable request would need. */
			needed: number;
	  };

/**
 * Whether one request fits the room left, and with what output cap.
 * Reservations use the full input estimate: cache hits are known only after
 * the response. Deliberately, room smaller than a full minimum reservation
 * cannot be used even if a later cache discount would make the request fit. The
 * counts must already be non-negative integers.
 *
 * An enforced model's output cap is `min(requested, room − inputEstimate)`;
 * below `minOutputTokens` (or below what the request asks for, when it asks
 * for less) the request is refused. A model that cannot be capped reserves
 * `inputEstimate + requested` and is refused on the same floor.
 */
export function planConversationTurnReservation(args: {
	totals: ConversationTurnRoomTotals;
	kind: ConversationTurnRoomKind;
	inputEstimate: number;
	requestedOutputTokens: number;
	minOutputTokens: number;
	enforced: boolean;
}): ConversationTurnReservationPlan {
	const room = conversationTurnRoom(args.totals, args.kind);
	const outputRoom = room - args.inputEstimate;
	// The smallest output worth sending: the floor, or less when the request
	// itself asks for less (an embedding asks for none).
	const minimumOutput = Math.min(
		args.minOutputTokens,
		args.requestedOutputTokens,
	);
	if (room <= 0 || outputRoom < minimumOutput) {
		return {
			outcome: "exhausted",
			room: Math.max(room, 0),
			needed: args.inputEstimate + minimumOutput,
		};
	}
	const outputCap = args.enforced
		? Math.min(args.requestedOutputTokens, outputRoom)
		: null;
	return {
		outcome: "fits",
		outputCap,
		reservedTokens:
			args.inputEstimate +
			(outputCap === null ? args.requestedOutputTokens : outputCap),
	};
}
