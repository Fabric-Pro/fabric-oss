/**
 * Regression tests for `applyTokenBudget` (Fizzy #1234).
 *
 * The bug this guards: the function has two exit paths — "everything fits" and
 * "progressively truncate" — and both used to hand-list the context keys they
 * returned. Adding `applicationLogs` to the priority list but to only ONE of
 * those literals meant the log section was silently dropped whenever the
 * budget was exceeded, which is precisely when a real project's analysis runs.
 * Both paths now build their result from the priority list itself.
 *
 * These tests assert the property that made the bug invisible: a source that
 * ranks high in priority must survive BOTH paths.
 */
import { describe, expect, it } from "vitest";
import { applyTokenBudget } from "../analyze-context";

/** Roughly 4 chars per token, so 1000 chars is ~250 tokens. */
const small = "s".repeat(1_000);
/** Large enough to blow the 80k-token budget on its own. */
const huge = "h".repeat(400_000);

describe("applyTokenBudget — everything fits", () => {
	it("returns every supplied context source", () => {
		const out = applyTokenBudget({
			architectureDecisions: "decisions",
			applicationLogs: "logs",
			teamsMessages: "teams",
			slackMessages: "slack",
			meetingTranscripts: "meetings",
			notionContent: "notion",
			ragContext: "rag",
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out).toEqual({
			architectureDecisions: "decisions",
			applicationLogs: "logs",
			teamsMessages: "teams",
			slackMessages: "slack",
			meetingTranscripts: "meetings",
			notionContent: "notion",
			ragContext: "rag",
		});
	});

	it("omits sources that were not supplied", () => {
		const out = applyTokenBudget({
			applicationLogs: "logs",
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out).toEqual({ applicationLogs: "logs" });
	});
});

describe("applyTokenBudget — truncation path", () => {
	it("keeps the high-priority sources, including application logs", () => {
		// `huge` in a low-priority slot forces progressive truncation.
		const out = applyTokenBudget({
			architectureDecisions: "decisions",
			applicationLogs: "logs",
			ragContext: huge,
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		// This is the assertion that would have caught the original bug: the
		// log section ranks second and must survive the truncation path.
		expect(out.applicationLogs).toBe("logs");
		expect(out.architectureDecisions).toBe("decisions");
	});

	it("truncates the lowest-priority source rather than the highest", () => {
		const out = applyTokenBudget({
			applicationLogs: "logs",
			ragContext: huge,
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		expect(out.applicationLogs).toBe("logs");
		expect(out.ragContext?.length ?? 0).toBeLessThan(huge.length);
	});

	it("returns nothing when the fixed content alone exceeds the budget", () => {
		expect(
			applyTokenBudget({
				applicationLogs: "logs",
				backlog: huge,
				systemPrompt: huge,
				userPrompt: huge,
			}),
		).toEqual({});
	});
});
