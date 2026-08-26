/**
 * Work-Item Title Normalization Tests
 *
 * Pins the two pure, deterministic write-time normalizers used by the AI
 * Update path:
 *   - stripWorkItemTitlePrefix: removes leading [BUG]/[FEATURE]/[STORY]/[EPIC]
 *     and Bug:/Feature:/Story:/Epic: prefixes (case-insensitive, repeated),
 *     preserving the casing of the remaining title.
 *   - stripLeadingDuplicateTitleHeading: removes a leading ATX H1 ONLY when it
 *     duplicates the resolved title after both are prefix-stripped.
 *
 * These must NOT reuse normalizeBacklogTitle (packages/database/utils.ts),
 * which lowercases and is dedup-only.
 */

import { describe, expect, it } from "vitest";
import {
	stripLeadingDuplicateTitleHeading,
	stripWorkItemTitlePrefix,
} from "../lib/work-item-title";

describe("stripWorkItemTitlePrefix", () => {
	describe("bracketed prefixes", () => {
		it("strips [BUG]", () => {
			expect(stripWorkItemTitlePrefix("[BUG] X")).toBe("X");
		});

		it("strips [FEATURE]", () => {
			expect(stripWorkItemTitlePrefix("[FEATURE] X")).toBe("X");
		});

		it("strips [STORY]", () => {
			expect(stripWorkItemTitlePrefix("[STORY] X")).toBe("X");
		});

		it("strips [EPIC]", () => {
			expect(stripWorkItemTitlePrefix("[EPIC] X")).toBe("X");
		});
	});

	describe("colon-suffixed prefixes", () => {
		it("strips Bug:", () => {
			expect(stripWorkItemTitlePrefix("Bug: X")).toBe("X");
		});

		it("strips Feature:", () => {
			expect(stripWorkItemTitlePrefix("Feature: X")).toBe("X");
		});

		it("strips Story:", () => {
			expect(stripWorkItemTitlePrefix("Story: X")).toBe("X");
		});

		it("strips Epic:", () => {
			expect(stripWorkItemTitlePrefix("Epic: X")).toBe("X");
		});
	});

	describe("case-insensitivity", () => {
		it("strips lowercase [bug]", () => {
			expect(stripWorkItemTitlePrefix("[bug] X")).toBe("X");
		});

		it("strips lowercase bug:", () => {
			expect(stripWorkItemTitlePrefix("bug: X")).toBe("X");
		});

		it("strips mixed-case [Bug]", () => {
			expect(stripWorkItemTitlePrefix("[Bug] X")).toBe("X");
		});
	});

	describe("repeated prefixes", () => {
		it("strips both colon and bracketed (Bug: [BUG] X)", () => {
			expect(stripWorkItemTitlePrefix("Bug: [BUG] X")).toBe("X");
		});

		it("strips back-to-back bracketed ([BUG][FEATURE] X)", () => {
			expect(stripWorkItemTitlePrefix("[BUG][FEATURE] X")).toBe("X");
		});
	});

	describe("casing preserved", () => {
		it("does NOT lowercase the remaining title", () => {
			expect(stripWorkItemTitlePrefix("[BUG] No Output Generated")).toBe(
				"No Output Generated",
			);
		});
	});

	describe("whitespace handling", () => {
		it("normalizes whitespace between/after prefixes and trims", () => {
			expect(stripWorkItemTitlePrefix("  [BUG]   Bug:   X  ")).toBe("X");
		});

		it("trims a plain title with surrounding whitespace", () => {
			expect(stripWorkItemTitlePrefix("  Hello world  ")).toBe(
				"Hello world",
			);
		});
	});

	describe("no leading prefix", () => {
		it("leaves a plain title unchanged", () => {
			expect(stripWorkItemTitlePrefix("No output generated")).toBe(
				"No output generated",
			);
		});

		it("leaves a mid-string prefix-like token intact", () => {
			expect(stripWorkItemTitlePrefix("Fix the [BUG] handler")).toBe(
				"Fix the [BUG] handler",
			);
		});
	});

	describe("idempotency", () => {
		const inputs = [
			"[BUG] X",
			"Bug: [BUG] X",
			"[BUG][FEATURE] X",
			"[BUG] No Output Generated",
			"Fix the [BUG] handler",
			"No output generated",
			"[BUG] Bug:",
			"",
			"   ",
		];
		for (const input of inputs) {
			it(`f(f(x)) === f(x) for ${JSON.stringify(input)}`, () => {
				const once = stripWorkItemTitlePrefix(input);
				const twice = stripWorkItemTitlePrefix(once);
				expect(twice).toBe(once);
			});
		}
	});

	describe("all-prefix / empty input", () => {
		it("returns empty string when input is only prefixes", () => {
			expect(stripWorkItemTitlePrefix("[BUG] Bug:")).toBe("");
		});

		it("returns empty string for empty input", () => {
			expect(stripWorkItemTitlePrefix("")).toBe("");
		});

		it("returns empty string for whitespace-only input", () => {
			expect(stripWorkItemTitlePrefix("   ")).toBe("");
		});
	});
});

