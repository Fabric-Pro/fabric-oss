/**
 * Unit tests for `saveConversationTurn` and `updateConversationSettings`
 * (Fizzy #2949).
 *
 * The Advisor used to save a finished turn by reading the conversation,
 * adding its turn, and writing the whole message list and metadata back, so
 * a turn another tab saved in between was lost. These functions make every
 * change to the row as it is under a `SELECT ... FOR UPDATE` lock. The tests
 * pin what they may and may not touch:
 *
 *   - messages and executions already stored (by another tab, or appended
 *     mid-turn) are kept; the turn is added to them;
 *   - a retried save adds nothing twice, and does not move the saved turn;
 *   - `removeMessageIds` removes only unstamped `user` messages, never a
 *     saved turn's question;
 *   - saving the same execution again replaces its messages where they
 *     stand, even under new message ids;
 *   - an execution record is replaced by id or added;
 *   - settings are merged onto the LOCKED metadata, never a client snapshot;
 *   - a late save of an earlier turn lands before a later turn's messages;
 *   - the turn lookups run on the transaction AFTER the row lock, so a later
 *     turn saved while this save waited for the lock is seen;
 *   - a turn key that names another user's, organization's or
 *     conversation's turn is refused and nothing is written;
 *   - a turn admitted with no conversation is claimed for this one by a
 *     conditional update, and the claim lasts while that conversation
 *     exists;
 *   - turn messages that repeat an id, or reuse the id of a stored message
 *     the turn does not own, are refused before any write;
 *   - the turn's messages fill, in order, the positions of the messages it
 *     owns, so a retry of the same turn — identical, or under regenerated
 *     message ids — leaves the array unchanged;
 *   - a wrong tenant reads zero rows and throws `ConversationNotFoundError`;
 *   - an organization is required;
 *   - the transaction is Read Committed (see `inRowLockTransaction`).
 *
 * `$queryRaw`, the turn lookups and the update are mocked; the row lock is
 * Postgres's job and is exercised by the real-database integration test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const queryRawMock = vi.fn();
	const updateMock = vi.fn();
	const turnFindUniqueMock = vi.fn();
	const turnFindManyMock = vi.fn();
	const turnUpdateManyMock = vi.fn();
	// Any turn read outside the transaction would be taken before the row
	// lock; the tests fail if one happens.
	const outsideTurnReadMock = vi.fn();
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
				conversationTurn: {
					findUnique: (...args: unknown[]) =>
						turnFindUniqueMock(...args),
					findMany: (...args: unknown[]) => turnFindManyMock(...args),
					updateMany: (...args: unknown[]) =>
						turnUpdateManyMock(...args),
				},
			}),
	);
	return {
		queryRawMock,
		updateMock,
		turnFindUniqueMock,
		turnFindManyMock,
		turnUpdateManyMock,
		outsideTurnReadMock,
		$transactionMock,
	};
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (
			fn: (tx: unknown) => Promise<unknown>,
			opts?: { isolationLevel?: string },
		) => mocks.$transactionMock(fn, opts),
		conversationTurn: {
			findUnique: (...args: unknown[]) =>
				mocks.outsideTurnReadMock(...args),
			findMany: (...args: unknown[]) =>
				mocks.outsideTurnReadMock(...args),
			updateMany: (...args: unknown[]) =>
				mocks.outsideTurnReadMock(...args),
		},
	},
	Prisma: {},
}));

import {
	ConversationNotFoundError,
	DuplicateTurnMessageIdError,
	saveConversationTurn,
	TurnMessageIdConflictError,
	updateConversationSettings,
} from "../prisma/queries/agent-conversations";

const USER_ID = "user-1";
const ORG_ID = "org-1";
const CONV_ID = "conv-1";
const EXEC_ID = "orch-exec-1";

function msg(id: string, role: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		role,
		content: `content of ${id}`,
		timestamp: "2026-10-06T10:00:00.000Z",
		...extra,
	} as {
		id: string;
		role: "user" | "assistant" | "system";
		content: string;
		timestamp: string;
		metadata?: Record<string, unknown>;
	};
}

const question = msg("q-mine", "user");
const answer = msg("a-mine", "assistant");
const execution = { id: EXEC_ID, userMessage: "mine", status: "complete" };

function stamped<T extends { metadata?: Record<string, unknown> }>(
	m: T,
	executionId = EXEC_ID,
) {
	return { ...m, metadata: { ...(m.metadata ?? {}), executionId } };
}

/** The locked row the transaction reads. */
function lockedRow(messages: unknown, metadata: unknown) {
	mocks.queryRawMock.mockResolvedValueOnce([{ messages, metadata }]);
}

