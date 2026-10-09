/**
 * The usage estimate a ChatGPT plan card shows (Fizzy #2770 F1): the plan's
 * anchored five-hour window as Fabric's own calls show it, against the plan's
 * budget. One shape for the organization's shared accounts and a member's
 * own plan.
 */

import {
	CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
	CHATGPT_PLAN_WINDOW_MS,
	type ChatGptPlanWindow,
	chatGptPlanWindowPercent,
} from "@repo/database";
import { z } from "zod";

export const chatGptPlanUsageEstimateSchema = z.object({
	windowHours: z.number(),
	/** Null when no window is open: the last one has reset. */
	windowStart: z.date().nullable(),
	resetsAt: z.date().nullable(),
	lastRequestAt: z.date().nullable(),
	requests: z.number(),
	/** Uncached input tokens, the unit of the budget. */
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	estimatedPercent: z.number(),
	/** Pro: no five-hour window, only a weekly limit (Fizzy #2770 G7). */
	weeklyLimitOnly: z.boolean(),
	topConsumers: z.array(
		z.object({
			kind: z.enum(["job", "feature", "other"]),
			key: z.string().nullable(),
			requests: z.number(),
			inputTokens: z.number(),
			percent: z.number(),
		}),
	),
});

export type ChatGptPlanUsageEstimate = z.infer<
	typeof chatGptPlanUsageEstimateSchema
>;

export function toChatGptPlanUsageEstimate(
	window: ChatGptPlanWindow,
	budget: number,
): ChatGptPlanUsageEstimate {
	return {
		windowHours: CHATGPT_PLAN_WINDOW_MS / 3_600_000,
		windowStart: window.windowStart,
		resetsAt: window.resetsAt,
		lastRequestAt: window.lastRequestAt,
		requests: window.requests,
		inputTokens: window.inputTokens,
		cachedInputTokens: window.cachedInputTokens,
		outputTokens: window.outputTokens,
		estimatedPercent: chatGptPlanWindowPercent(window, budget),
		weeklyLimitOnly: budget >= CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
		topConsumers: window.topConsumers,
	};
}
