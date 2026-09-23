/**
 * `lessonSlug`, `lessonPath` and `renderLesson` — the pure helpers behind
 * `fabric_add_instruction_lesson`.
 *
 * No session, no access gate, no `@repo/database`: these are string-in,
 * string-out functions, exercised directly. The tool's own argument
 * validation, access gate and `submitInstructionChange` wiring are covered in
 * `platform-tools-instructions.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { lessonPath, lessonSlug, renderLesson } from "../instruction-lessons";

describe("lessonSlug", () => {
	it("lowercases and hyphenates a plain title", () => {
		expect(lessonSlug("Never Skip The Migration Check")).toBe(
			"never-skip-the-migration-check",
		);
	});

	it("folds accented Unicode to its base letter", () => {
		expect(lessonSlug("Café Régression")).toBe("cafe-regression");
	});

	it("collapses punctuation and whitespace runs into a single hyphen", () => {
		expect(lessonSlug("Don't  use --force   (again!)")).toBe(
			"don-t-use-force-again",
		);
	});

	it("trims leading and trailing hyphens", () => {
		expect(lessonSlug("  -- Wrapped in punctuation -- ")).toBe(
			"wrapped-in-punctuation",
		);
	});

	it("falls back to 'lesson' for a punctuation-only title", () => {
		expect(lessonSlug("!!! --- ???")).toBe("lesson");
	});

	it("falls back to 'lesson' for a title with no foldable characters", () => {
		expect(lessonSlug("   ")).toBe("lesson");
	});

	it("caps the slug at 60 characters without a trailing hyphen", () => {
		const title =
			"This title is deliberately long enough that its slug has to be truncated to stay under the cap";
		const slug = lessonSlug(title);

		expect(slug.length).toBeLessThanOrEqual(60);
		expect(slug.endsWith("-")).toBe(false);
		expect(slug).toBe(
			"this-title-is-deliberately-long-enough-that-its-slug-has-to",
		);
	});

	it("keeps a slug exactly at the 60-character cap untouched", () => {
		const title = "a".repeat(60);

		expect(lessonSlug(title)).toBe("a".repeat(60));
	});

	it("drops exactly one character for a slug one over the cap", () => {
		const title = "a".repeat(61);

		expect(lessonSlug(title)).toBe("a".repeat(60));
	});
});

describe("lessonPath", () => {
	const date = new Date("2026-09-23T12:00:00.000Z");

	it("builds Lessons/<date>-<slug>.md", () => {
		expect(
			lessonPath("Never skip the migration check", date, new Set()),
		).toBe("Lessons/2026-09-23-never-skip-the-migration-check.md");
	});

	it("reads the date in UTC regardless of local offset within the same instant", () => {
		const lateUtc = new Date("2026-09-23T23:30:00.000Z");

		expect(lessonPath("Title", lateUtc, new Set())).toBe(
			"Lessons/2026-09-23-title.md",
		);
	});

	it("suffixes -2 when the unsuffixed path is already taken", () => {
		const taken = new Set(["Lessons/2026-09-23-title.md"]);

		expect(lessonPath("Title", date, taken)).toBe(
			"Lessons/2026-09-23-title-2.md",
		);
	});

	it("keeps incrementing the suffix past the first collision", () => {
		const taken = new Set([
			"Lessons/2026-09-23-title.md",
			"Lessons/2026-09-23-title-2.md",
			"Lessons/2026-09-23-title-3.md",
		]);

		expect(lessonPath("Title", date, taken)).toBe(
			"Lessons/2026-09-23-title-4.md",
		);
	});

	it("compares against 'taken' case-insensitively", () => {
		const taken = new Set(["lessons/2026-09-23-title.md"]);

		expect(lessonPath("Title", date, taken)).toBe(
			"Lessons/2026-09-23-title-2.md",
		);
	});

	it("throws once every suffix up to the cap is taken", () => {
		const taken = new Set(["Lessons/2026-09-23-title.md"]);
		for (let n = 2; n <= 50; n++) {
			taken.add(`Lessons/2026-09-23-title-${n}.md`);
		}

		expect(() => lessonPath("Title", date, taken)).toThrow();
	});
});

describe("renderLesson", () => {
	const date = new Date("2026-09-23T12:00:00.000Z");

	it("renders frontmatter, heading and body without a related list", () => {
		const rendered = renderLesson({
			title: "Never skip the migration check",
			body: "We shipped a migration without running it against staging first.\n\nRun `pnpm migrate` before every deploy.",
			date,
			relatedPaths: [],
		});

		expect(rendered).toBe(
			[
				"---",
				'name: "Never skip the migration check"',
				'description: "We shipped a migration without running it against staging first."',
				"date: 2026-09-23",
				"---",
				"",
				"# Never skip the migration check",
				"",
				"We shipped a migration without running it against staging first.",
				"",
				"Run `pnpm migrate` before every deploy.",
				"",
			].join("\n"),
		);
		expect(rendered.endsWith("\n")).toBe(true);
		expect(rendered).not.toContain("related:");
	});

	it("renders a related: list when relatedPaths is non-empty", () => {
		const rendered = renderLesson({
			title: "Title",
			body: "Body.",
			date,
			relatedPaths: [
				"fabric/standards/backend/migrations.md",
				"AGENTS.md",
			],
		});

		expect(rendered).toContain(
			[
				"related:",
				"  - fabric/standards/backend/migrations.md",
				"  - AGENTS.md",
				"---",
			].join("\n"),
		);
	});

	it("trims the body and collapses it to end with exactly one trailing newline", () => {
		const rendered = renderLesson({
			title: "Title",
			body: "\n\n  Leading and trailing whitespace.  \n\n",
			date,
			relatedPaths: [],
		});

		expect(rendered.endsWith("Leading and trailing whitespace.\n")).toBe(
			true,
		);
		expect(rendered.endsWith("whitespace.\n\n")).toBe(false);
	});

	it("truncates the description to 160 characters from the body's first line", () => {
		const firstLine = "x".repeat(200);
		const rendered = renderLesson({
			title: "Title",
			body: `${firstLine}\nSecond line`,
			date,
			relatedPaths: [],
		});
		const descriptionLine = rendered
			.split("\n")
			.find((line) => line.startsWith("description: "));

		// The body itself is untouched (it legitimately still carries the
		// full 200-character first line below the frontmatter) — only the
		// `description:` field is capped.
		expect(descriptionLine).toBe(`description: "${"x".repeat(160)}"`);
		expect(rendered).toContain(firstLine);
	});

	it("double-quotes and escapes a title containing quotes and backslashes", () => {
		const rendered = renderLesson({
			title: 'Say "hello" to C:\\paths',
			body: "Body.",
			date,
			relatedPaths: [],
		});

		expect(rendered).toContain('name: "Say \\"hello\\" to C:\\\\paths"');
		// The escaped title is also what heads the body as an H1, unescaped.
		expect(rendered).toContain('# Say "hello" to C:\\paths');
	});

	it("escapes quotes in the description the same way", () => {
		const rendered = renderLesson({
			title: "Title",
			body: 'The "quick" fix broke prod.',
			date,
			relatedPaths: [],
		});

		expect(rendered).toContain(
			'description: "The \\"quick\\" fix broke prod."',
		);
	});

	it("drops a carriage return from the description of a CRLF body", () => {
		const rendered = renderLesson({
			title: "Title",
			body: "First line.\r\nSecond line.\r\n",
			date,
			relatedPaths: [],
		});

		expect(rendered).toContain('description: "First line."\n');
	});
});
