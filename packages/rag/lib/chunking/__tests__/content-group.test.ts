import { describe, expect, it } from "vitest";
import { contentGroupFor } from "../tuning";

describe("contentGroupFor", () => {
	it("uses the known kind first", () => {
		expect(
			contentGroupFor({
				kind: "adr",
				content: "# A\ntext\n# B\ntext",
				mimeType: "text/markdown",
				filename: "a.md",
			}),
		).toBe("adr");
	});

	it("groups unclassified content by the shape it has", () => {
		const base = { mimeType: "text/markdown", filename: "x.md" };
		expect(
			contentGroupFor({
				...base,
				content: "# One\nSome text.\n\n# Two\nMore text.",
			}),
		).toBe("sectioned");
		expect(
			contentGroupFor({
				...base,
				content: "- EX-1 a\n- EX-2 b\n- EX-3 c\n- EX-4 d\n- EX-5 e",
			}),
		).toBe("items");
		expect(
			contentGroupFor({
				...base,
				content: "Plain prose without any structure at all.",
			}),
		).toBe("prose");
	});
});