function written(): {
	messages?: unknown[];
	metadata: Record<string, unknown>;
} {
	const args = mocks.updateMock.mock.calls[0]?.[0] as {
		where: { id: string };
		data: { messages?: unknown[]; metadata: Record<string, unknown> };
	};
	expect(args.where).toEqual({ id: CONV_ID });
	return args.data;
}

function save(overrides: Partial<Parameters<typeof saveConversationTurn>[0]>) {
	return saveConversationTurn({
		id: CONV_ID,
		userId: USER_ID,
		organizationId: ORG_ID,
		messages: [question, answer],
		execution,
		...overrides,
	});
}

beforeEach(() => {
	mocks.queryRawMock.mockReset();
	mocks.updateMock.mockReset();
	mocks.turnFindUniqueMock.mockReset();
	mocks.turnFindManyMock.mockReset();
	mocks.turnUpdateManyMock.mockReset();
	mocks.outsideTurnReadMock.mockReset();
	mocks.$transactionMock.mockClear();
	mocks.updateMock.mockResolvedValue({ id: CONV_ID });
	// Default: the execution id names this user's turn in this conversation,
	// and no later turn exists.
	mocks.turnFindUniqueMock.mockResolvedValue({
		userId: USER_ID,
		organizationId: ORG_ID,
		conversationId: CONV_ID,
		scopeConversationId: CONV_ID,
		generation: 1,
	});
	mocks.turnFindManyMock.mockResolvedValue([]);
});

describe("saveConversationTurn — keeps what others saved", () => {
	it("adds the turn after another tab's turn instead of replacing it", async () => {
		const otherQ = msg("q-other", "user");
		const otherA = msg("a-other", "assistant");
		lockedRow([otherQ, otherA], {
			mode: "orchestrator",
			executionMode: "balanced",
			executions: [{ id: "exec-other" }],
		});

		const result = await save({});

		expect(result).toEqual({ addedMessages: 2, removedMessages: 0 });
		const data = written();
		expect(data.messages).toEqual([
			otherQ,
			otherA,
			stamped(question),
			stamped(answer),
		]);
		expect(data.metadata.executions).toEqual([
			{ id: "exec-other" },
			execution,
		]);
		// Read Committed, not Serializable: a writer waiting on the row lock
		// must apply its change on top of the one before it, not fail with
		// a serialization error (shown in the real-database test).
		expect(mocks.$transactionMock.mock.calls[0]?.[1]).toMatchObject({
			isolationLevel: "ReadCommitted",
		});
	});

	it("keeps an execution stored in the row that the client never saw", async () => {
		lockedRow([], {
			mode: "orchestrator",
			executionMode: "deep",
			selectedMcpConfigIds: ["mcp_old"],
			executions: [{ id: "exec-from-other-tab" }],
		});

		await save({
			settings: {
				selectedMcpConfigIds: ["mcp_new"],
				instanceId: "inst-1",
			},
		});

		const { metadata } = written();
		expect(metadata.executions).toEqual([
			{ id: "exec-from-other-tab" },
			execution,
		]);
		expect(metadata.selectedMcpConfigIds).toEqual(["mcp_new"]);
		expect(metadata.instanceId).toBe("inst-1");
		expect(metadata.mode).toBe("orchestrator");
		expect(typeof metadata.lastUpdated).toBe("string");
	});

	it("keeps the stored execution mode; uses the given one only when none is stored", async () => {
		lockedRow([], { mode: "orchestrator", executionMode: "deep" });
		await save({ settings: { executionMode: "lite" } });
		expect(written().metadata.executionMode).toBe("deep");

		mocks.updateMock.mockClear();
		lockedRow([], null);
		await save({ settings: { executionMode: "lite" } });
		const { metadata } = written();
		expect(metadata.executionMode).toBe("lite");
		// A conversation with no metadata gets the Advisor's mode.
		expect(metadata.mode).toBe("orchestrator");
	});

	it("never replaces a stored engine mode (Fizzy #2040)", async () => {
		lockedRow([], { mode: "direct" });
		await save({});
		expect(written().metadata.mode).toBe("direct");
	});

	it("keeps the stored tool selection when none is given, and removes it on null", async () => {
		lockedRow([], {
			mode: "orchestrator",
			selectedMcpConfigIds: ["mcp_1"],
		});
		await save({ settings: {} });
		expect(written().metadata.selectedMcpConfigIds).toEqual(["mcp_1"]);

		mocks.updateMock.mockClear();
		lockedRow([], {
			mode: "orchestrator",
			selectedMcpConfigIds: ["mcp_1"],
		});
		await save({ settings: { selectedMcpConfigIds: null } });
		expect(written().metadata).not.toHaveProperty("selectedMcpConfigIds");
	});
});