describe("stripLeadingDuplicateTitleHeading", () => {
	it("removes a leading H1 equal to the title", () => {
		const body = "# No output generated\n\nThe rest of the body.";
		expect(
			stripLeadingDuplicateTitleHeading(body, "No output generated"),
		).toBe("The rest of the body.");
	});

	it("removes the B-020-shape H1 and preserves the Bug Metadata block", () => {
		const title =
			"AI Update incorrectly includes Teams channel chat messages";
		const body = `# Bug: ${title}\n\nBug Metadata\n- Severity: High`;
		expect(stripLeadingDuplicateTitleHeading(body, title)).toBe(
			"Bug Metadata\n- Severity: High",
		);
	});

	it("removes the H1 when a prefix appears on either side (keys match)", () => {
		const body = "# [BUG] X\n\nrest";
		expect(stripLeadingDuplicateTitleHeading(body, "Bug: X")).toBe("rest");
	});

	it("leaves a non-matching first heading intact", () => {
		const body = "# Overview\n\nSome overview text.";
		expect(
			stripLeadingDuplicateTitleHeading(body, "No output generated"),
		).toBe(body);
	});

	it("leaves a body starting with a paragraph intact", () => {
		const body = "This is a paragraph.\n\nMore text.";
		expect(
			stripLeadingDuplicateTitleHeading(body, "This is a paragraph."),
		).toBe(body);
	});

	it("leaves a body starting with an H2 intact", () => {
		const body = "## No output generated\n\nrest";
		expect(
			stripLeadingDuplicateTitleHeading(body, "No output generated"),
		).toBe(body);
	});

	it("only touches the first heading (later duplicate preserved)", () => {
		const body =
			"# My title\n\nIntro paragraph.\n\n# My title\n\nDeeper section.";
		expect(stripLeadingDuplicateTitleHeading(body, "My title")).toBe(
			"Intro paragraph.\n\n# My title\n\nDeeper section.",
		);
	});

	it("compares case-insensitively and collapses a single trailing blank line", () => {
		const body = "# NO OUTPUT GENERATED\n\nrest of body";
		expect(
			stripLeadingDuplicateTitleHeading(body, "No output generated"),
		).toBe("rest of body");
	});

	it("ignores leading blank lines before the H1", () => {
		const body = "\n\n# My title\n\nrest";
		expect(stripLeadingDuplicateTitleHeading(body, "My title")).toBe(
			"rest",
		);
	});

	it("handles an ATX H1 with a trailing closing hash sequence", () => {
		const body = "# My title #\n\nrest";
		expect(stripLeadingDuplicateTitleHeading(body, "My title")).toBe(
			"rest",
		);
	});

	it("preserves the body byte-for-byte when there is no trailing blank line", () => {
		const body = "# My title\nimmediately following line";
		expect(stripLeadingDuplicateTitleHeading(body, "My title")).toBe(
			"immediately following line",
		);
	});

	it("returns empty string for an empty body without throwing", () => {
		expect(stripLeadingDuplicateTitleHeading("", "My title")).toBe("");
	});
});
