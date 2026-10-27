import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	update: vi.fn(),
	create: vi.fn(),
	raw: vi.fn(),
	findFirst: vi.fn(),
}));
vi.mock("../prisma/client", () => {
	const client = {
		conversationTurn: {
			findUnique: m.read,
			update: m.update,
			create: m.create,
			findFirst: m.findFirst,
		},
		$queryRaw: m.raw,
		$executeRaw: vi.fn(),
	};
	return {
		db: {
			...client,
			$transaction: async (fn: (tx: typeof client) => unknown) =>
				fn(client),
		},
	};
});

import {
	admitConversationTurn,
	finalizeConversationTurn,
	getConversationTurnContinuationSnapshot,
} from "../prisma/queries/conversation-turns";

const scope = {
	turnId: "example-turn",
	executionId: "example-execution",
	userId: "example-user",
	organizationId: "example-org",
};
let row: Record<string, unknown>;
beforeEach(() => {
	vi.clearAllMocks();
	row = {
		id: scope.turnId,
		...scope,
		status: "ACTIVE",
		tokenAllowance: 500000,
		measuredTokens: 475000n,
		outstandingTokens: 1000n,
		budgetEnforcement: "ENFORCED",
		budgetStop: null,
	};
	m.raw.mockResolvedValue([{ id: scope.turnId }]);
	m.read.mockImplementation(async () => ({ ...row }));
	m.update.mockImplementation(async ({ data }) => {
		row = { ...row, ...data };
		return { ...row };
	});
});
const ledgerStop = {
	version: 1,
	kind: "token_allowance",
	allowance: 500000,
	measured: 1,
	outstanding: 0,
	enforcement: null,
	stopReason: "allowance_exhausted",
} as const;
const localStops = [
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
] as const;
describe("terminal budget records", () => {
	it("keeps authoritative ledger totals under the turn lock", async () => {
		const result = await finalizeConversationTurn({
			...scope,
			outcome: "LIMITED",
			budgetStop: ledgerStop,
		});
		expect(result).toMatchObject({
			status: "LIMITED",
			budgetStop: {
				...ledgerStop,
				measured: 475000,
				outstanding: 1000,
				enforcement: "ENFORCED",
			},
		});
		expect(m.update.mock.calls[0][0].data.budgetStop).toEqual(
			(result as { budgetStop: unknown }).budgetStop,
		);
	});
	it.each(localStops)(
		"persists %j and returns the first terminal payload on retry",
		async (budgetStop) => {
			const first = await finalizeConversationTurn({
				...scope,
				outcome: "LIMITED",
				budgetStop,
			});
			expect(first).toMatchObject({ budgetStop });
			expect(m.update.mock.calls[0][0].data.budgetStop).toEqual(
				budgetStop,
			);
			row.measuredTokens = 499999n;
			const retry = await finalizeConversationTurn({
				...scope,
				outcome: "LIMITED",
				budgetStop: ledgerStop,
			});
			expect(retry).toMatchObject({
				outcome: "already_terminal",
				budgetStop,
			});
			expect(m.update).toHaveBeenCalledOnce();
		},
	);
	it("keeps a pre-change turn's frozen 500k allowance when admission now offers 1M", async () => {
		row = {
			...row,
			scopeConversationId: "example-conversation",
			startToken: "example-start-token",
			clientRequestKey: "example-request-key",
			budgetContractVersion: 1,
			finalizationReserveTokens: 8000,
		};
		const admitted = await admitConversationTurn({
			...scope,
			conversationId: "example-conversation",
			clientRequestKey: "example-request-key",
			executionMode: "balanced",
			budget: {
				contractVersion: 1,
				tokenAllowance: 1000000,
				finalizationReserveTokens: 8000,
			},
		});
		expect(admitted).toMatchObject({
			outcome: "existing",
			turn: { tokenAllowance: 500000 },
		});
		expect(m.create).not.toHaveBeenCalled();
		expect(m.update).not.toHaveBeenCalled();
	});
	it("scopes both continuation reads to the user, organization and conversation", async () => {
		m.findFirst.mockResolvedValue(null);
		await getConversationTurnContinuationSnapshot({
			...scope,
			conversationId: "example-conversation",
		});
		const where = {
			userId: scope.userId,
			organizationId: scope.organizationId,
			conversationId: "example-conversation",
		};
		expect(m.findFirst.mock.calls.map((c) => c[0].where)).toEqual([
			{ ...where, id: scope.turnId },
			{ ...where, generation: { not: null }, executionId: { not: null } },
		]);
	});
});