describe("saveConversationTurn — idempotent retry", () => {
	it("adds nothing twice and replaces the execution record by id", async () => {
		const storedExecution = { id: EXEC_ID, status: "running" };
		lockedRow([stamped(question), stamped(answer)], {
			mode: "orchestrator",
			executions: [storedExecution, { id: "exec-later" }],
		});

		const result = await save({ removeMessageIds: [question.id] });

		expect(result).toEqual({ addedMessages: 0, removedMessages: 0 });
		const data = written();
		// An id that is also one of the turn's messages is not removed, so
		// the retry cannot move the saved turn to the end.
		expect(data.messages).toEqual([stamped(question), stamped(answer)]);
		expect(data.metadata.executions).toEqual([
			execution,
			{ id: "exec-later" },
		]);
	});

	it("adopts the question the conversation was created with, without a second copy", async () => {
		// The conversation was created holding the question under the id the
		// turn sends it with. The turn adopts it, and the answer follows it.
		const created = msg("q-mine", "user");
		const opResult = msg("op", "system");
		lockedRow([created, opResult], {
			mode: "orchestrator",
			executions: [],
		});

		const result = await save({});

		expect(result.addedMessages).toBe(1);
		expect(written().messages).toEqual([
			stamped(question),
			stamped(answer),
			opResult,
		]);
	});

	it("replaces an earlier save of the same execution where it stands, even under new message ids", async () => {
		const before = msg("q-0", "user");
		const firstQ = stamped(msg("q-first", "user"));
		const firstA = stamped(msg("a-first", "assistant"));
		const after = stamped(msg("q-2", "user"), "exec-later");
		lockedRow([before, firstQ, firstA, after], {
			mode: "orchestrator",
			executions: [{ id: EXEC_ID }, { id: "exec-later" }],
		});

		const result = await save({});

		expect(written().messages).toEqual([
			before,
			stamped(question),
			stamped(answer),
			after,
		]);
		expect(result).toEqual({ addedMessages: 2, removedMessages: 2 });
	});

	describe("refused message ids, before any write", () => {
		it("refuses turn messages that repeat an id", async () => {
			// Stored: an earlier save of this turn under the repeated id.
			lockedRow([stamped({ ...question, id: "same" })], {
				mode: "orchestrator",
			});
			const same = { ...question, id: "same" };
			const sameAnswer = { ...answer, id: "same" };

			const outcome = await save({ messages: [same, sameAnswer] }).catch(
				(error: unknown) => error,
			);

			// Without the check the retry would write both into one slot and
			// lose the question.
			expect(mocks.updateMock).not.toHaveBeenCalled();
			expect(outcome).toBeInstanceOf(DuplicateTurnMessageIdError);
			expect(mocks.$transactionMock).not.toHaveBeenCalled();
		});

		it("refuses an id that belongs to another turn's message", async () => {
			const othersQ = stamped(msg("q-mine", "user"), "exec-other");
			lockedRow([othersQ], { mode: "orchestrator" });

			await expect(save({})).rejects.toBeInstanceOf(
				TurnMessageIdConflictError,
			);
			expect(mocks.updateMock).not.toHaveBeenCalled();
		});

		it("refuses an id that belongs to an unstamped message of another role", async () => {
			const systemNamedLikeQuestion = msg("q-mine", "system");
			lockedRow([systemNamedLikeQuestion], { mode: "orchestrator" });

			await expect(save({})).rejects.toBeInstanceOf(
				TurnMessageIdConflictError,
			);
			expect(mocks.updateMock).not.toHaveBeenCalled();
		});
	});

	describe("a retry of the same turn leaves the array unchanged", () => {
		const opResult = msg("op", "system");
		const seed = msg("q-mine", "user");
		const eagerSeed = msg("eager-seed", "user");
		const clarification = msg("c-1", "user");
		const later = stamped(msg("q-2", "user"), "exec-later");
		type Layout = {
			label: string;
			initial: unknown[];
			payload: ReturnType<typeof msg>[];
			overrides?: Partial<Parameters<typeof saveConversationTurn>[0]>;
			later?: string[];
		};
		const layouts: Layout[] = [
			{
				label: "a seeded question followed by an operation result",
				initial: [seed, opResult],
				payload: [question, answer],
			},
			{
				label: "an eager seed removed, with an operation result kept",
				initial: [eagerSeed, opResult],
				payload: [question, answer],
				overrides: { removeMessageIds: ["eager-seed"] },
			},
			{
				label: "a late save placed before a later turn",
				initial: [opResult, later],
				payload: [question, clarification, answer],
				later: ["exec-later"],
			},
			{
				label: "an earlier save with an operation result inside the turn",
				initial: [stamped(question), opResult, stamped(answer), later],
				payload: [question, clarification, answer],
			},
			{
				label: "an empty conversation",
				initial: [],
				payload: [question, clarification, answer],
			},
		];

		function regenerated(payload: ReturnType<typeof msg>[]) {
			return payload.map((m) => ({ ...m, id: `${m.id}-regenerated` }));
		}

		for (const layout of layouts) {
			it(`after ${layout.label}, an identical retry and a regenerated-ids retry change nothing`, async () => {
				mocks.turnFindManyMock.mockResolvedValue(
					(layout.later ?? []).map((executionId) => ({
						executionId,
					})),
				);
				lockedRow(layout.initial, { mode: "orchestrator" });
				await save({ messages: layout.payload, ...layout.overrides });
				const first = written().messages ?? [];

				mocks.updateMock.mockClear();
				lockedRow(first, { mode: "orchestrator" });
				await save({ messages: layout.payload, ...layout.overrides });
				expect(JSON.stringify(written().messages)).toBe(
					JSON.stringify(first),
				);

				mocks.updateMock.mockClear();
				lockedRow(first, { mode: "orchestrator" });
				const renamed = regenerated(layout.payload);
				await save({ messages: renamed, ...layout.overrides });
				const ids = new Map(
					layout.payload.map((m, i) => [m.id, renamed[i]?.id]),
				);
				const expected = (first as Array<{ id: string }>).map((m) =>
					ids.has(m.id)
						? {
								...renamed.find((r) => r.id === ids.get(m.id)),
								metadata: { executionId: EXEC_ID },
							}
						: m,
				);
				expect(JSON.stringify(written().messages)).toBe(
					JSON.stringify(expected),
				);
			});
		}

		it("keeps an operation result inside the turn where it is on an identical retry", async () => {
			const stored = [stamped(question), opResult, stamped(answer)];
			lockedRow(stored, { mode: "orchestrator" });

			await save({});

			expect(JSON.stringify(written().messages)).toBe(
				JSON.stringify(stored),
			);
		});

		it("keeps the same layout on a retry under regenerated message ids", async () => {
			lockedRow([stamped(question), opResult, stamped(answer)], {
				mode: "orchestrator",
			});
			const question2 = msg("q-regenerated", "user");
			const answer2 = msg("a-regenerated", "assistant");

			await save({ messages: [question2, answer2] });

			expect(JSON.stringify(written().messages)).toBe(
				JSON.stringify([
					stamped(question2),
					opResult,
					stamped(answer2),
				]),
			);
		});

		it("puts a new clarification before the answer when the question and answer keep their ids", async () => {
			lockedRow([stamped(question), opResult, stamped(answer), later], {
				mode: "orchestrator",
			});

			await save({ messages: [question, clarification, answer] });

			// Payload order: question, clarification, answer. The turn's
			// messages fill its slots in order, and the extra one goes right
			// after its last slot, before the later turn.
			const result = written().messages;
			expect(result).toEqual([
				stamped(question),
				opResult,
				stamped(clarification),
				stamped(answer),
				later,
			]);

			// A regenerated-ids retry of that result changes nothing.
			mocks.updateMock.mockClear();
			lockedRow(result, { mode: "orchestrator" });
			const renamed = [question, clarification, answer].map((m) => ({
				...m,
				id: `${m.id}-r`,
			}));
			await save({ messages: renamed });
			expect(written().messages).toEqual([
				stamped(renamed[0] as typeof question),
				opResult,
				stamped(renamed[1] as typeof question),
				stamped(renamed[2] as typeof question),
				later,
			]);
		});

		it("drops a shorter retry's unfilled slots", async () => {
			lockedRow([stamped(question), opResult, stamped(answer)], {
				mode: "orchestrator",
			});

			await save({ messages: [question] });

			expect(written().messages).toEqual([stamped(question), opResult]);
		});
	});
});

