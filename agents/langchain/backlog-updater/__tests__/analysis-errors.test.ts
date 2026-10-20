import { describe, expect, it } from "vitest";
import { buildBacklogUpdaterPrompt } from "../prompts";

describe("analysis re-run and error instructions", () => {
	it.each([true, false])(
		"retains general re-run and error guidance with Teams=%s",
		(hasTeamsIntegration) => {
			const prompt = buildBacklogUpdaterPrompt({
				hasTeamsIntegration,
			} as Parameters<typeof buildBacklogUpdaterPrompt>[0]);
			expect(prompt).toContain(
				"If the user asks to analyze again with different context, start a fresh analysis.",
			);
			expect(prompt).toContain(
				"If analyze_backlog returns an error, do not call it again in the same turn; explain the error to the user.",
			);
			const reselectionGuidance =
				"For different Teams meetings, channels, or a different Teams date range, call select_review_sources again before analyze_backlog rather than passing new selection values directly to analyze_backlog.";
			if (hasTeamsIntegration) {
				expect(prompt).toContain(reselectionGuidance);
			} else {
				expect(prompt).not.toContain(reselectionGuidance);
			}
		},
	);
});
