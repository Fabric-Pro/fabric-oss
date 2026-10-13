/**
 * The daily sweep of per-source ChatGPT plan rows whose source is gone
 * (Fizzy #3038): each candidate is checked again under its source's own
 * advisory lock, and its rows are deleted only after that lock and that
 * check, so a source that came back meanwhile keeps them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	/** What the candidate query returns. */
	candidates: [] as Array<{ sourceKind: "USER" | "ORG"; sourceId: string }>,
	/** The candidate query's SQL text and bound values. */
	query: null as { text: string; values: unknown[] } | null,
	/** Sources that exist when the sweep checks again under the lock. */
	existingUsers: new Set<string>(),
	existingAccounts: new Set<string>(),
	/** Sources whose transaction fails. */
	failing: new Set<string>(),
	/** Runs as each transaction starts, with its number. */
	onTransaction: null as ((n: number) => void) | null,
	/** How many times the candidate query ran. */
	queries: 0,
	/** Each transaction's steps, in order: `<n>:<step>`. */
	steps: [] as string[],
	/** Each transaction's advisory lock key. */
	locks: [] as number[],
	deletes: [] as Array<{ table: string; where: unknown }>,
	transactions: 0,
}));

vi.mock("../prisma/client", () => {
	const makeTx = (n: number) => {
		const step = (name: string) => db.steps.push(`${n}:${name}`);
		const deleteMany =
			(table: string, count: number) =>
			async ({ where }: { where: { sourceId: string } }) => {
				step(`delete ${table}`);
				if (db.failing.has(where.sourceId)) {
					throw new Error(
						"lock wait exceeded the transaction timeout",
					);
				}
				db.deletes.push({ table, where });
				return { count };
			};
		return {
			$executeRaw: async (
				_sql: TemplateStringsArray,
				_class: number,
				key: number,
			) => {
				step("lock");
				db.locks.push(key);
				return 1;
			},
			chatGptPlanCredential: {
				findUnique: async ({
					where,
				}: {
					where: { userId: string };
				}) => {
					step(`check user ${where.userId}`);
					return db.existingUsers.has(where.userId)
						? { id: "cred_1" }
						: null;
				},
			},
			chatGptPlanOrgAccount: {
				findUnique: async ({ where }: { where: { id: string } }) => {
					step(`check account ${where.id}`);
					return db.existingAccounts.has(where.id)
						? { id: where.id }
						: null;
				},
			},
			chatGptPlanSourceState: { deleteMany: deleteMany("state", 1) },
			chatGptPlanServedModel: { deleteMany: deleteMany("served", 3) },
			chatGptPlanBudgetObservation: {
				deleteMany: deleteMany("observations", 2),
			},
			chatGptPlanWindowAccuracy: {
				deleteMany: deleteMany("accuracy", 4),
			},
		};
	};
	return {
		db: {
			$queryRaw: async (
				sql: TemplateStringsArray,
				...values: unknown[]
			) => {
				db.steps.push("find candidates");
				db.query = { text: sql.join("?"), values };
				db.queries += 1;
				// Emulates the keyset page: the bound values are the cursor's
				// kind (twice), its id, then the limit. Candidates are given
				// in the query's order; the `>` here is the text order the
				// SQL uses (asserted separately against the SQL text).
				const [afterKind, , afterId, limit] = values as [
					string | null,
					string | null,
					string | null,
					number,
				];
				return db.candidates
					.filter(
						(c) =>
							afterKind === null ||
							c.sourceKind > afterKind ||
							(c.sourceKind === afterKind &&
								c.sourceId > (afterId as string)),
					)
					.slice(0, limit);
			},
			$transaction: async (work: (tx: unknown) => unknown) => {
				db.transactions += 1;
				db.onTransaction?.(db.transactions);
				return work(makeTx(db.transactions));
			},
		},
	};
});

import {
	chatGptPlanSourceSweepSourceWorstCaseMs,
	sweepOrphanedChatGptPlanSourceRows,
} from "../prisma/queries/chatgpt-plan-source-sweep";
import {
	advisoryObjectKey,
	chatGptPlanLockKey,
	chatGptPlanOrgAccountLockKey,
	REFRESH_LOCK_MAX_WAIT_MS,
	REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
} from "../prisma/queries/lib/refresh-lock-key";

const GONE_USER = { sourceKind: "USER" as const, sourceId: "user_gone" };
const GONE_ACCOUNT = { sourceKind: "ORG" as const, sourceId: "acc_gone" };