describe("saveConversationTurn — removeMessageIds", () => {
	it("removes only user messages with the given ids and keeps the rest", async () => {
		const seed = msg("seed", "user");
		const opResult = msg("op", "system");
		const systemNamedLikeSeed = msg("refused", "system");
		lockedRow([seed, opResult, systemNamedLikeSeed], {
			mode: "orchestrator",
		});

		const result = await save({ removeMessageIds: ["seed", "refused"] });

		expect(result).toEqual({ addedMessages: 2, removedMessages: 1 });
		expect(written().messages).toEqual([
			opResult,
			systemNamedLikeSeed,
			stamped(question),
			stamped(answer),
		]);
	});

	it("never removes a saved turn's question, even when its id is listed", async () => {
		const savedQ = stamped(msg("q-saved", "user"), "exec-other");
		const savedA = stamped(msg("a-saved", "assistant"), "exec-other");
		lockedRow([savedQ, savedA], { mode: "orchestrator" });

		const result = await save({ removeMessageIds: ["q-saved"] });

		expect(result.removedMessages).toBe(0);
		expect(written().messages).toEqual([
			savedQ,
			savedA,
			stamped(question),
			stamped(answer),
		]);
	});
});

describe("saveConversationTurn — order", () => {
	it("places a late save of an earlier turn before a later turn's messages and execution", async () => {
		mocks.turnFindManyMock.mockResolvedValueOnce([
			{ executionId: "exec-later" },
		]);
		const earlierQ = msg("q-0", "user");
		const opResult = msg("op", "system");
		const laterQ = stamped(msg("q-2", "user"), "exec-later");
		const laterA = stamped(msg("a-2", "assistant"), "exec-later");
		lockedRow([earlierQ, opResult, laterQ, laterA], {
			mode: "orchestrator",
			executions: [{ id: "exec-0" }, { id: "exec-later" }],
		});

		await save({});

		const data = written();
		expect(data.messages).toEqual([
			earlierQ,
			opResult,
			stamped(question),
			stamped(answer),
			laterQ,
			laterA,
		]);
		expect(data.metadata.executions).toEqual([
			{ id: "exec-0" },
			execution,
			{ id: "exec-later" },
		]);
		// Later turns are looked up in this conversation, for this caller.
		expect(mocks.turnFindManyMock).toHaveBeenCalledWith({
			where: {
				userId: USER_ID,
				organizationId: ORG_ID,
				OR: [
					{ conversationId: CONV_ID },
					{ scopeConversationId: CONV_ID },
				],
				generation: { gt: 1 },
				executionId: { not: null },
			},
			select: { executionId: true },
		});
	});

	it("appends a save with no turn (the client's fallback id) at the end", async () => {
		mocks.turnFindUniqueMock.mockResolvedValueOnce(null);
		const laterQ = stamped(msg("q-2", "user"), "exec-later");
		lockedRow([laterQ], { mode: "orchestrator", executions: [] });

		await save({ execution: { id: "exec-1791300000000" } });

		expect(written().messages).toEqual([
			laterQ,
			stamped(question, "exec-1791300000000"),
			stamped(answer, "exec-1791300000000"),
		]);
		expect(mocks.turnFindManyMock).not.toHaveBeenCalled();
	});

	/**
	 * The later-turn lookup must see a turn that was admitted and saved
	 * while this save waited for the row lock, so it has to run on the
	 * transaction after the lock, never on the base client before it.
	 */
	it("looks the turns up on the transaction after taking the row lock", async () => {
		lockedRow([], { mode: "orchestrator" });

		await save({});

		expect(mocks.outsideTurnReadMock).not.toHaveBeenCalled();
		const lockedAt = mocks.queryRawMock.mock.invocationCallOrder[0] ?? 0;
		const turnReadAt =
			mocks.turnFindUniqueMock.mock.invocationCallOrder[0] ?? -1;
		const laterReadAt =
			mocks.turnFindManyMock.mock.invocationCallOrder[0] ?? -1;
		expect(turnReadAt).toBeGreaterThan(lockedAt);
		expect(laterReadAt).toBeGreaterThan(lockedAt);
	});
});

