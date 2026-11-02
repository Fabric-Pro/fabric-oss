// The SAME specifier the workflow's errors come from, so the chain is built
// from the classes Temporal hands the workflow.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";
import { extractMeaningfulErrorMessage } from "../meaningful-error-message";

/**
 * The text a Deep Research run reports when one of its activities is refused
 * by an AI usage limit. The agent runtime maps this exact message to its
 * usage-limit error (`apps/web/__tests__/agents/runtime/_helpers/
 * research-fixtures.ts` holds the same string), so the workflow must report
 * the activity's own message, not Temporal's "Activity task failed".
 */
const USAGE_LIMIT_MESSAGE =
	"AI usage limit exceeded: limit-example (TOKENS, DAILY) — used 10 of 5";

describe("deep researcher failure message", () => {
	// `(message, activityType, activityId, retryState, identity, cause?)`,
	// with `cause` last, as in publishing-chat-failure-detail.test.ts.
	it("an activity's usage-limit refusal reaches the research output as its own message", () => {
		const failure = new ActivityFailure(
			"Activity task failed",
			"planResearch",
			undefined,
			"NON_RETRYABLE_FAILURE",
			undefined,
			ApplicationFailure.create({
				message: USAGE_LIMIT_MESSAGE,
				type: "AiUsageLimitExceededError",
				nonRetryable: true,
			}),
		);

		expect(extractMeaningfulErrorMessage(failure, "Unknown error")).toBe(
			USAGE_LIMIT_MESSAGE,
		);
	});

	it("the workflow's top-level catch reports the deepest meaningful cause", () => {
		const source = readFileSync(
			join(__dirname, "..", "deep-researcher.ts"),
			"utf-8",
		);
		const workflow = source.slice(
			source.indexOf("export async function deepResearcherWorkflow"),
			source.indexOf("async function executeSubAgent"),
		);
		const catchAt = workflow.lastIndexOf("} catch (error) {");

		expect(catchAt).toBeGreaterThan(-1);
		expect(workflow.slice(catchAt, catchAt + 600)).toMatch(
			/const errorMessage = extractMeaningfulErrorMessage\(\s*error,\s*"Unknown error",?\s*\);/,
		);
		expect(source).toMatch(
			/import \{ extractMeaningfulErrorMessage \} from "\.\/meaningful-error-message";/,
		);
	});
});
