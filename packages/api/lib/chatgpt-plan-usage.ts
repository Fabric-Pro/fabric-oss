/**
 * The usage estimate a ChatGPT plan card shows (Fizzy #2770 F1): the plan's
 * anchored five-hour window as Fabric's own calls show it, against the plan's
 * budget. One shape for the organization's shared accounts and a member's
 * own plan.
 */

import {
	CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
	CHATGPT_PLAN_WINDOW_MS,
	type ChatGptPlanReportedUsage,
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
	/** Uncached input tokens; the budget weighs them by model. */
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	estimatedPercent: z.number(),
	/**
	 * The percent to show: OpenAI's own report while it is fresh, else the
	 * estimate. `percentSource` says which.
	 */
	percent: z.number(),
	percentSource: z.enum(["reported", "estimated"]),
	/** What OpenAI last reported for the plan, fresh or not; null with none. */
	reported: z
		.object({
			windowUsedPercent: z.number().nullable(),
			windowResetsAt: z.date().nullable(),
			weeklyUsedPercent: z.number().nullable(),
			weeklyResetsAt: z.date().nullable(),
			observedAt: z.date(),
			fresh: z.boolean(),
		})
		.nullable(),
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

/** OpenAI's report, sorted for display; null with none. */
function toChatGptPlanReportedSummary(
	reported: ChatGptPlanReportedUsage | null,
): ChatGptPlanUsageEstimate["reported"] {
	return reported
		? {
				windowUsedPercent: reported.window?.usedPercent ?? null,
				windowResetsAt: reported.window?.resetsAt ?? null,
				weeklyUsedPercent: reported.weekly?.usedPercent ?? null,
				weeklyResetsAt: reported.weekly?.resetsAt ?? null,
				observedAt: reported.observedAt,
				fresh: reported.windowFresh,
			}
		: null;
}

export function toChatGptPlanUsageEstimate(
	window: ChatGptPlanWindow,
	budget: number,
	reported: ChatGptPlanReportedUsage | null = null,
): ChatGptPlanUsageEstimate {
	const estimatedPercent = chatGptPlanWindowPercent(window, budget);
	const fresh =
		reported?.windowFresh && reported.window ? reported.window : null;
	return {
		windowHours: CHATGPT_PLAN_WINDOW_MS / 3_600_000,
		windowStart: window.windowStart,
		resetsAt: fresh?.resetsAt ?? window.resetsAt,
		lastRequestAt: window.lastRequestAt,
		requests: window.requests,
		inputTokens: window.inputTokens,
		cachedInputTokens: window.cachedInputTokens,
		outputTokens: window.outputTokens,
		estimatedPercent,
		percent: fresh
			? Math.min(100, Math.max(0, Math.round(fresh.usedPercent)))
			: estimatedPercent,
		percentSource: fresh ? "reported" : "estimated",
		reported: toChatGptPlanReportedSummary(reported),
		weeklyLimitOnly: budget >= CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
		topConsumers: window.topConsumers,
	};
}
