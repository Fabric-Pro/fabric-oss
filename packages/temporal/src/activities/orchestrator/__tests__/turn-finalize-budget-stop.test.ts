/**
 * The terminal write returns the token-allowance stop exactly as the turn
 * row stores it — on the first write and on a retry whose first attempt
 * committed — so the live stream, the row and a reconnect agree. The
 * activity builds no payload of its own: the totals are refreshed under the
 * turn row's lock inside `finalizeConversationTurn` (pinned against a real
 * Postgres in conversation-turn-ledger.integration.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	finalize: vi.fn(),
	snapshot: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	finalizeConversationTurn: db.finalize,
	getConversationTurnLedgerSnapshot: db.snapshot,
}));

import { finalizeConversationTurnActivity } from "../turn-finalize";

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 1,
	budgetContractVersion: 1,
};

/** The workflow's stop, from its last ledger reading. */
const WORKFLOW_STOP = {
	kind: "token_allowance" as const,
	allowance: 500_000,
	measured: 470_000,
	outstanding: 25_000,
	enforcement: "ENFORCED" as const,
	stopReason: "allowance_exhausted" as const,
};

/** What the row stores: the ledger's totals at the first terminal write. */
const STORED = {
	kind: "token_allowance",
	measured: 476_000,
	allowance: 500_000,
	enforcement: "ENFORCED",
	stopReason: "allowance_exhausted",
	outstanding: 3_000,
};

beforeEach(() => {
	db.finalize.mockReset();
	db.snapshot.mockReset();
});

describe("finalizeConversationTurnActivity — budget stop", () => {
	it("sends the stop reason and the workflow's reading, and returns the payload the row stores", async () => {
		db.finalize.mockResolvedValue({
			outcome: "finalized",
			status: "LIMITED",
			budgetStop: STORED,
		});
		const result = await finalizeConversationTurnActivity({
			turnScope: SCOPE,
			outcome: "LIMITED",
			budgetStop: WORKFLOW_STOP,
		});
		expect(db.finalize).toHaveBeenCalledWith(
			expect.objectContaining({
				budgetStop: {
					stopReason: "allowance_exhausted",
					allowance: 500_000,
					measured: 470_000,
					outstanding: 25_000,
					enforcement: "ENFORCED",
				},
			}),
		);
		expect(result).toEqual({
			status: "LIMITED",
			wrote: true,
			budgetStop: STORED,
		});
		expect(JSON.stringify(result.budgetStop)).toBe(JSON.stringify(STORED));
		// No separate ledger read builds a payload of its own.
		expect(db.snapshot).not.toHaveBeenCalled();
	});

	it("returns the originally stored payload when a retry finds the turn already terminal, whatever the workflow sends", async () => {
		// The first attempt committed and returned STORED; its response was
		// lost. The retry carries a newer reading.
		db.finalize
			.mockResolvedValueOnce({
				outcome: "finalized",
				status: "LIMITED",
				budgetStop: STORED,
			})
			.mockResolvedValueOnce({
				outcome: "already_terminal",
				status: "LIMITED",
				budgetStop: STORED,
			});
		const first = await finalizeConversationTurnActivity({
			turnScope: SCOPE,
			outcome: "LIMITED",
			budgetStop: WORKFLOW_STOP,
		});
		const retry = await finalizeConversationTurnActivity({
			turnScope: SCOPE,
			outcome: "LIMITED",
			budgetStop: {
				...WORKFLOW_STOP,
				measured: 481_000,
				outstanding: 2_000,
				enforcement: "MEASURED_ONLY",
			},
		});
		expect(retry).toEqual({
			status: "LIMITED",
			wrote: false,
			budgetStop: STORED,
		});
		expect(JSON.stringify(retry.budgetStop)).toBe(
			JSON.stringify(first.budgetStop),
		);
		expect(db.snapshot).not.toHaveBeenCalled();
	});

	it("returns no stop when the row stores none", async () => {
		db.finalize.mockResolvedValue({
			outcome: "already_terminal",
			status: "FAILED",
			budgetStop: null,
		});
		const result = await finalizeConversationTurnActivity({
			turnScope: SCOPE,
			outcome: "LIMITED",
			budgetStop: WORKFLOW_STOP,
		});
		expect(result).toEqual({ status: "FAILED", wrote: false });
	});

	it("sends no stop for a turn that did not stop on its allowance", async () => {
		db.finalize.mockResolvedValue({
			outcome: "finalized",
			status: "COMPLETED",
			budgetStop: null,
		});
		const result = await finalizeConversationTurnActivity({
			turnScope: SCOPE,
			outcome: "COMPLETED",
		});
		expect(db.finalize.mock.calls[0]?.[0]).not.toHaveProperty("budgetStop");
		expect(result).toEqual({ status: "COMPLETED", wrote: true });
	});
});
