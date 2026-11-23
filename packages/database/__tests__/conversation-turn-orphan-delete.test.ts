/**
 * A turn still running when its conversation was deleted keeps its row until
 * it ends (its workflow writes it). The write that ends it then deletes it,
 * so no turn outlives its conversation. The delete is conditional: only a
 * terminal turn that lost its conversation (`conversationId` null) but was
 * created for one (`scopeConversationId` set). A turn of a surface with no
 * conversation has neither and is kept.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORPHANED = {
	conversationId: null,
	scopeConversationId: { not: null },
	status: { in: ["COMPLETED", "FAILED", "LIMITED", "CANCELLED"] },
};

const mocks = vi.hoisted(() => {
	const calls: string[] = [];
	const conversationTurn = {
		findUnique: vi.fn(async () => ({
			id: "turn-1",
			executionId: "exec-1",
			userId: "user-1",
			organizationId: "org-1",
			status: "ACTIVE",
			budgetStop: null,
			tokenAllowance: null,
			measuredTokens: null,
			outstandingTokens: null,
			budgetEnforcement: null,
		})),
		update: vi.fn(async () => {
			calls.push("update");
			return { status: "COMPLETED", budgetStop: null };
		}),
		updateMany: vi.fn(async () => {
			calls.push("updateMany");
			return { count: 1 };
		}),
		deleteMany: vi.fn(async (_args: { where: Record<string, unknown> }) => {
			calls.push("deleteMany");
			return { count: 1 };
		}),
	};
	const tx = {
		$queryRaw: vi.fn(async () => [{ id: "turn-1" }]),
		conversationTurn,
	};
	return {
		calls,
		conversationTurn,
		transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
			fn(tx),
		),
	};
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: mocks.transaction,
		conversationTurn: mocks.conversationTurn,
	},
}));

import {
	abandonConversationTurnStart,
	finalizeConversationTurn,
	finalizeOrphanedConversationTurn,
} from "../prisma/queries/conversation-turns";

beforeEach(() => {
	mocks.calls.length = 0;
	vi.clearAllMocks();
});

describe("a turn whose conversation was deleted while it ran", () => {
	it("is deleted by the write that ends it, after that write", async () => {
		const result = await finalizeConversationTurn({
			turnId: "turn-1",
			executionId: "exec-1",
			userId: "user-1",
			organizationId: "org-1",
			outcome: "COMPLETED",
		});

		expect(result).toMatchObject({ outcome: "finalized" });
		expect(mocks.conversationTurn.deleteMany).toHaveBeenCalledWith({
			where: { id: "turn-1", ...ORPHANED },
		});
		expect(mocks.calls).toEqual(["update", "deleteMany"]);
	});

	it("is deleted when the reconcile ends it, or its start is abandoned", async () => {
		await finalizeOrphanedConversationTurn({
			turnId: "turn-1",
			executionId: "exec-1",
			userId: "user-1",
			organizationId: "org-1",
			observedStatus: "ACTIVE",
			observedUpdatedAt: new Date("2026-11-20T10:00:00.000Z"),
			terminalReason: "workflow not found",
		});
		await abandonConversationTurnStart({
			turnId: "turn-1",
			executionId: "exec-1",
			startToken: "token-1",
			cancelled: false,
			reason: "refused: 429",
		});

		expect(mocks.conversationTurn.deleteMany).toHaveBeenCalledTimes(2);
		for (const [args] of mocks.conversationTurn.deleteMany.mock.calls) {
			expect(args).toEqual({ where: { id: "turn-1", ...ORPHANED } });
		}
	});

	it("is not touched when the write ended nothing", async () => {
		mocks.conversationTurn.updateMany.mockResolvedValue({ count: 0 });

		await finalizeOrphanedConversationTurn({
			turnId: "turn-1",
			executionId: "exec-1",
			userId: "user-1",
			organizationId: "org-1",
			observedStatus: "ACTIVE",
			observedUpdatedAt: new Date("2026-11-20T10:00:00.000Z"),
			terminalReason: "workflow not found",
		});

		expect(mocks.conversationTurn.deleteMany).not.toHaveBeenCalled();
	});
});
