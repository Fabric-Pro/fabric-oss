/**
 * ChatGPT plan source-row sweep workflow (Fizzy #3038).
 *
 * Scheduled daily (unconditional; see packages/temporal/src/schedules.ts).
 * Walks every candidate source in pages: each activity call handles one page
 * after the cursor the previous call returned, until a call reports the end
 * (`nextCursor: null`). A source whose transaction failed does not stop the
 * walk or hold its place at the head of a page; the walk moves past it, and
 * only once it has finished does the run fail, so the failure shows and the
 * next day's run tries that source again.
 *
 * Deterministic: no clock, randomness, environment or IO here; the loop
 * depends only on activity results, and its cap is a constant.
 *
 * Bounds (arithmetic in `chatgpt-plan-source-sweep-budget.ts`): each call's
 * attempts fit their timeout, and the run at its cap fits under the
 * schedule's execution timeout.
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/chatgpt-plan-source-sweep";
import type { SweepChatGptPlanSourceRowsResult } from "../activities/chatgpt-plan-source-sweep";
import {
	CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS,
	CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS,
} from "../lib/chatgpt-plan-source-sweep-budget";

const { sweepChatGptPlanSourceRowsActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout:
		CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS.startToCloseTimeout,
	retry: { ...CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS.retry },
});

type PageResult = SweepChatGptPlanSourceRowsResult;

/** Failures kept in the result and the failure message; the count is whole. */
const FAILURE_SAMPLE_SIZE = 20;

export interface ChatGptPlanSourceSweepWorkflowResult {
	/** Activity calls made, one page each. */
	pages: number;
	candidates: number;
	sourcesSwept: number;
	sourcesKept: number;
	sourcesFailedCount: number;
	/** The first failures, up to FAILURE_SAMPLE_SIZE. */
	sourcesFailed: PageResult["sourcesFailed"];
	deleted: PageResult["deleted"];
	/** True when the walk reached the end rather than the page cap. */
	complete: boolean;
}

export async function chatGptPlanSourceSweepWorkflow(): Promise<ChatGptPlanSourceSweepWorkflowResult> {
	const result: ChatGptPlanSourceSweepWorkflowResult = {
		pages: 0,
		candidates: 0,
		sourcesSwept: 0,
		sourcesKept: 0,
		sourcesFailedCount: 0,
		sourcesFailed: [],
		deleted: {
			sourceState: 0,
			servedModels: 0,
			budgetObservations: 0,
			windowAccuracy: 0,
		},
		complete: false,
	};
	let after: PageResult["nextCursor"] = null;
	while (result.pages < CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS) {
		const page: PageResult = await sweepChatGptPlanSourceRowsActivity({
			after,
		});
		result.pages += 1;
		result.candidates += page.candidates - page.sourcesNotReached;
		result.sourcesSwept += page.sourcesSwept;
		result.sourcesKept += page.sourcesKept;
		result.sourcesFailedCount += page.sourcesFailed.length;
		for (const failure of page.sourcesFailed) {
			if (result.sourcesFailed.length < FAILURE_SAMPLE_SIZE) {
				result.sourcesFailed.push(failure);
			}
		}
		result.deleted.sourceState += page.deleted.sourceState;
		result.deleted.servedModels += page.deleted.servedModels;
		result.deleted.budgetObservations += page.deleted.budgetObservations;
		result.deleted.windowAccuracy += page.deleted.windowAccuracy;
		if (page.nextCursor === null) {
			result.complete = true;
			break;
		}
		after = page.nextCursor;
	}

	log.info("ChatGPT plan source sweep finished", {
		pages: result.pages,
		candidates: result.candidates,
		sourcesSwept: result.sourcesSwept,
		sourcesKept: result.sourcesKept,
		sourcesFailed: result.sourcesFailedCount,
		deleted: result.deleted,
		complete: result.complete,
	});

	const problems: string[] = [];
	if (result.sourcesFailedCount > 0) {
		problems.push(
			`${result.sourcesFailedCount} of ${result.candidates} sources could not be swept`,
		);
	}
	if (!result.complete) {
		problems.push(
			`the walk stopped at its cap of ${CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS} pages before the end`,
		);
	}
	if (problems.length > 0) {
		// Non-retryable: a workflow retry would only repeat the walk the next
		// scheduled run makes anyway.
		throw ApplicationFailure.nonRetryable(
			`ChatGPT plan source sweep: ${problems.join("; ")}`,
			"CHATGPT_PLAN_SOURCE_SWEEP_INCOMPLETE",
			result,
		);
	}
	return result;
}
