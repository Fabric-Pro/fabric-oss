/**
 * A chat turn that stopped because it used its token allowance. The live
 * stream's `completed` event and a reconnect (from the turn record) carry the
 * same structured payload; the chat branches on its `kind`, never on the
 * stop's wording. Counts are tokens; `outstanding` is not measured usage
 * (unsettled reservations and requests whose usage is unknown).
 */
export interface TurnBudgetStop {
	kind: "token_allowance";
	allowance: number;
	measured: number;
	outstanding: number;
	enforcement: "ENFORCED" | "MEASURED_ONLY" | null;
	stopReason: "allowance_exhausted" | "finalization_unavailable";
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/** Reads a budget stop off an SSE event; undefined when absent or malformed. */
export function parseTurnBudgetStop(
	value: unknown,
): TurnBudgetStop | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const allowance = count(record.allowance);
	const measured = count(record.measured);
	const outstanding = count(record.outstanding);
	if (
		record.kind !== "token_allowance" ||
		allowance === null ||
		measured === null ||
		outstanding === null
	) {
		return undefined;
	}
	return {
		kind: "token_allowance",
		allowance,
		measured,
		outstanding,
		enforcement:
			record.enforcement === "ENFORCED" ||
			record.enforcement === "MEASURED_ONLY"
				? record.enforcement
				: null,
		stopReason:
			record.stopReason === "finalization_unavailable"
				? "finalization_unavailable"
				: "allowance_exhausted",
	};
}

/**
 * The stop the chat shows a budget card for: only a turn that completed. A
 * cancelled or failed turn keeps its stored payload (the live event and a
 * reconnect both carry what the row stores) and shows no budget card,
 * because it did not end on its allowance as far as the user is concerned.
 */
export function budgetStopToShow(
	status: string,
	budgetStop: TurnBudgetStop | undefined,
): TurnBudgetStop | undefined {
	return status === "completed" ? budgetStop : undefined;
}
