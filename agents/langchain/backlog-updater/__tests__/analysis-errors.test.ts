import { describe, expect, it } from "vitest";
import { buildBacklogUpdaterPrompt } from "../prompts";

describe("app-owned sequencing prompt", () => {
	it.each([true, false])(
		"describes entry and application progression with Teams=%s",
		(hasTeamsIntegration) => {
			const prompt = buildBacklogUpdaterPrompt({
				hasTeamsIntegration,
				hasNotionIntegration: true,
			} as never);
			expect(prompt).toContain(
				"Pick only the entry step for a genuine new user request",
			);
			expect(prompt).toContain(
				"Analysis results render review in the existing card without another tool call",
			);
			expect(prompt).toContain("For Slack-only, explore intake");
			expect(prompt).toContain("includeNotion: true");
			expect(prompt.includes("For Teams meetings, transcripts")).toBe(
				hasTeamsIntegration,
			);
			for (const old of [
				"call analyze_backlog with it next",
				"call select_review_sources again before analyze_backlog",
				"call analyze_backlog IMMEDIATELY",
				"Call this immediately after analyze_backlog",
				"then immediately show the review card",
			]) {
				expect(prompt).not.toContain(old);
			}
		},
	);
});

it("guides projects without integrations to connect a source, with an explore exception", () => {
	const prompt = buildBacklogUpdaterPrompt({} as never);
	expect(prompt).toContain(
		"Suggest connecting Teams, Slack, or Notion in Settings",
	);
	expect(prompt).toContain(
		"Do not start a source-free analysis unless the project uses explore intake",
	);
	expect(prompt).toContain("choose Start over");
	expect(prompt).toContain(
		"While changes are being applied, wait for the result in the active card.",
	);
});

it("keeps result descriptions in the card because the model receives only acknowledgement", () => {
	const prompt = buildBacklogUpdaterPrompt({} as never);
	expect(prompt).not.toContain("Summarize findings");
	expect(prompt).not.toContain("Report results concisely");
	expect(prompt).toContain("The card shows analysis and apply results");
});