beforeEach(() => {
	db.candidates = [];
	db.query = null;
	db.existingUsers = new Set();
	db.existingAccounts = new Set();
	db.failing = new Set();
	db.onTransaction = null;
	db.queries = 0;
	db.steps = [];
	db.locks = [];
	db.deletes = [];
	db.transactions = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sweepOrphanedChatGptPlanSourceRows", () => {
	it("sweeps each kind under that source's own lock, the one its writers take", async () => {
		db.candidates = [GONE_ACCOUNT, GONE_USER];
		const result = await sweepOrphanedChatGptPlanSourceRows({ limit: 50 });

		expect(db.locks).toEqual([
			advisoryObjectKey(chatGptPlanOrgAccountLockKey("acc_gone")),
			advisoryObjectKey(chatGptPlanLockKey("user_gone")),
		]);
		expect(db.deletes).toEqual([
			{ table: "state", where: GONE_ACCOUNT },
			{ table: "served", where: GONE_ACCOUNT },
			{ table: "observations", where: GONE_ACCOUNT },
			{ table: "accuracy", where: GONE_ACCOUNT },
			{ table: "state", where: GONE_USER },
			{ table: "served", where: GONE_USER },
			{ table: "observations", where: GONE_USER },
			{ table: "accuracy", where: GONE_USER },
		]);
		expect(result).toEqual({
			candidates: 2,
			sourcesSwept: 2,
			sourcesKept: 0,
			sourcesFailed: [],
			deleted: {
				sourceState: 2,
				servedModels: 6,
				budgetObservations: 4,
				windowAccuracy: 8,
			},
			sourcesNotReached: 0,
			nextCursor: null,
		});
	});

	it("deletes only after the lock and a fresh check, in the same transaction", async () => {
		db.candidates = [GONE_USER, GONE_ACCOUNT];
		await sweepOrphanedChatGptPlanSourceRows({ limit: 50 });

		expect(db.steps).toEqual([
			"find candidates",
			"1:lock",
			"1:check user user_gone",
			"1:delete state",
			"1:delete served",
			"1:delete observations",
			"1:delete accuracy",
			"2:lock",
			"2:check account acc_gone",
			"2:delete state",
			"2:delete served",
			"2:delete observations",
			"2:delete accuracy",
		]);
	});

	it("keeps the rows of a source that exists again under the lock: reconnected, or moved onto", async () => {
		db.candidates = [GONE_USER, GONE_ACCOUNT];
		// Between the candidate read and the lock, the member reconnected and
		// a take-back or share made the account key live again.
		db.existingUsers.add("user_gone");
		db.existingAccounts.add("acc_gone");
		const result = await sweepOrphanedChatGptPlanSourceRows({ limit: 50 });

		expect(db.deletes).toEqual([]);
		expect(db.steps).toEqual([
			"find candidates",
			"1:lock",
			"1:check user user_gone",
			"2:lock",
			"2:check account acc_gone",
		]);
		expect(result).toMatchObject({
			candidates: 2,
			sourcesSwept: 0,
			sourcesKept: 2,
		});
	});

	it("asks for at most `limit` sources whose sign-in is gone", async () => {
		await sweepOrphanedChatGptPlanSourceRows({ limit: 25 });

		expect(db.query?.values).toEqual([null, null, null, 25]);
		const text = db.query?.text ?? "";
		expect(text).toMatch(/LIMIT \?\s*$/);
		for (const table of [
			"chat_gpt_plan_source_state",
			"chat_gpt_plan_served_model",
			"chat_gpt_plan_budget_observation",
			"chat_gpt_plan_window_accuracy",
		]) {
			expect(text).toContain(`FROM "${table}"`);
		}
		expect(text).toMatch(
			/s\."sourceKind" = 'USER'\s+AND NOT EXISTS \(\s*SELECT 1 FROM "chat_gpt_plan_credential" AS c\s+WHERE c\."userId" = s\."sourceId"/,
		);
		expect(text).toMatch(
			/s\."sourceKind" = 'ORG'\s+AND NOT EXISTS \(\s*SELECT 1 FROM "chat_gpt_plan_org_account" AS a\s+WHERE a\."id" = s\."sourceId"/,
		);
	});

	it.each([0, -1, 1.5, Number.NaN])(
		"refuses a limit of %s before reading anything",
		async (limit) => {
			await expect(
				sweepOrphanedChatGptPlanSourceRows({ limit }),
			).rejects.toThrow(RangeError);
			expect(db.steps).toEqual([]);
		},
	);

	it("reports a source whose transaction failed and still sweeps the rest", async () => {
		db.candidates = [GONE_ACCOUNT, GONE_USER];
		db.failing.add("acc_gone");
		const result = await sweepOrphanedChatGptPlanSourceRows({ limit: 50 });

		expect(result.sourcesFailed).toEqual([
			{
				...GONE_ACCOUNT,
				error: "lock wait exceeded the transaction timeout",
			},
		]);
		expect(result.sourcesSwept).toBe(1);
		expect(db.deletes.map((entry) => entry.where)).toEqual([
			GONE_USER,
			GONE_USER,
			GONE_USER,
			GONE_USER,
		]);
	});

	it("pages in one order: the `>` cursor comparison and the ORDER BY use the same expressions", async () => {
		await sweepOrphanedChatGptPlanSourceRows({
			limit: 10,
			after: { sourceKind: "USER", sourceId: "user_b" },
		});

		const text = db.query?.text ?? "";
		const orderBy = text.match(/ORDER BY ([^\n]+?)\s+LIMIT/)?.[1];
		const compared = text.match(
			/OR \(([^()]+)\) > \(\?::text, \?::text\)/,
		)?.[1];
		expect(orderBy).toBe('s."sourceKind"::text, s."sourceId"');
		expect(compared).toBe(orderBy);
		// The first page has no cursor: the whole predicate is skipped.
		expect(text).toMatch(/\(\s*\?::text IS NULL\s+OR \(/);
		// The cursor's kind both gates the predicate and is compared; then
		// its id; then the limit.
		expect(db.query?.values).toEqual(["USER", "USER", "user_b", 10]);
	});

	it("returns the last candidate as the cursor after a full page, and null after a short one", async () => {
		db.candidates = [GONE_ACCOUNT, GONE_USER];
		const full = await sweepOrphanedChatGptPlanSourceRows({ limit: 2 });
		expect(full.nextCursor).toEqual(GONE_USER);

		const end = await sweepOrphanedChatGptPlanSourceRows({
			limit: 2,
			after: full.nextCursor,
		});
		expect(end).toMatchObject({ candidates: 0, nextCursor: null });
	});

	it("moves past more failing sources than one page holds and reaches a healthy orphan after them", async () => {
		// Three sources whose transactions keep failing sort before the one
		// that would sweep cleanly, and a page holds two.
		const failing = ["acc_f1", "acc_f2", "acc_f3"].map((sourceId) => ({
			sourceKind: "ORG" as const,
			sourceId,
		}));
		const healthy = { sourceKind: "USER" as const, sourceId: "user_ok" };
		db.candidates = [...failing, healthy];
		for (const f of failing) {
			db.failing.add(f.sourceId);
		}

		const failed: string[] = [];
		let swept = 0;
		let after: { sourceKind: "USER" | "ORG"; sourceId: string } | null =
			null;
		for (let page = 0; page < 10; page++) {
			const result = await sweepOrphanedChatGptPlanSourceRows({
				limit: 2,
				after,
			});
			failed.push(...result.sourcesFailed.map((f) => f.sourceId));
			swept += result.sourcesSwept;
			if (!result.nextCursor) {
				break;
			}
			after = result.nextCursor;
		}

		expect(failed).toEqual(["acc_f1", "acc_f2", "acc_f3"]);
		expect(swept).toBe(1);
		expect(db.deletes.map((entry) => entry.where)).toEqual([
			healthy,
			healthy,
			healthy,
			healthy,
		]);
		// Two full pages, then the empty one that ends the walk.
		expect(db.queries).toBe(3);
	});

	it("starts no transaction once the deadline has passed, and resumes after the last source handled", async () => {
		const sources = ["acc_1", "acc_2", "acc_3", "acc_4"].map(
			(sourceId) => ({
				sourceKind: "ORG" as const,
				sourceId,
			}),
		);
		db.candidates = sources;
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		// The second source's transaction runs past the deadline.
		db.onTransaction = (n) => {
			if (n === 2) {
				now = 6_000;
			}
		};

		const first = await sweepOrphanedChatGptPlanSourceRows({
			limit: 10,
			deadline: 5_000,
		});

		expect(db.transactions).toBe(2);
		expect(first).toMatchObject({
			candidates: 4,
			sourcesSwept: 2,
			sourcesNotReached: 2,
			nextCursor: sources[1],
		});

		const second = await sweepOrphanedChatGptPlanSourceRows({
			limit: 10,
			after: first.nextCursor,
			deadline: 60_000,
		});
		expect(second).toMatchObject({
			candidates: 2,
			sourcesSwept: 2,
			sourcesNotReached: 0,
			nextCursor: null,
		});
		expect(db.locks).toEqual(
			sources.map((s) =>
				advisoryObjectKey(chatGptPlanOrgAccountLockKey(s.sourceId)),
			),
		);
	});

	it("starts no transaction when the candidate query ran past the deadline, and fails so the call is retried from the same cursor", async () => {
		db.candidates = [GONE_ACCOUNT, GONE_USER];
		vi.spyOn(Date, "now").mockReturnValue(10_000);

		await expect(
			sweepOrphanedChatGptPlanSourceRows({
				limit: 10,
				deadline: 5_000,
			}),
		).rejects.toThrow(/deadline before starting any source/);
		expect(db.transactions).toBe(0);
		expect(db.deletes).toEqual([]);
	});

	it("bounds one source by the lock helper's connection wait plus its transaction timeout", () => {
		expect(chatGptPlanSourceSweepSourceWorstCaseMs()).toBe(
			REFRESH_LOCK_MAX_WAIT_MS + REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
		);
	});
});
