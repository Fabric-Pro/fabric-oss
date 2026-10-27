import { describe, expect, it } from "vitest";
import { parseTurnBudgetStop } from "../turn-budget-stop";

const stops = [
	{ version: 1, kind: "time_limit", used: 2700, limit: 2700 },
	{ version: 1, kind: "round_limit", used: 30, limit: 30 },
	{
		version: 1,
		kind: "token_budget",
		used: 992001,
		limit: 992000,
		maxTokens: 1000000,
		reservedTokens: 8000,
	},
	{
		version: 1,
		kind: "token_allowance",
		allowance: 1000000,
		measured: 990000,
		outstanding: 0,
		enforcement: "ENFORCED",
		stopReason: "allowance_exhausted",
	},
];
describe("versioned budget stops", () => {
	it.each(stops)("accepts %j", (stop) =>
		expect(parseTurnBudgetStop(stop)).toEqual(stop),
	);
	it.each([
		null,
		[],
		{},
		{ version: 1, kind: "future" },
		{ ...stops[0], version: 2 },
		{ ...stops[0], used: -1 },
		{ ...stops[0], limit: Number.POSITIVE_INFINITY },
		{
			...stops.find((stop) => stop.kind === "token_budget"),
			reservedTokens: undefined,
		},
	])("ignores malformed or unknown stop %j", (stop) =>
		expect(parseTurnBudgetStop(stop)).toBeUndefined(),
	);
});
