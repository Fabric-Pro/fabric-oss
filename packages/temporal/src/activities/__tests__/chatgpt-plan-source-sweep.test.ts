import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sweep: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	sweepOrphanedChatGptPlanSourceRows: (...a: unknown[]) => mocks.sweep(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		log: vi.fn(),
	},
}));

// Import AFTER the mocks so the activity captures them.
import {
	CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS,
	CHATGPT_PLAN_SOURCE_SWEEP_BATCH_SIZE,
	CHATGPT_PLAN_SOURCE_SWEEP_RUN_BUDGET_MS,
	CHATGPT_PLAN_SOURCE_SWEEP_SOURCE_WORST_CASE_MS,
} from "../../lib/chatgpt-plan-source-sweep-budget";
import { sweepChatGptPlanSourceRowsActivity } from "../chatgpt-plan-source-sweep";

const DELETED = {
	sourceState: 1,
	servedModels: 14,
	budgetObservations: 0,
	windowAccuracy: 2,
};
const CURSOR = { sourceKind: "ORG" as const, sourceId: "acc_example" };

function sweepResult(overrides: Record<string, unknown> = {}) {
	return {
		candidates: 3,
		sourcesSwept: 2,
		sourcesKept: 1,
		sourcesFailed: [],
		deleted: DELETED,
		sourcesNotReached: 0,
		nextCursor: null,
		...overrides,
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sweepChatGptPlanSourceRowsActivity", () => {
	it("sweeps one page after the cursor, under a deadline, and logs its counts", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		mocks.sweep.mockResolvedValueOnce(sweepResult());

		const result = await sweepChatGptPlanSourceRowsActivity({
			after: CURSOR,
		});

		expect(mocks.sweep).toHaveBeenCalledTimes(1);
		expect(mocks.sweep).toHaveBeenCalledWith({
			limit: CHATGPT_PLAN_SOURCE_SWEEP_BATCH_SIZE,
			after: CURSOR,
			deadline: 1_000_000 + CHATGPT_PLAN_SOURCE_SWEEP_RUN_BUDGET_MS,
		});
		expect(result).toEqual(sweepResult());
		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "chatgpt_plan.source_sweep.page",
				after: CURSOR,
				candidates: 3,
				sourcesSwept: 2,
				sourcesKept: 1,
				sourcesFailed: 0,
				sourcesNotReached: 0,
				deleted: DELETED,
				nextCursor: null,
			}),
			expect.any(String),
		);
		expect(mocks.loggerWarn).not.toHaveBeenCalled();
		expect(mocks.loggerError).not.toHaveBeenCalled();
	});

	it("returns, rather than throws, the sources that failed, so a retry does not redo the page", async () => {
		const failure = {
			sourceKind: "ORG",
			sourceId: "acc_example",
			error: "lock wait exceeded the transaction timeout",
		};
		mocks.sweep.mockResolvedValueOnce(
			sweepResult({
				sourcesSwept: 1,
				sourcesFailed: [failure],
				nextCursor: CURSOR,
			}),
		);

		const result = await sweepChatGptPlanSourceRowsActivity({
			after: null,
		});

		expect(result.sourcesFailed).toEqual([failure]);
		expect(result.nextCursor).toEqual(CURSOR);
		expect(mocks.loggerError).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "chatgpt_plan.source_sweep.failed_sources",
				failures: [failure],
			}),
			expect.any(String),
		);
	});

	it("warns when the time budget left candidates for the next page", async () => {
		mocks.sweep.mockResolvedValueOnce(
			sweepResult({ sourcesNotReached: 4, nextCursor: CURSOR }),
		);

		await sweepChatGptPlanSourceRowsActivity({ after: null });

		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "chatgpt_plan.source_sweep.budget_reached",
				sourcesNotReached: 4,
			}),
			expect.any(String),
		);
	});

	it("lets a failed candidate read propagate so Temporal retries", async () => {
		mocks.sweep.mockRejectedValueOnce(new Error("connection refused"));
		await expect(
			sweepChatGptPlanSourceRowsActivity({ after: null }),
		).rejects.toThrow("connection refused");
	});

	it("fits an attempt's worst case inside its start-to-close timeout, with room for the candidate query", () => {
		// No transaction starts after the budget; the one started just
		// before it can run a full source's worst case.
		const worstAfterQuery =
			CHATGPT_PLAN_SOURCE_SWEEP_RUN_BUDGET_MS +
			CHATGPT_PLAN_SOURCE_SWEEP_SOURCE_WORST_CASE_MS;
		const room =
			CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS.startToCloseTimeout -
			worstAfterQuery;
		expect(room).toBeGreaterThanOrEqual(60_000);
	});
});
