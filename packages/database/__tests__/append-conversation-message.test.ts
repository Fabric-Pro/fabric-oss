/**
 * Unit tests for `appendConversationMessage` — Fizzy #1412 §2.1.
 *
 * Covers:
 *   - Happy path: lock → scan → append in serializable tx, returns the
 *     persisted message + deduplicated=false.
 *   - Idempotency: appending a message with an `operationKey` that
 *     already exists in the conversation's messages array returns the
 *     existing message + deduplicated=true, without writing.
 *   - Concurrency: three parallel appends (two with same operationKey,
 *     one different) result in exactly TWO unique messages persisted,
 *     and exactly ONE of the three returned values is marked
 *     deduplicated=true. Rationale: the call graph has two unique keys
 *     (key-A and key-B), so two appends WIN the race (one per key); the
 *     third call — the second arrival for key-A — sees the first
 *     key-A's write inside the locked tx and returns
 *     deduplicated=true. This is the AC-5 idempotency assertion.
 *   - Wrong-tenant: `SELECT ... FOR UPDATE` returning zero rows throws
 *     a generic Error (mirror of record-diff-outcome's NOT_FOUND). We
 *     never reveal whether the row exists in another tenant.
 *   - Schema guard: input missing `metadata.operationKey` rejects.
 *
 * NOTE on the lock-then-scan rule (plan §2.1 #1): the test for
 * concurrency intentionally inverts the order of resolution between two
 * parallel appends with the same operationKey. The implementation must
 * serialize them inside a single tx via `SELECT ... FOR UPDATE` so the
 * second arrival sees the first's write when it scans. Pre-lock scans
 * would race here.
 *
 * The Postgres-side row lock is simulated by a single-slot async mutex
 * inside the mock — that's what `FOR UPDATE` provides at the application
 * boundary; the real DB's behavior is Postgres's responsibility.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	type Row = { messages: unknown[] };
	const rows: Record<string, Row> = {};
	const lockedRows = new Set<string>();
	const waiters: Record<string, Array<() => void>> = {};

	function acquireLock(id: string): Promise<void> {
		if (!lockedRows.has(id)) {
			lockedRows.add(id);
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const list = waiters[id] ?? [];
			list.push(resolve);
			waiters[id] = list;
		});
	}

	function releaseLock(id: string): void {
		const w = waiters[id];
		if (w && w.length > 0) {
			const next = w.shift();
			// Stay locked; transfer ownership.
			if (next) {
				next();
				return;
			}
		}
		lockedRows.delete(id);
	}

	const queryRawMock = vi.fn();
	const updateMock = vi.fn();

	const $transactionMock = vi.fn(
		async (
			fn: (tx: unknown) => Promise<unknown>,
			_opts?: { isolationLevel?: string },
		) => {
			const tx = {
				$queryRaw: (..._args: unknown[]) => queryRawMock(..._args),
				$queryRawUnsafe: (..._args: unknown[]) =>
					queryRawMock(..._args),
				agentConversation: {
					update: (..._args: unknown[]) => updateMock(..._args),
				},
			};
			const result = await fn(tx);
			return result;
		},
	);

	return {
		rows,
		lockedRows,
		waiters,
		queryRawMock,
		updateMock,
		$transactionMock,
		acquireLock,
		releaseLock,
	};
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

import { appendConversationMessage } from "../prisma/queries/agent-conversations";

const USER_ID = "user-1";
const ORG_ID = "org-1";
const CONV_ID = "conv-1";

function makeMessage(
	overrides: Partial<{
		id: string;
		content: string;
		operationKey: string;
	}> = {},
): {
	id: string;
	role: "system";
	content: string;
	timestamp: string;
	metadata: { operationKey: string } & Record<string, unknown>;
} {
	return {
		id: overrides.id ?? "msg-1",
		role: "system",
		content: overrides.content ?? "Operation completed successfully.",
		timestamp: "2026-05-27T10:00:00.000Z",
		metadata: { operationKey: overrides.operationKey ?? "op-key-1" },
	};
}

beforeEach(() => {
	mocks.queryRawMock.mockReset();
	mocks.updateMock.mockReset();
	// `mockReset` (NOT `mockClear`) restores the default implementation
	// that the `vi.hoisted` factory installed. Tests that override the
	// implementation (e.g. the concurrency test that simulates Postgres
	// row locking) must re-install it; otherwise the override would
	// leak into subsequent tests and the default queryRawMock /
	// updateMock paths would never fire.
	mocks.$transactionMock.mockReset();
	mocks.$transactionMock.mockImplementation(
		async (
			fn: (tx: unknown) => Promise<unknown>,
			_opts?: { isolationLevel?: string },
		) => {
			const tx = {
				$queryRaw: (..._args: unknown[]) =>
					mocks.queryRawMock(..._args),
				$queryRawUnsafe: (..._args: unknown[]) =>
					mocks.queryRawMock(..._args),
				agentConversation: {
					update: (..._args: unknown[]) => mocks.updateMock(..._args),
				},
			};
			return await fn(tx);
		},
	);
	// Reset row-store state across tests.
	for (const k of Object.keys(mocks.rows)) {
		delete mocks.rows[k];
	}
	mocks.lockedRows.clear();
	for (const k of Object.keys(mocks.waiters)) {
		delete mocks.waiters[k];
	}
});

describe("appendConversationMessage — happy path", () => {
	it("appends a message to an empty conversation and returns deduplicated=false", async () => {
		mocks.queryRawMock.mockResolvedValueOnce([{ messages: [] }]);
		mocks.updateMock.mockResolvedValueOnce({ id: CONV_ID });

		const message = makeMessage();
		const result = await appendConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			message,
		});

		expect(result.deduplicated).toBe(false);
		expect(result.persisted).toEqual(message);
		expect(mocks.$transactionMock).toHaveBeenCalledTimes(1);
		// Verify Serializable isolation was requested.
		const txOpts = mocks.$transactionMock.mock.calls[0]?.[1];
		expect(txOpts).toMatchObject({ isolationLevel: "Serializable" });
		// One queryRaw (the SELECT FOR UPDATE), one update.
		expect(mocks.queryRawMock).toHaveBeenCalledTimes(1);
		expect(mocks.updateMock).toHaveBeenCalledTimes(1);
		// The update payload appended the new message.
		const updateArgs = mocks.updateMock.mock.calls[0]?.[0] as {
			where: { id: string };
			data: { messages: unknown };
		};
		expect(updateArgs.where).toEqual({ id: CONV_ID });
		expect(updateArgs.data.messages).toEqual([message]);
	});

	it("appends to a conversation with existing non-system messages", async () => {
		const existing = [
			{ id: "u-1", role: "user", content: "hi", timestamp: "t1" },
		];
		mocks.queryRawMock.mockResolvedValueOnce([{ messages: existing }]);
		mocks.updateMock.mockResolvedValueOnce({ id: CONV_ID });

		const message = makeMessage({ id: "sys-1", operationKey: "op-key-A" });
		const result = await appendConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			message,
		});

		expect(result.deduplicated).toBe(false);
		const updateArgs = mocks.updateMock.mock.calls[0]?.[0] as {
			data: { messages: unknown[] };
		};
		expect(updateArgs.data.messages).toHaveLength(2);
		expect(updateArgs.data.messages[1]).toEqual(message);
	});
});

describe("appendConversationMessage — idempotency by operationKey", () => {
	it("returns deduplicated=true when an existing message has the same operationKey", async () => {
		const existingSystem = {
			id: "existing-sys-1",
			role: "system",
			content: "Operation completed",
			timestamp: "2026-05-27T09:00:00.000Z",
			metadata: { operationKey: "duplicate-key" },
		};
		mocks.queryRawMock.mockResolvedValueOnce([
			{ messages: [existingSystem] },
		]);

		const result = await appendConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			message: makeMessage({
				id: "new-sys-id",
				operationKey: "duplicate-key",
			}),
		});

		expect(result.deduplicated).toBe(true);
		expect(result.persisted).toEqual(existingSystem);
		// Critically: no write happens on dedup.
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});

	it("appends when operationKey differs from all existing operation keys", async () => {
		const existingSystem = {
			id: "existing-sys-1",
			role: "system",
			content: "Op A completed",
			timestamp: "t",
			metadata: { operationKey: "op-key-A" },
		};
		mocks.queryRawMock.mockResolvedValueOnce([
			{ messages: [existingSystem] },
		]);
		mocks.updateMock.mockResolvedValueOnce({ id: CONV_ID });

		const result = await appendConversationMessage({
			id: CONV_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			message: makeMessage({ operationKey: "op-key-B" }),
		});

		expect(result.deduplicated).toBe(false);
		expect(mocks.updateMock).toHaveBeenCalledTimes(1);
	});
});

describe("appendConversationMessage — concurrency", () => {
	it("concurrent same-operationKey: 3 calls (2 same-key + 1 different) → 2 messages persisted, 1 dedup", async () => {
		// Simulate Postgres SELECT FOR UPDATE: only one tx can hold the
		// lock at a time. The mock $transaction is overridden here to
		// serialize via a single-slot mutex on CONV_ID, and the
		// queryRawMock returns the *current* row contents (mutated by
		// previous appends). updateMock writes back the new messages
		// array — which the next lock holder reads.
		const messagesState: unknown[] = [];

		mocks.$transactionMock.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) => {
				await mocks.acquireLock(CONV_ID);
				try {
					const tx = {
						$queryRaw: vi
							.fn()
							.mockResolvedValue([
								{ messages: [...messagesState] },
							]),
						$queryRawUnsafe: vi
							.fn()
							.mockResolvedValue([
								{ messages: [...messagesState] },
							]),
						agentConversation: {
							update: vi
								.fn()
								.mockImplementation(
									async (args: {
										where: { id: string };
										data: { messages: unknown[] };
									}) => {
										// Replace the state with the
										// caller's new messages array.
										messagesState.length = 0;
										for (const m of args.data.messages) {
											messagesState.push(m);
										}
										return { id: args.where.id };
									},
								),
						},
					};
					return await fn(tx);
				} finally {
					mocks.releaseLock(CONV_ID);
				}
			},
		);

		const msgA1 = makeMessage({ id: "a-1", operationKey: "key-A" });
		const msgA2 = makeMessage({ id: "a-2", operationKey: "key-A" });
		const msgB = makeMessage({ id: "b-1", operationKey: "key-B" });

		const results = await Promise.all([
			appendConversationMessage({
				id: CONV_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
				message: msgA1,
			}),
			appendConversationMessage({
				id: CONV_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
				message: msgA2,
			}),
			appendConversationMessage({
				id: CONV_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
				message: msgB,
			}),
		]);

		// Final state: exactly TWO messages (one for key-A, one for key-B).
		expect(messagesState).toHaveLength(2);
		const keys = (
			messagesState as Array<{ metadata: { operationKey: string } }>
		)
			.map((m) => m.metadata.operationKey)
			.sort();
		expect(keys).toEqual(["key-A", "key-B"]);

		// Exactly two of three returns are deduplicated=true (the third
		// new key-B and one new key-A win the race; the second key-A
		// arrival is dedup'd).
		const dedupCount = results.filter((r) => r.deduplicated).length;
		expect(dedupCount).toBe(1);
	});
});

describe("appendConversationMessage — tenant isolation", () => {
	it("throws when SELECT FOR UPDATE returns zero rows (wrong tenant or missing)", async () => {
		mocks.queryRawMock.mockResolvedValueOnce([]);

		await expect(
			appendConversationMessage({
				id: CONV_ID,
				userId: USER_ID,
				organizationId: "wrong-org",
				message: makeMessage(),
			}),
		).rejects.toThrow(/not found/i);

		// No write attempted.
		expect(mocks.updateMock).not.toHaveBeenCalled();
	});
});

describe("appendConversationMessage — input contract", () => {
	it("rejects when message.metadata.operationKey is missing", async () => {
		await expect(
			appendConversationMessage({
				id: CONV_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
				// biome-ignore lint/suspicious/noExplicitAny: testing input contract violation
				message: {
					id: "x",
					role: "system",
					content: "hi",
					timestamp: "t",
					metadata: {},
				} as any,
			}),
		).rejects.toThrow(/operationKey/);
		expect(mocks.queryRawMock).not.toHaveBeenCalled();
	});

	it("rejects when message.metadata is missing entirely", async () => {
		await expect(
			appendConversationMessage({
				id: CONV_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
				// biome-ignore lint/suspicious/noExplicitAny: testing input contract violation
				message: {
					id: "x",
					role: "system",
					content: "hi",
					timestamp: "t",
				} as any,
			}),
		).rejects.toThrow(/operationKey/);
	});
});

describe("appendConversationMessage — SQL identifier regression guard", () => {
	// The AgentConversation model is mapped to the snake_case Postgres
	// table `agent_conversation` via `@@map` in schema.prisma. The
	// previous implementation used `"AgentConversation"` (the Prisma
	// MODEL name) in the `$queryRaw` SELECT, which Postgres rejects
	// with `42P01: relation "AgentConversation" does not exist`. The
	// resulting raw error is untyped, so the procedure layer's
	// `instanceof ConversationNotFoundError` catch path is bypassed and
	// the caller gets an opaque `500 Internal server error` (no
	// stacktrace surfaces through Vercel runtime logs either).
	//
	// Unit tests mock `$queryRaw` entirely, so they never see the SQL
	// string — that's how the bug shipped to staging and only surfaced
	// when the first live caller (PR #1235 BacklogChat / PR #1240
	// StoryWorkspace / PR #1255 DocumentEditor) actually exercised the
	// procedure end-to-end against a real Postgres.
	//
	// This regression test pins the rendered SQL identifier so a
	// future revert or accidental refactor toward the Prisma model
	// name fails at unit-test time, not in production.
	const ID = "conv-sql-guard";
	const USER = "user-sql-guard";

	for (const tenant of ["undefined", "null", "string"] as const) {
		it(`uses the snake_case table name (organizationId=${tenant})`, async () => {
			mocks.queryRawMock.mockResolvedValueOnce([{ messages: [] }]);
			mocks.updateMock.mockResolvedValueOnce({ id: ID });

			const organizationId =
				tenant === "undefined"
					? undefined
					: tenant === "null"
						? null
						: ORG_ID;

			await appendConversationMessage({
				id: ID,
				userId: USER,
				organizationId,
				message: makeMessage({
					id: "m-sql-guard",
					operationKey: `op-sql-guard-${tenant}`,
				}),
			});

			const firstCall = mocks.queryRawMock.mock.calls[0];
			expect(firstCall).toBeTruthy();
			const strings = firstCall?.[0] as ArrayLike<string> | undefined;
			expect(strings).toBeTruthy();
			const rendered = Array.from(strings ?? []).join("");

			// MUST use the snake_case table name (the DB-level identifier
			// set via `@@map("agent_conversation")` in schema.prisma).
			expect(rendered).toContain('FROM "agent_conversation"');

			// MUST NOT use the Prisma model name — Postgres would reject
			// with 42P01 "relation does not exist".
			expect(rendered).not.toMatch(/FROM\s+"AgentConversation"/);
		});
	}
});