describe("saveConversationTurn — the turn key", () => {
	const foreignTurns = [
		["another user's", { userId: "user-2" }],
		["another organization's", { organizationId: "org-2" }],
		[
			"another conversation's",
			{ conversationId: "conv-2", scopeConversationId: "conv-2" },
		],
	] as const;

	for (const [label, override] of foreignTurns) {
		it(`refuses an execution id that names ${label} turn, writing nothing`, async () => {
			lockedRow([], { mode: "orchestrator" });
			mocks.turnFindUniqueMock.mockResolvedValueOnce({
				userId: USER_ID,
				organizationId: ORG_ID,
				conversationId: CONV_ID,
				scopeConversationId: CONV_ID,
				generation: 1,
				...override,
			});

			await expect(save({})).rejects.toBeInstanceOf(
				ConversationNotFoundError,
			);
			expect(mocks.turnUpdateManyMock).not.toHaveBeenCalled();
			expect(mocks.updateMock).not.toHaveBeenCalled();
		});
	}

	describe("a turn admitted with no conversation", () => {
		const unattached = {
			userId: USER_ID,
			organizationId: ORG_ID,
			conversationId: null,
			scopeConversationId: null,
			generation: null,
		};

		it("is claimed for this conversation, and the turn is saved at the end", async () => {
			const existing = stamped(msg("q-2", "user"), "exec-later");
			lockedRow([existing], { mode: "orchestrator", executions: [] });
			mocks.turnFindUniqueMock.mockResolvedValueOnce(unattached);
			mocks.turnUpdateManyMock.mockResolvedValueOnce({ count: 1 });

			await save({});

			expect(mocks.turnUpdateManyMock).toHaveBeenCalledWith({
				where: {
					executionId: EXEC_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					conversationId: null,
					scopeConversationId: null,
				},
				data: { conversationId: CONV_ID },
			});
			// No generation: not ordered against other turns.
			expect(mocks.turnFindManyMock).not.toHaveBeenCalled();
			expect(written().messages).toEqual([
				existing,
				stamped(question),
				stamped(answer),
			]);
		});

		it("is saved when a concurrent save already associated it with this same conversation", async () => {
			lockedRow([], { mode: "orchestrator" });
			mocks.turnFindUniqueMock
				.mockResolvedValueOnce(unattached)
				.mockResolvedValueOnce({
					...unattached,
					conversationId: CONV_ID,
				});
			mocks.turnUpdateManyMock.mockResolvedValueOnce({ count: 0 });

			await expect(save({})).resolves.toMatchObject({ addedMessages: 2 });
		});

		it("is refused when a concurrent save associated it with another conversation", async () => {
			lockedRow([], { mode: "orchestrator" });
			mocks.turnFindUniqueMock
				.mockResolvedValueOnce(unattached)
				.mockResolvedValueOnce({
					...unattached,
					conversationId: "conv-2",
				});
			mocks.turnUpdateManyMock.mockResolvedValueOnce({ count: 0 });

			await expect(save({})).rejects.toBeInstanceOf(
				ConversationNotFoundError,
			);
			expect(mocks.updateMock).not.toHaveBeenCalled();
		});

		it("is refused for another user's unattached turn, without claiming it", async () => {
			lockedRow([], { mode: "orchestrator" });
			mocks.turnFindUniqueMock.mockResolvedValueOnce({
				...unattached,
				userId: "user-2",
			});

			await expect(save({})).rejects.toBeInstanceOf(
				ConversationNotFoundError,
			);
			expect(mocks.turnUpdateManyMock).not.toHaveBeenCalled();
		});

		/**
		 * The claim lasts while the claiming conversation exists. Deleting
		 * it nulls the turn's `conversationId` through the foreign key, and
		 * the turn reads as unattached again, so a later save into another
		 * of the same user's conversations claims it. Kept on purpose: it
		 * stays within one user and organization, and the first
		 * conversation is gone.
		 */
		it("can be claimed again after the conversation that claimed it was deleted", async () => {
			lockedRow([], { mode: "orchestrator" });
			// What the row reads after its claiming conversation was
			// deleted: the foreign key cleared `conversationId`, and
			// `scopeConversationId` was never set.
			mocks.turnFindUniqueMock.mockResolvedValueOnce(unattached);
			mocks.turnUpdateManyMock.mockResolvedValueOnce({ count: 1 });

			await expect(
				save({ id: "conv-after-deletion" }),
			).resolves.toMatchObject({
				addedMessages: 2,
			});
			expect(mocks.turnUpdateManyMock).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						conversationId: null,
						scopeConversationId: null,
					}),
					data: { conversationId: "conv-after-deletion" },
				}),
			);
		});
	});

	it("accepts the turn of a conversation matched by its kept scope id", async () => {
		mocks.turnFindUniqueMock.mockResolvedValueOnce({
			userId: USER_ID,
			organizationId: ORG_ID,
			conversationId: null,
			scopeConversationId: CONV_ID,
			generation: 3,
		});
		lockedRow([], { mode: "orchestrator" });

		await expect(save({})).resolves.toEqual({
			addedMessages: 2,
			removedMessages: 0,
		});
	});

	it("rejects a missing execution id without touching the database", async () => {
		await expect(
			save({ execution: { id: "" } as unknown as typeof execution }),
		).rejects.toThrow(/execution\.id is required/);
		expect(mocks.turnFindUniqueMock).not.toHaveBeenCalled();
		expect(mocks.queryRawMock).not.toHaveBeenCalled();
	});
});

