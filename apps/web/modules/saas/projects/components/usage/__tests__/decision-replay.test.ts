import { expect, it } from "vitest";
import { sourceLabel } from "../decision-replay";

it("uses inbox recommendation labels and does not invent a transcript source", () => {
	expect(sourceLabel("ROADMAP_RECOMMENDATION")).toBe(
		"Recommended from project context",
	);
	expect(sourceLabel("MEETING_TRANSCRIPT")).toBe("meeting transcript");
});
