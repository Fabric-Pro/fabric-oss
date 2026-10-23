import { describe, expect, it } from "vitest";
import { heldChangeAction } from "../parlume-held-change";

describe("heldChangeAction", () => {
	it("names a story a feature, as the product does", () => {
		expect(
			heldChangeAction("fabric_create_story", { title: "Export to CSV" }),
		).toBe("create feature “Export to CSV”");
		expect(heldChangeAction("fabric_list_stories", {})).toBe(
			"list features",
		);
	});

	it("keeps other tool words and shortens a long title", () => {
		expect(heldChangeAction("update-bug", { name: "x".repeat(100) })).toBe(
			`update bug “${"x".repeat(79)}…”`,
		);
		expect(heldChangeAction("fabric_history_note", {})).toBe(
			"history note",
		);
	});
});