describe("saveConversationTurn — tenant isolation", () => {
	it("throws ConversationNotFoundError and writes nothing when no row matches the user and tenant", async () => {
		mocks.queryRawMock.mockResolvedValueOnce([]);

		await expect(save({ userId: "someone-else" })).rejects.toBeInstanceOf(
			ConversationNotFoundError,
		);
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});

	it("locks the row scoped to the user and the organization, reading messages and metadata", async () => {
		lockedRow([], {});

		await save({});

		const [strings, ...values] = mocks.queryRawMock.mock.calls[0] as [
			ArrayLike<string>,
			...unknown[],
		];
		const sql = Array.from(strings).join("?");
		expect(sql).toContain("SELECT messages, metadata");
		expect(sql).toContain('FROM "agent_conversation"');
		expect(sql).toContain('"userId" = ?');
		expect(sql).toContain('"organizationId" = ?');
		expect(sql).toMatch(/FOR UPDATE$/);
		expect(values).toEqual([CONV_ID, USER_ID, ORG_ID]);
	});

	for (const organizationId of [null, undefined, ""]) {
		it(`refuses organizationId=${JSON.stringify(organizationId)} without reading anything`, async () => {
			await expect(
				save({ organizationId: organizationId as unknown as string }),
			).rejects.toBeInstanceOf(ConversationNotFoundError);
			expect(mocks.turnFindUniqueMock).not.toHaveBeenCalled();
			expect(mocks.queryRawMock).not.toHaveBeenCalled();
			expect(mocks.updateMock).not.toHaveBeenCalled();
		});
	}
});

