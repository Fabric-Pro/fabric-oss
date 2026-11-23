/**
 * Deleting a conversation removes its finished turns in the same
 * transaction. The turn's conversation FK is `SetNull`, so before this the
 * turns, with the question and answer text they hold, outlived the
 * conversation. A turn still running keeps its row: its workflow writes it
 * until it ends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const calls: string[] = [];
	const tx = {
		conversationTurn: {
			findMany: vi.fn(
				async (
					_args: unknown,
				): Promise<
					Array<{
						userId: string;
						organizationId: string;
						clientRequestKey: string;
					}>
				> => [],
			),
			deleteMany: vi.fn(
				async (_args: { where: { status: { in: string[] } } }) => {
					calls.push("conversationTurn.deleteMany");
					return { count: 0 };
				},
			),
		},
		agentConversation: {
			delete: vi.fn(async (_args: unknown) => {
				calls.push("agentConversation.delete");
				return { id: "conv-1" };
			}),
		},
	};
	return {
		calls,
		tx,
		findFirst: vi.fn(),
		transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
			fn(tx),
		),
	};
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: mocks.transaction,
		agentConversation: { findFirst: mocks.findFirst },
	},
}));

import { deleteAgentConversation } from "../prisma/queries/agent-conversations";
import {
	CONVERSATION_TURN_TERMINAL_STATUSES,
	deleteFinishedTurnsOfConversations,
} from "../prisma/queries/conversation-turns";
import { deleteDocumentAssistantConversationByConversationId } from "../prisma/queries/document-assistant-conversation";

const finishedTurnsOf = (ids: string[]) => ({
	where: {
		conversationId: { in: ids },
		status: { in: [...CONVERSATION_TURN_TERMINAL_STATUSES] },
	},
});

beforeEach(() => {
	mocks.calls.length = 0;
	mocks.tx.conversationTurn.deleteMany.mockClear();
	mocks.tx.conversationTurn.findMany.mockClear();
	mocks.tx.agentConversation.delete.mockClear();
	mocks.transaction.mockClear();
	mocks.findFirst.mockReset();
});

describe("deleting a conversation removes its finished turns", () => {
	it("deletes the finished turns, then the conversation, in one transaction", async () => {
		mocks.findFirst.mockResolvedValue({ id: "conv-1" });

		await deleteAgentConversation({
			id: "conv-1",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.tx.conversationTurn.deleteMany).toHaveBeenCalledWith(
			finishedTurnsOf(["conv-1"]),
		);
		expect(mocks.calls).toEqual([
			"conversationTurn.deleteMany",
			"agentConversation.delete",
		]);
	});

	it("leaves the turns when the conversation is not the caller's", async () => {
		mocks.findFirst.mockResolvedValue(null);

		await expect(
			deleteAgentConversation({
				id: "conv-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toThrow(/not found or access denied/);

		expect(mocks.tx.conversationTurn.deleteMany).not.toHaveBeenCalled();
	});

	it("does the same for a document assistant conversation", async () => {
		await deleteDocumentAssistantConversationByConversationId({
			conversationId: "conv-2",
		});

		expect(mocks.tx.conversationTurn.deleteMany).toHaveBeenCalledWith(
			finishedTurnsOf(["conv-2"]),
		);
		expect(mocks.calls).toEqual([
			"conversationTurn.deleteMany",
			"agentConversation.delete",
		]);
	});

	it("never deletes a turn that is still running", async () => {
		await deleteFinishedTurnsOfConversations(mocks.tx as never, ["conv-3"]);

		const statuses =
			mocks.tx.conversationTurn.deleteMany.mock.calls[0]?.[0].where.status
				.in;
		expect(statuses).toEqual([
			"COMPLETED",
			"FAILED",
			"LIMITED",
			"CANCELLED",
		]);
	});

	it("also deletes the finished turns of a multi-agent turn's other agents", async () => {
		mocks.tx.conversationTurn.findMany.mockResolvedValueOnce([
			{
				userId: "user-1",
				organizationId: "org-1",
				clientRequestKey: "ma_example-key",
			},
		]);

		await deleteFinishedTurnsOfConversations(mocks.tx as never, ["conv-4"]);

		expect(mocks.tx.conversationTurn.findMany).toHaveBeenCalledWith({
			where: {
				conversationId: { in: ["conv-4"] },
				clientRequestKey: { startsWith: "ma_" },
			},
			select: {
				userId: true,
				organizationId: true,
				clientRequestKey: true,
			},
		});
		expect(mocks.tx.conversationTurn.deleteMany).toHaveBeenNthCalledWith(
			1,
			{
				where: {
					conversationId: null,
					status: { in: [...CONVERSATION_TURN_TERMINAL_STATUSES] },
					OR: [
						{
							userId: "user-1",
							organizationId: "org-1",
							clientRequestKey: {
								startsWith: "ma_example-key_a",
							},
						},
					],
				},
			},
		);
		expect(mocks.tx.conversationTurn.deleteMany).toHaveBeenNthCalledWith(
			2,
			finishedTurnsOf(["conv-4"]),
		);
	});

	it("does nothing for no conversations", async () => {
		await deleteFinishedTurnsOfConversations(mocks.tx as never, []);

		expect(mocks.tx.conversationTurn.deleteMany).not.toHaveBeenCalled();
	});
});
