/**
 * Task 6: concurrency-safety for
 * `updateOnboardingTourState` (`packages/database/prisma/queries/onboarding-tour.ts`).
 *
 * Before this task, `updateOnboardingTourState` did an unlocked
 * read-modify-write of the `User.onboardingTourState` JSON column: read the
 * whole column, apply the reducer in JS, overwrite the whole column. Two
 * concurrent updates (e.g. one tab calling `markPageSeen`, another calling
 * `optOutFunctionTagsPrompt` for the FR4 opt-out prompt) raced
 * last-writer-wins — the second write could silently clobber the first,
 * which would let the FR4 prompt re-fire or lose an auto-launch flag.
 *
 * This suite can't exercise real Postgres `SELECT … FOR UPDATE` blocking in
 * this offline worktree, so it does two things instead:
 *
 *   1. Shape assertions — `updateOnboardingTourState` must run its read +
 *      write inside a single `db.$transaction` callback, and must take a
 *      parameterized `FOR UPDATE` lock on the `"user"` row BEFORE reading
 *      the current state (never outside the lock, never via the base `db`).
 *   2. A mutex-simulated concurrency test — mirrors the "revocation race"
 *      pattern in `prisma/queries/projects/newsletter.embed-subscriber.test.ts`:
 *      the mocked `$transaction` holds a single-slot mutex for the FULL
 *      duration of the callback (acquired at the `$queryRaw` FOR UPDATE
 *      call, released only once the callback settles — modeling "the row
 *      lock is held until COMMIT"). Two concurrent `updateOnboardingTourState`
 *      calls against the same fake row are run via `Promise.all`; if the
 *      implementation read the row before acquiring the lock (i.e. outside
 *      `tx`, or outside `db.$transaction` altogether), the second call's
 *      read would see stale state and clobber the first call's write — this
 *      test would catch that.
 *
 * Run: pnpm --filter @repo/database test packages/database/prisma/queries/__tests__/onboarding-tour.concurrency.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	callOrder,
	dbUserFindUnique,
	dbUserUpdate,
	transactionMock,
	txFindUnique,
	txUpdate,
	txQueryRaw,
} = vi.hoisted(() => {
	const callOrder: string[] = [];
	return {
		callOrder,
		// If updateOnboardingTourState still reads/writes via the base `db`
		// (not inside db.$transaction), these throw so the test fails loudly
		// instead of silently passing on the old, unlocked code path.
		dbUserFindUnique: vi.fn(async () => {
			throw new Error(
				"db.user.findUnique must not be called directly — updateOnboardingTourState must read inside db.$transaction",
			);
		}),
		dbUserUpdate: vi.fn(async () => {
			throw new Error(
				"db.user.update must not be called directly — updateOnboardingTourState must write inside db.$transaction",
			);
		}),
		transactionMock: vi.fn(),
		txFindUnique: vi.fn(),
		txUpdate: vi.fn(),
		txQueryRaw: vi.fn(),
	};
});

vi.mock("../../client", () => ({
	db: {
		user: { findUnique: dbUserFindUnique, update: dbUserUpdate },
		$transaction: (fn: (tx: unknown) => Promise<unknown>) =>
			transactionMock(fn),
	},
}));

import {
	DEFAULT_ONBOARDING_TOUR_STATE,
	normalizeOnboardingTourState,
	updateOnboardingTourState,
} from "../onboarding-tour";

const USER_ID = "user-onboarding-lock-1";

describe("updateOnboardingTourState — shape: transaction + FOR UPDATE lock", () => {
	beforeEach(() => {
		callOrder.length = 0;
		dbUserFindUnique.mockClear();
		dbUserUpdate.mockClear();
		txFindUnique.mockReset();
		txUpdate.mockReset();
		txQueryRaw.mockReset();
		transactionMock.mockReset();

		transactionMock.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					user: {
						findUnique: (...args: unknown[]) => {
							callOrder.push("findUnique");
							return txFindUnique(...args);
						},
						update: (...args: unknown[]) => {
							callOrder.push("update");
							return txUpdate(...args);
						},
					},
					$queryRaw: (...args: unknown[]) => {
						callOrder.push("queryRaw");
						return txQueryRaw(...args);
					},
				}),
		);
		txFindUnique.mockResolvedValue({
			onboardingTourState: { ...DEFAULT_ONBOARDING_TOUR_STATE },
		});
		txUpdate.mockResolvedValue(undefined);
		txQueryRaw.mockResolvedValue([{ id: USER_ID }]);
	});

	it("runs the read+write inside a single db.$transaction call, never via the base db", async () => {
		await updateOnboardingTourState(USER_ID, {
			type: "markPageToursOptedOut",
		});
		expect(transactionMock).toHaveBeenCalledTimes(1);
		expect(dbUserFindUnique).not.toHaveBeenCalled();
		expect(dbUserUpdate).not.toHaveBeenCalled();
	});

	it("takes the FOR UPDATE lock BEFORE reading current state, and writes only after the read", async () => {
		await updateOnboardingTourState(USER_ID, {
			type: "markPageToursOptedOut",
		});
		expect(callOrder[0]).toBe("queryRaw");
		expect(callOrder.indexOf("findUnique")).toBeGreaterThan(
			callOrder.indexOf("queryRaw"),
		);
		expect(callOrder.indexOf("update")).toBeGreaterThan(
			callOrder.indexOf("findUnique"),
		);
	});

	it('issues a parameterized FOR UPDATE lock on the "user" table (never string-interpolates the id)', async () => {
		await updateOnboardingTourState(USER_ID, {
			type: "markPageToursOptedOut",
		});
		expect(txQueryRaw).toHaveBeenCalledTimes(1);
		const [strings, ...values] = txQueryRaw.mock.calls[0] as [
			readonly string[],
			...unknown[],
		];
		const sql = strings.join("?");
		expect(sql).toMatch(/FOR UPDATE/);
		expect(sql).toMatch(/"user"/);
		// The id must arrive as a bound parameter, not be baked into the SQL
		// literal segments (that's what "never string-interpolate" means).
		expect(sql).not.toContain(USER_ID);
		expect(values).toContain(USER_ID);
	});

	it("returns the state produced by applying the action, matching exactly what was persisted via tx.user.update", async () => {
		const result = await updateOnboardingTourState(USER_ID, {
			type: "optOutFunctionTagsPrompt",
		});
		expect(result.functionTagsPromptOptOut).toBe(true);
		const written = (
			txUpdate.mock.calls[0][0] as {
				data: { onboardingTourState: unknown };
			}
		).data.onboardingTourState;
		expect(written).toEqual(result);
	});
});

describe("updateOnboardingTourState — concurrency (mutex-simulated row lock)", () => {
	// Faithful to real `SELECT … FOR UPDATE`: the lock is acquired at the
	// query and held for the REST of the transaction, released only when the
	// $transaction callback settles (i.e. on commit).
	let locked = false;
	const waiters: Array<() => void> = [];
	const acquire = () =>
		new Promise<void>((resolve) => {
			if (!locked) {
				locked = true;
				resolve();
			} else {
				waiters.push(resolve);
			}
		});
	const release = () => {
		const next = waiters.shift();
		if (next) {
			next();
		} else {
			locked = false;
		}
	};

	beforeEach(() => {
		locked = false;
		waiters.length = 0;
		dbUserFindUnique.mockClear();
		dbUserUpdate.mockClear();
		transactionMock.mockReset();
	});

	it("two concurrent updates (markPageSeen + optOutFunctionTagsPrompt) both land — neither clobbers the other", async () => {
		const row: { onboardingTourState: unknown } = {
			onboardingTourState: { ...DEFAULT_ONBOARDING_TOUR_STATE },
		};

		transactionMock.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) => {
				const tx = {
					user: {
						findUnique: async () => ({
							onboardingTourState: row.onboardingTourState,
						}),
						update: async (args: {
							data: { onboardingTourState: unknown };
						}) => {
							row.onboardingTourState =
								args.data.onboardingTourState;
						},
					},
					$queryRaw: async () => {
						await acquire();
						return [{ id: USER_ID }];
					},
				};
				try {
					return await fn(tx);
				} finally {
					release();
				}
			},
		);

		const [resultA, resultB] = await Promise.all([
			updateOnboardingTourState(USER_ID, {
				type: "markPageSeen",
				pageId: "overview",
			}),
			updateOnboardingTourState(USER_ID, {
				type: "optOutFunctionTagsPrompt",
			}),
		]);

		const final = normalizeOnboardingTourState(
			row.onboardingTourState as never,
		);
		expect(final.seenPages.overview).toBe(true);
		expect(final.functionTagsPromptOptOut).toBe(true);
		// Each call's own return value reflects only what it could see at its
		// own commit point, but the two calls together must cover both fields
		// — proof neither write was silently dropped.
		expect(
			[resultA, resultB].some((r) => r.seenPages.overview === true),
		).toBe(true);
		expect(
			[resultA, resultB].some((r) => r.functionTagsPromptOptOut === true),
		).toBe(true);
	});
});