describe("updateConversationSettings", () => {
	function update(
		overrides: Partial<Parameters<typeof updateConversationSettings>[0]>,
	) {
		return updateConversationSettings({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			settings: {},
			...overrides,
		});
	}

	it("merges the settings onto the locked metadata and never touches executions or messages", async () => {
		lockedRow([msg("q", "user")], {
			mode: "orchestrator",
			executionMode: "balanced",
			selectedMcpConfigIds: ["mcp_old"],
			// Saved by another tab after the client loaded its snapshot.
			executions: [{ id: "exec-a" }, { id: "exec-b" }],
		});

		await update({
			settings: {
				executionMode: "deep",
				selectedMcpConfigIds: ["mcp_new"],
				instanceId: "inst-1",
			},
		});

		const data = written();
		expect(data).not.toHaveProperty("messages");
		expect(data.metadata).toMatchObject({
			mode: "orchestrator",
			executionMode: "deep",
			selectedMcpConfigIds: ["mcp_new"],
			instanceId: "inst-1",
			executions: [{ id: "exec-a" }, { id: "exec-b" }],
		});
	});

	it("removes the tool selection on null", async () => {
		lockedRow([], { mode: "orchestrator", selectedMcpConfigIds: ["x"] });

		await update({ settings: { selectedMcpConfigIds: null } });

		expect(written().metadata).not.toHaveProperty("selectedMcpConfigIds");
	});

	it("throws ConversationNotFoundError for a row outside the user and tenant", async () => {
		mocks.queryRawMock.mockResolvedValueOnce([]);

		await expect(update({ userId: "someone-else" })).rejects.toBeInstanceOf(
			ConversationNotFoundError,
		);
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});

	for (const organizationId of [null, undefined, ""]) {
		it(`refuses organizationId=${JSON.stringify(organizationId)} without reading the row`, async () => {
			await expect(
				update({ organizationId: organizationId as unknown as string }),
			).rejects.toBeInstanceOf(ConversationNotFoundError);
			expect(mocks.queryRawMock).not.toHaveBeenCalled();
		});
	}
});
