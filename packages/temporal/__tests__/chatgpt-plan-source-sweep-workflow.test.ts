/**
 * Behavioural test for `chatGptPlanSourceSweepWorkflow` (Fizzy #3038) on a
 * time-skipping test server, bundling the REAL workflows barrel, with the
 * activity replaced by a page emulator over a fixed candidate list.
 *
 * The property: within one run the walk visits every candidate that existed
 * at its start, moving past sources that fail, and only then fails the run.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run __tests__/chatgpt-plan-source-sweep-workflow.test.ts
 */
import { resolve } from "node:path";
import { WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS } from "../src/lib/chatgpt-plan-source-sweep-budget";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "chatGptPlanSourceSweepWorkflow";

type Source = { sourceKind: "USER" | "ORG"; sourceId: string };

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

const NO_DELETES = {
	sourceState: 0,
	servedModels: 0,
	budgetObservations: 0,
	windowAccuracy: 0,
};

/**
 * Emulates `sweepOrphanedChatGptPlanSourceRows` with a page of `pageSize`
 * over `candidates` (already in the query's order): the page starts after
 * the cursor, and the cursor returned is the last source handled, or null
 * after a short page.
 */
function pageEmulator(
	candidates: Source[],
	failing: Set<string>,
	pageSize: number,
) {
	const handled: string[] = [];
	const activity = vi.fn(async ({ after }: { after: Source | null }) => {
		const start =
			after === null
				? 0
				: candidates.findIndex((c) => c.sourceId === after.sourceId) +
					1;
		const page = candidates.slice(start, start + pageSize);
		const failed = page
			.filter((c) => failing.has(c.sourceId))
			.map((c) => ({
				...c,
				error: "lock wait exceeded the transaction timeout",
			}));
		const swept = page.filter((c) => !failing.has(c.sourceId));
		handled.push(...page.map((c) => c.sourceId));
		return {
			candidates: page.length,
			sourcesSwept: swept.length,
			sourcesKept: 0,
			sourcesFailed: failed,
			deleted: { ...NO_DELETES, sourceState: swept.length },
			sourcesNotReached: 0,
			nextCursor: page.length < pageSize ? null : (page.at(-1) ?? null),
		};
	});
	return { activity, handled };
}

async function runSweep(
	activity: (input: { after: Source | null }) => Promise<unknown>,
	label: string,
) {
	const taskQueue = `chatgpt-plan-source-sweep-${label}-${Date.now()}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: { sweepChatGptPlanSourceRowsActivity: activity },
	});
	return worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			taskQueue,
			workflowId: `chatgpt-plan-source-sweep-test-${label}-${Date.now()}`,
			args: [],
		}),
	);
}

async function failureOf(run: Promise<unknown>): Promise<ApplicationFailure> {
	const error = await run.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(WorkflowFailedError);
	const cause = (error as WorkflowFailedError).cause;
	expect(cause).toBeInstanceOf(ApplicationFailure);
	return cause as ApplicationFailure;
}

describe("chatGptPlanSourceSweepWorkflow", () => {
	it("walks every page to the end and returns the totals", async () => {
		const candidates: Source[] = ["acc_1", "acc_2", "acc_3"].map(
			(sourceId) => ({ sourceKind: "ORG", sourceId }),
		);
		const { activity, handled } = pageEmulator(candidates, new Set(), 2);

		const result = await runSweep(activity, "clean");

		expect(handled).toEqual(["acc_1", "acc_2", "acc_3"]);
		expect(activity.mock.calls.map(([input]) => input.after)).toEqual([
			null,
			candidates[1],
		]);
		expect(result).toMatchObject({
			pages: 2,
			candidates: 3,
			sourcesSwept: 3,
			sourcesFailedCount: 0,
			complete: true,
		});
	}, 60_000);

	it("moves past more failing sources than a page holds, sweeps the healthy orphan after them, then fails the run", async () => {
		const failing = ["acc_f1", "acc_f2", "acc_f3"];
		const candidates: Source[] = [
			...failing.map((sourceId) => ({
				sourceKind: "ORG" as const,
				sourceId,
			})),
			{ sourceKind: "USER", sourceId: "user_ok" },
		];
		const { activity, handled } = pageEmulator(
			candidates,
			new Set(failing),
			2,
		);

		const failure = await failureOf(runSweep(activity, "failing"));

		// Every candidate visited once, the healthy one included, before the
		// run failed.
		expect(handled).toEqual(["acc_f1", "acc_f2", "acc_f3", "user_ok"]);
		expect(activity).toHaveBeenCalledTimes(3);
		expect(failure.type).toBe("CHATGPT_PLAN_SOURCE_SWEEP_INCOMPLETE");
		expect(failure.nonRetryable).toBe(true);
		expect(failure.message).toContain("3 of 4 sources could not be swept");
		expect(failure.details?.[0]).toMatchObject({
			sourcesSwept: 1,
			sourcesFailedCount: 3,
			complete: true,
		});
	}, 60_000);

	it("stops at its page cap and fails rather than reporting an unfinished walk as clean", async () => {
		let n = 0;
		const activity = vi.fn(async () => {
			n += 1;
			return {
				candidates: 1,
				sourcesSwept: 1,
				sourcesKept: 0,
				sourcesFailed: [],
				deleted: NO_DELETES,
				sourcesNotReached: 0,
				nextCursor: { sourceKind: "ORG", sourceId: `acc_${n}` },
			};
		});

		const failure = await failureOf(runSweep(activity, "cap"));

		expect(activity).toHaveBeenCalledTimes(
			CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS,
		);
		expect(failure.message).toContain("cap");
		expect(failure.details?.[0]).toMatchObject({ complete: false });
	}, 120_000);
});
