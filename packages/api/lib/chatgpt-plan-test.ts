/**
 * The Test button on a ChatGPT plan's settings card (Fizzy #2770): one shape
 * and one rate limit for a member's own plan and an organization's shared
 * accounts. Like the API-provider connection test, each person may run a
 * handful a minute: every test is a real request billed to the plan.
 */

import { ORPCError } from "@orpc/server";
import {
	type ChatGptPlanCheckParams,
	type ChatGptPlanCheckResult,
	testChatGptPlanSource,
} from "@repo/ai/lib/chatgpt-plan/plan-check";
import { z } from "zod";
import { checkRateLimit } from "./rate-limit";

const PLAN_TEST_RATE_LIMIT = { limit: 5, windowMs: 60_000 };

export const chatGptPlanTestResultSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("ok"),
		/** The plan model that answered. */
		model: z.string(),
		modelName: z.string(),
		latencyMs: z.number(),
	}),
	z.object({ outcome: z.literal("needs_reconnect"), message: z.string() }),
	z.object({
		outcome: z.literal("spent"),
		/** Null when the plan did not say when its window resets. */
		resetAt: z.date().nullable(),
	}),
	z.object({ outcome: z.literal("error"), message: z.string() }),
]);

/** Rate-limits, then runs one test of the plan; see `testChatGptPlanSource`. */
export async function runChatGptPlanTest(
	params: ChatGptPlanCheckParams,
): Promise<ChatGptPlanCheckResult> {
	const rate = await checkRateLimit(
		`chatgpt-plan-test:${params.userId}`,
		PLAN_TEST_RATE_LIMIT.limit,
		PLAN_TEST_RATE_LIMIT.windowMs,
	);
	if (!rate.allowed) {
		if (rate.statusCode === 503) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Rate limit service temporarily unavailable",
			});
		}
		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: `Too many plan tests. Please try again in ${rate.resetInSeconds} seconds.`,
		});
	}
	return testChatGptPlanSource(params);
}
