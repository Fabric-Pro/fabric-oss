/**
 * A chat turn that stopped because it used its token allowance. The live
 * stream's `completed` event and a reconnect (from the turn record) carry the
 * same structured payload; the chat branches on its `kind`, never on the
 * stop's wording. Counts are tokens; `outstanding` is not measured usage
 * (unsettled reservations and requests whose usage is unknown).
 */
import type { OrchestratorWorkflowOutput } from "@repo/temporal";
export type TurnBudgetStop = NonNullable<
	OrchestratorWorkflowOutput["budgetStop"]
>;

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
	if (record.version !== undefined && record.version !== 1) {
		return undefined;
	}
	if (
		record.version === 1 &&
		(record.kind === "round_limit" ||
			record.kind === "token_budget" ||
			record.kind === "time_limit")
	) {
		const used = count(record.used);
		const limit = count(record.limit);
		if (used === null || limit === null) {
			return undefined;
		}
		if (record.kind === "round_limit" || record.kind === "time_limit") {
			return { version: 1, kind: record.kind, used, limit };
		}
		const maxTokens = count(record.maxTokens);
		const reservedTokens = count(record.reservedTokens);
		return maxTokens === null || reservedTokens === null
			? undefined
			: {
					version: 1,
					kind: "token_budget",
					used,
					limit,
					maxTokens,
					reservedTokens,
				};
	}
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
		...(record.version === 1 ? { version: 1 as const } : {}),
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

/** Only terminal turns can offer a budget continuation. */
export function budgetStopToShow(
	status: string,
	budgetStop: TurnBudgetStop | undefined,
): TurnBudgetStop | undefined {
	return ["completed", "limited", "failed", "cancelled"].includes(
		status.toLowerCase(),
	)
		? budgetStop
		: undefined;
}
