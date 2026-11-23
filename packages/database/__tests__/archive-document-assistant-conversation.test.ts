/**
 * Unit tests for `archiveDocumentAssistantConversation`'s row order.
 *
 * `appendTurnForDocument` locks the conversation row and then updates the
 * thread's join row. Archive writes both rows too, so it must take them in
 * the same order, conversation first, or the two transactions can deadlock.
 * The client is mocked; the lock itself is Postgres's job, so these tests
 * check that the lock is issued before either row is written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const calls: string[] = [];
	const tx = {
		$queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
			calls.push(`queryRaw:${strings.join("?")}`);
			return [{ id: "conv-1" }];
		}),
		documentAssistantConversation: {
			findUniqueOrThrow: vi.fn(async () => {
				calls.push("join.findUniqueOrThrow");
				return { conversationId: "conv-1" };
			}),
			update: vi.fn(async () => {
				calls.push("join.update");
				return { id: "join-1", conversationId: "conv-1" };
			}),
		},
		agentConversation: {
			update: vi.fn(async () => {
				calls.push("conversation.update");
				return { id: "conv-1" };
			}),
		},
	};
	const $transactionMock = vi.fn(
		async (fn: (client: unknown) => Promise<unknown>) => await fn(tx),
	);
	return { calls, tx, $transactionMock };
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (fn: (client: unknown) => Promise<unknown>) =>
			mocks.$transactionMock(fn),
	},
	Prisma: {},
}));

import { archiveDocumentAssistantConversation } from "../prisma/queries/document-assistant-conversation";

beforeEach(() => {
	mocks.calls.length = 0;
	vi.clearAllMocks();
});

describe("archiveDocumentAssistantConversation — row order", () => {
	it("locks the conversation row before it writes the join row", async () => {
		const join = await archiveDocumentAssistantConversation({
			id: "join-1",
		});

		expect(join).toEqual({ id: "join-1", conversationId: "conv-1" });
		expect(mocks.$transactionMock).toHaveBeenCalledTimes(1);
		expect(mocks.calls).toEqual([
			"join.findUniqueOrThrow",
			'queryRaw:SELECT id FROM "agent_conversation" WHERE id = ? FOR UPDATE',
			"join.update",
			"conversation.update",
		]);
		expect(mocks.tx.$queryRaw).toHaveBeenCalledWith(
			expect.anything(),
			"conv-1",
		);
		expect(
			mocks.tx.documentAssistantConversation.findUniqueOrThrow,
		).toHaveBeenCalledWith({
			where: { id: "join-1" },
			select: { conversationId: true },
		});
		expect(
			mocks.tx.documentAssistantConversation.update,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "join-1" },
				data: { archivedAt: expect.any(Date) },
			}),
		);
		expect(mocks.tx.agentConversation.update).toHaveBeenCalledWith({
			where: { id: "conv-1" },
			data: { status: "ARCHIVED" },
		});
	});

	it("writes nothing when the thread does not exist", async () => {
		mocks.tx.documentAssistantConversation.findUniqueOrThrow.mockRejectedValueOnce(
			new Error("No DocumentAssistantConversation found"),
		);

		await expect(
			archiveDocumentAssistantConversation({ id: "join-missing" }),
		).rejects.toThrow("No DocumentAssistantConversation found");
		expect(mocks.tx.$queryRaw).not.toHaveBeenCalled();
		expect(
			mocks.tx.documentAssistantConversation.update,
		).not.toHaveBeenCalled();
		expect(mocks.tx.agentConversation.update).not.toHaveBeenCalled();
	});
});
