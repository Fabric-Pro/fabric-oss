import { describe, expect, it } from "vitest";
import { formatLastEditSource } from "../last-edit-source-copy";

describe("formatLastEditSource", () => {
	it("maps each static source to its label", () => {
		expect(formatLastEditSource("MANUAL", null)).toBe("Manual edit");
		expect(formatLastEditSource("AI_BACKLOG_UPDATE", null)).toBe(
			"AI backlog update",
		);
		expect(formatLastEditSource("AI_MATURATION", null)).toBe(
			"AI maturation",
		);
		expect(formatLastEditSource("CONFLICT_RESOLUTION", null)).toBe(
			"Conflict resolution",
		);
	});

	it("interpolates the tool label for PM_PULL", () => {
		expect(formatLastEditSource("PM_PULL", "Jira")).toBe(
			"Pulled from Jira",
		);
	});

	it("falls back to a generic tool when PM_PULL has no tool label", () => {
		expect(formatLastEditSource("PM_PULL", null)).toBe(
			"Pulled from PM tool",
		);
	});

	it("returns the explicit fallback when source is null/undefined", () => {
		expect(formatLastEditSource(null, "Jira")).toBe("Source unavailable");
		expect(formatLastEditSource(undefined, null)).toBe(
			"Source unavailable",
		);
	});
});
