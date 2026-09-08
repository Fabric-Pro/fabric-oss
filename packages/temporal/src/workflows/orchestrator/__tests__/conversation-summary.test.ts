/**
 * Unit tests for the conversation summary handed to the intent-clarity gate.
 *
 * The bug this guards (Fizzy #2406): the gate was called with only the current
 * message, so it re-asked questions the user had already answered earlier in the
 * same chat. These tests pin the two properties that make the summary useful —
 * the NEWEST turns survive trimming, and an answered clarification is carried
 * through verbatim — plus the bounds that keep it from blowing the prompt.
 */

import { describe, expect, it } from "vitest";
import { buildConversationSummary } from "../conversation-summary";

describe("buildConversationSummary", () => {
	it("returns undefined when there is no history", () => {
		expect(buildConversationSummary(undefined)).toBeUndefined();
		expect(buildConversationSummary([])).toBeUndefined();
	});

	it("returns undefined when every turn is blank", () => {
		expect(
			buildConversationSummary([
				{ role: "user", content: "   " },
				{ role: "assistant", content: "" },
			]),
		).toBeUndefined();
	});

	it("labels each turn by role, oldest first", () => {
		expect(
			buildConversationSummary([
				{
					role: "user",
					content: "Let's talk about Fabric Open source",
				},
				{ role: "assistant", content: "Sure — what would you like?" },
				{ role: "user", content: "Generate 10 mockup quotes" },
			]),
		).toBe(
			[
				"User: Let's talk about Fabric Open source",
				"Assistant: Sure — what would you like?",
				"User: Generate 10 mockup quotes",
			].join("\n"),
		);
	});

	it("treats any non-assistant role as a user turn", () => {
		expect(
			buildConversationSummary([{ role: "system", content: "hello" }]),
		).toBe("User: hello");
	});

	it("skips blank turns but keeps the ones around them", () => {
		expect(
			buildConversationSummary([
				{ role: "user", content: "first" },
				{ role: "assistant", content: "  " },
				{ role: "user", content: "second" },
			]),
		).toBe("User: first\nUser: second");
	});

	it("carries an answered clarification through verbatim", () => {
		// This is the line the gate has to see to stop re-asking: the client
		// persists it in exactly this shape.
		const summary = buildConversationSummary([
			{ role: "user", content: "Generate 10 mockup quotes" },
			{
				role: "user",
				content:
					"Clarification — What is the purpose of these quotes?: They relate to Fabric Open source",
			},
		]);
		expect(summary).toContain(
			"Clarification — What is the purpose of these quotes?: They relate to Fabric Open source",
		);
	});

	it("keeps only the most recent turns when the conversation is long", () => {
		const history = Array.from({ length: 30 }, (_, i) => ({
			role: "user",
			content: `turn ${i}`,
		}));

		const summary = buildConversationSummary(history);

		// The newest turn is what answers "did I already ask this".
		expect(summary).toContain("turn 29");
		expect(summary).not.toContain("turn 0");
		expect(summary?.split("\n")).toHaveLength(12);
	});

	it("truncates a single very long message instead of letting it crowd out the rest", () => {
		const summary = buildConversationSummary([
			{ role: "user", content: "x".repeat(5000) },
			{ role: "user", content: "the recent one" },
		]);

		expect(summary).toContain("the recent one");
		expect(summary).toContain("…");
		// Per-message cap keeps the long turn from consuming the whole budget.
		expect(summary?.length).toBeLessThanOrEqual(2000);
	});

	it("stays within the character budget and favours the newest turns", () => {
		const history = Array.from({ length: 12 }, (_, i) => ({
			role: "user",
			content: `${i}-${"y".repeat(390)}`,
		}));

		const summary = buildConversationSummary(history);

		expect(summary?.length).toBeLessThanOrEqual(2000);
		// Oldest turns are the ones dropped. Match on the rendered line start:
		// a bare "0-" is also a substring of "10-".
		expect(summary).toContain("User: 11-");
		expect(summary).not.toContain("User: 0-");
	});

	it("returns the trimmed tail rather than nothing when one turn alone exceeds the budget", () => {
		const summary = buildConversationSummary([
			{ role: "user", content: "z".repeat(9000) },
		]);

		expect(summary).toBeDefined();
		expect(summary?.length).toBeLessThanOrEqual(2000);
	});
});
