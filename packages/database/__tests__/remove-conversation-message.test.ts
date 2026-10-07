/**
 * Unit tests for `removeConversationMessage` (Fizzy #2958).
 *
 * The Advisor creates a new chat already holding its first question, before
 * the server admits the turn. When the server refuses that question because
 * another message in the conversation is being answered, the chat removes
 * it. These tests pin what the removal may and may not touch:
 *
 *   - only the `user` message with the given id goes; every other message,
 *     including ones another turn saved after the seed, stays;
 *   - nothing is written when no such message is left (idempotent);
 *   - a wrong user or tenant reads zero rows under the lock and throws
 *     `ConversationNotFoundError` without writing;
 *   - an organization is required: a missing, null or empty one is refused
 *     before the row is read, so no unfiltered or personal read exists;
 *   - the read is a tenant-scoped `SELECT ... FOR UPDATE` inside a
 *     Serializable transaction, on the snake_case table name.
 *
 * `$queryRaw` and the update are mocked; the row lock itself is Postgres's
 * job, so these tests check the query is issued, not that Postgres honours
 * it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const queryRawMock = vi.fn();
	const updateMock = vi.fn();
	const $transactionMock = vi.fn(
		async (
			fn: (tx: unknown) => Promise<unknown>,
			_opts?: { isolationLevel?: string },
		) =>
			await fn({
				$queryRaw: (...args: unknown[]) => queryRawMock(...args),
				agentConversation: {
					update: (...args: unknown[]) => updateMock(...args),
				},
			}),
	);
	return { queryRawMock, updateMock, $transactionMock };
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (
			fn: (tx: unknown) => Promise<unknown>,
			opts?: { isolationLevel?: string },
		) => mocks.$transactionMock(fn, opts),
	},
	Prisma: {},
}));

import {
	ConversationNotFoundError,
	removeConversationMessage,
} from "../prisma/queries/agent-conversations";

const USER_ID = "user-1";
const ORG_ID = "org-1";
const CONV_ID = "conv-1";
const SEED_ID = "msg-seed";

const seed = {
	id: SEED_ID,
	role: "user",
	content: "Review the last commits",
	timestamp: "2026-10-06T10:00:00.000Z",
};

beforeEach(() => {
	mocks.queryRawMock.mockReset();
	mocks.updateMock.mockReset();
	mocks.$transactionMock.mockClear();
	mocks.updateMock.mockResolvedValue({ id: CONV_ID });
});

function writtenMessages(): unknown[] {
	const args = mocks.updateMock.mock.calls[0]?.[0] as {
		where: { id: string };
		data: { messages: unknown[] };
	};
	expect(args.where).toEqual({ id: CONV_ID });
	return args.data.messages;
}

describe("removeConversationMessage — removal", () => {
	it("removes the seeded question and keeps messages saved after it", async () => {
		// Another tab's turn saved its own question and answer into the new
		// conversation between the seed and the refusal.
		const otherQuestion = {
			id: "msg-other",
			role: "user",
			content: "Other tab's question",
			timestamp: "2026-10-06T10:00:01.000Z",
		};
		const otherAnswer = {
			id: "msg-answer",
			role: "assistant",
			content: "Other tab's answer",
			timestamp: "2026-10-06T10:00:05.000Z",
		};
		mocks.queryRawMock.mockResolvedValueOnce([
			{ messages: [seed, otherQuestion, otherAnswer] },
		]);

		const result = await removeConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			messageId: SEED_ID,
		});

		expect(result).toEqual({ removed: true });
		expect(mocks.updateMock).toHaveBeenCalledTimes(1);
		expect(writtenMessages()).toEqual([otherQuestion, otherAnswer]);
		expect(mocks.$transactionMock.mock.calls[0]?.[1]).toMatchObject({
			isolationLevel: "Serializable",
		});
	});

	it("removes only a user message: a non-user message with the id stays", async () => {
		const systemWithSameId = {
			id: SEED_ID,
			role: "system",
			content: "Operation result",
			timestamp: "2026-10-06T10:00:02.000Z",
		};
		mocks.queryRawMock.mockResolvedValueOnce([
			{ messages: [systemWithSameId] },
		]);

		const result = await removeConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			messageId: SEED_ID,
		});

		expect(result).toEqual({ removed: false });
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});

	it("writes nothing when the message is already gone", async () => {
		const kept = { ...seed, id: "msg-kept" };
		mocks.queryRawMock.mockResolvedValueOnce([{ messages: [kept] }]);

		const result = await removeConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			messageId: SEED_ID,
		});

		expect(result).toEqual({ removed: false });
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});

	it("treats a row with no messages array as empty", async () => {
		mocks.queryRawMock.mockResolvedValueOnce([{ messages: null }]);

		const result = await removeConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			messageId: SEED_ID,
		});

		expect(result).toEqual({ removed: false });
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});
});

describe("removeConversationMessage — tenant isolation", () => {
	it("throws ConversationNotFoundError and writes nothing when no row matches the user and tenant", async () => {
		mocks.queryRawMock.mockResolvedValueOnce([]);

		await expect(
			removeConversationMessage({
				id: CONV_ID,
				userId: "someone-else",
				organizationId: "other-org",
				messageId: SEED_ID,
			}),
		).rejects.toBeInstanceOf(ConversationNotFoundError);
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});

	it("locks the row scoped to the user and the organization", async () => {
		mocks.queryRawMock.mockResolvedValueOnce([{ messages: [seed] }]);

		await removeConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			messageId: SEED_ID,
		});

		const [strings, ...values] = mocks.queryRawMock.mock.calls[0] as [
			ArrayLike<string>,
			...unknown[],
		];
		const sql = Array.from(strings).join("?");
		expect(sql).toContain('FROM "agent_conversation"');
		expect(sql).toContain('"userId" = ?');
		expect(sql).toContain('"organizationId" = ?');
		expect(sql).toMatch(/FOR UPDATE$/);
		expect(values).toEqual([CONV_ID, USER_ID, ORG_ID]);
	});

	// There is no personal or unfiltered variant: the helper's `IS NULL` and
	// no-filter arms must be unreachable from this removal, even for a caller
	// that gets past the type.
	for (const organizationId of [null, undefined, ""]) {
		it(`refuses organizationId=${JSON.stringify(organizationId)} without reading the row`, async () => {
			mocks.queryRawMock.mockResolvedValue([{ messages: [seed] }]);

			await expect(
				removeConversationMessage({
					id: CONV_ID,
					userId: USER_ID,
					organizationId: organizationId as unknown as string,
					messageId: SEED_ID,
				}),
			).rejects.toBeInstanceOf(ConversationNotFoundError);
			expect(mocks.queryRawMock).not.toHaveBeenCalled();
			expect(mocks.updateMock).not.toHaveBeenCalled();
		});
	}
});
