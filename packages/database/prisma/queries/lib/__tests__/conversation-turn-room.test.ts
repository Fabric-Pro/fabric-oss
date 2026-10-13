/**
 * The turn token ledger's admission arithmetic, shared by the reservation
 * transaction and the finalization synthesis that sizes its request to it.
 * The real-Postgres suite (conversation-turn-ledger.integration.test.ts)
 * covers the transaction around it.
 */

import { describe, expect, it } from "vitest";
import {
	conversationTurnRoom,
	planConversationTurnReservation,
} from "../conversation-turn-room";

const TOTALS = {
	allowance: 100_000,
	finalizationReserve: 8_000,
	measured: 88_000,
	outstanding: 1_500,
};

describe("conversationTurnRoom", () => {
	it("holds the finalization reserve back from everything but FINALIZATION", () => {
		expect(conversationTurnRoom(TOTALS, "FINALIZATION")).toBe(10_500);
		expect(conversationTurnRoom(TOTALS, "EXPLORATION")).toBe(2_500);
		expect(conversationTurnRoom(TOTALS, "AUXILIARY")).toBe(2_500);
	});
});

describe("planConversationTurnReservation", () => {
	const plan = (
		overrides: Partial<
			Parameters<typeof planConversationTurnReservation>[0]
		>,
	) =>
		planConversationTurnReservation({
			totals: TOTALS,
			kind: "FINALIZATION",
			inputEstimate: 8_500,
			requestedOutputTokens: 2_000,
			minOutputTokens: 1_024,
			enforced: true,
			...overrides,
		});

	it("admits a request of exactly the room with the cap it asked for", () => {
		expect(plan({})).toEqual({
			outcome: "fits",
			outputCap: 2_000,
			reservedTokens: 10_500,
		});
	});

	it("lowers an enforced cap to the room, down to the floor, and refuses below it", () => {
		expect(plan({ inputEstimate: 9_000 })).toEqual({
			outcome: "fits",
			outputCap: 1_500,
			reservedTokens: 10_500,
		});
		expect(plan({ inputEstimate: 9_476 })).toMatchObject({
			outcome: "fits",
			outputCap: 1_024,
		});
		expect(plan({ inputEstimate: 9_477 })).toEqual({
			outcome: "exhausted",
			room: 10_500,
			needed: 10_501,
		});
	});

	it("reserves what an uncapped model asked for, on the same floor", () => {
		expect(plan({ enforced: false, inputEstimate: 9_000 })).toEqual({
			outcome: "fits",
			outputCap: null,
			reservedTokens: 11_000,
		});
	});

	it("refuses anything once the room is used up", () => {
		expect(
			plan({
				totals: { ...TOTALS, measured: 98_500 },
				inputEstimate: 0,
				requestedOutputTokens: 0,
				minOutputTokens: 0,
			}),
		).toEqual({ outcome: "exhausted", room: 0, needed: 0 });
	});
});
