import { describe, expect, it } from "vitest";
import { appendAttachmentsSection } from "../append-attachments-section";

/**
 * Every heading line that reads as an Attachments section, decoration and
 * demotion included — so a "did we stamp a duplicate?" assertion can't be
 * fooled by the very markup that caused the duplicate.
 */
function attachmentsHeadings(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => /^#{2,6} .*Attachments/.test(line));
}

describe("appendAttachmentsSection", () => {
	it("returns description unchanged when no uploads", () => {
		expect(appendAttachmentsSection("hello", [])).toBe("hello");
	});

	it("appends a new ## Attachments block when none exists", () => {
		const out = appendAttachmentsSection("hello", [
			{ s3Key: "story-media/p/s/a.png", name: "a.png" },
			{ s3Key: "story-media/p/s/b.png", name: "b.png" },
		]);
		expect(out).toBe(
			"hello\n\n## Attachments\n\n![a.png](story-media/p/s/a.png)\n![b.png](story-media/p/s/b.png)\n",
		);
	});

	it("preserves a single trailing newline (no double blank line)", () => {
		const out = appendAttachmentsSection("hello\n", [
			{ s3Key: "story-media/p/s/a.png", name: "a.png" },
		]);
		expect(out).toBe(
			"hello\n\n## Attachments\n\n![a.png](story-media/p/s/a.png)\n",
		);
	});

	it("sanitizes filenames that would break markdown link syntax", () => {
		const out = appendAttachmentsSection("", [
			{ s3Key: "story-media/p/s/x.png", name: "weird]name[.png" },
		]);
		expect(out).toContain("![weird name .png](story-media/p/s/x.png)");
	});

	it("falls back to 'Attachment N' when the sanitized name is empty", () => {
		const out = appendAttachmentsSection("", [
			{ s3Key: "story-media/p/s/x.png", name: "[]" },
		]);
		expect(out).toContain("![Attachment 1](story-media/p/s/x.png)");
	});

	it("appends under an existing ## Attachments heading without creating a duplicate", () => {
		const input =
			"hello\n\n## Attachments\n\n![old.png](story-media/p/s/old.png)\n";
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/new.png", name: "new.png" },
		]);
		expect(out).toBe(
			"hello\n\n## Attachments\n\n![old.png](story-media/p/s/old.png)\n![new.png](story-media/p/s/new.png)\n",
		);
		expect(out.match(/## Attachments/g)).toHaveLength(1);
	});

	it("is idempotent — calling twice with the same uploads does not duplicate entries", () => {
		const uploads = [
			{ s3Key: "story-media/p/s/a.png", name: "a.png" },
			{ s3Key: "story-media/p/s/b.png", name: "b.png" },
		];
		const once = appendAttachmentsSection("hello", uploads);
		const twice = appendAttachmentsSection(once, uploads);
		expect(twice).toBe(once);
	});

	it("only appends fresh keys when some are already present", () => {
		const input =
			"hello\n\n## Attachments\n\n![a.png](story-media/p/s/a.png)\n";
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/a.png", name: "a.png" }, // already there
			{ s3Key: "story-media/p/s/c.png", name: "c.png" }, // new
		]);
		expect(out).toBe(
			"hello\n\n## Attachments\n\n![a.png](story-media/p/s/a.png)\n![c.png](story-media/p/s/c.png)\n",
		);
	});

	it("sanitizes parentheses in filenames so markdown links don't break", () => {
		const out = appendAttachmentsSection("", [
			{ s3Key: "story-media/p/s/x.png", name: "screenshot (1).png" },
		]);
		expect(out).toContain("![screenshot  1 .png](story-media/p/s/x.png)");
	});

	it("inserts the block ABOVE a trailing HTML 'View in Fabric' back-link", () => {
		const input =
			'body\n<p><a href="https://x/app/p/s">View in Fabric</a></p>';
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/a.png", name: "a.png" },
		]);
		expect(out).toBe(
			'body\n\n## Attachments\n\n![a.png](story-media/p/s/a.png)\n\n<p><a href="https://x/app/p/s">View in Fabric</a></p>',
		);
		expect(out.indexOf("story-media/p/s/a.png")).toBeLessThan(
			out.indexOf("View in Fabric"),
		);
	});

	it("inserts the block ABOVE a trailing markdown 'View in Fabric' back-link (Fizzy form)", () => {
		const input = "body\n[View in Fabric](https://x/app/p/s)";
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/a.png", name: "a.png" },
		]);
		expect(out).toBe(
			"body\n\n## Attachments\n\n![a.png](story-media/p/s/a.png)\n\n[View in Fabric](https://x/app/p/s)",
		);
		expect(out.indexOf("story-media/p/s/a.png")).toBeLessThan(
			out.indexOf("View in Fabric"),
		);
	});

	// -------------------------------------------------------------------------
	// Decorated headings (editor highlight / bold). The section must still be
	// recognised, and the decoration must survive untouched — the normalizer is
	// match-only and its output must never be written back.
	// -------------------------------------------------------------------------

	it("appends under an existing HIGHLIGHTED ## Attachments heading instead of creating a second section", () => {
		const input =
			'hello\n\n## <mark data-color="#fef08a">Attachments</mark>\n\n![old.png](story-media/p/s/old.png)\n';
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/new.png", name: "new.png" },
		]);
		expect(out).toBe(
			'hello\n\n## <mark data-color="#fef08a">Attachments</mark>\n\n![old.png](story-media/p/s/old.png)\n![new.png](story-media/p/s/new.png)\n',
		);
		// No plain heading was stamped, and the user's markup is byte-preserved.
		expect(out).not.toContain("## Attachments");
		expect(attachmentsHeadings(out)).toHaveLength(1);
	});

	it("appends under an existing BOLDED ## Attachments heading instead of creating a second section", () => {
		const input =
			"hello\n\n## **Attachments**\n\n![old.png](story-media/p/s/old.png)\n";
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/new.png", name: "new.png" },
		]);
		expect(out).toBe(
			"hello\n\n## **Attachments**\n\n![old.png](story-media/p/s/old.png)\n![new.png](story-media/p/s/new.png)\n",
		);
		expect(attachmentsHeadings(out)).toHaveLength(1);
	});

	it("treats a DEMOTED ### Attachments heading as an existing section (substring predicate)", () => {
		const input =
			"hello\n\n### Attachments\n\n![old.png](story-media/p/s/old.png)\n";
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/new.png", name: "new.png" },
		]);
		expect(out).toBe(
			"hello\n\n### Attachments\n\n![old.png](story-media/p/s/old.png)\n![new.png](story-media/p/s/new.png)\n",
		);
		expect(attachmentsHeadings(out)).toHaveLength(1);
	});

	it("converges to ONE section across repeated appends to a decorated document", () => {
		const input =
			'body\n\n## <mark data-color="#fef08a">Attachments</mark>\n';
		let out = input;
		for (const key of ["a", "b", "c"]) {
			out = appendAttachmentsSection(out, [
				{ s3Key: `story-media/p/s/${key}.png`, name: `${key}.png` },
			]);
		}
		expect(attachmentsHeadings(out)).toHaveLength(1);
		expect(out).toContain("![a.png](story-media/p/s/a.png)");
		expect(out).toContain("![c.png](story-media/p/s/c.png)");
		// Re-running with keys already present is still a no-op.
		expect(
			appendAttachmentsSection(out, [
				{ s3Key: "story-media/p/s/a.png", name: "a.png" },
			]),
		).toBe(out);
	});

	it("creates the section exactly once for a document that has no Attachments heading", () => {
		const first = appendAttachmentsSection("hello", [
			{ s3Key: "story-media/p/s/a.png", name: "a.png" },
		]);
		const second = appendAttachmentsSection(first, [
			{ s3Key: "story-media/p/s/b.png", name: "b.png" },
		]);
		expect(attachmentsHeadings(second)).toHaveLength(1);
	});

	it("appends into an existing block of an ALREADY-CORRUPTED document instead of stamping a third", () => {
		// The shape this bug leaves behind: the original section was decorated,
		// so the next append no longer matched it and created a plain duplicate.
		// The append lands at the tail of the document (inside the last block) —
		// the invariant under test is that no THIRD heading appears; merging the
		// two existing blocks is out of scope for this helper.
		const input =
			'hello\n\n## <mark data-color="#fef08a">Attachments</mark>\n\n![a.png](story-media/p/s/a.png)\n\n## Attachments\n\n![b.png](story-media/p/s/b.png)\n';
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/c.png", name: "c.png" },
		]);
		expect(out).toBe(`${input}![c.png](story-media/p/s/c.png)\n`);
		expect(attachmentsHeadings(out)).toHaveLength(2);
		expect(
			out.match(/!\[c\.png\]\(story-media\/p\/s\/c\.png\)/g),
		).toHaveLength(1);
	});

	it("merges into an existing ## Attachments block kept above the back-link", () => {
		const input =
			'body\n\n## Attachments\n\n![old.png](story-media/p/s/old.png)\n\n<p><a href="https://x">View in Fabric</a></p>';
		const out = appendAttachmentsSection(input, [
			{ s3Key: "story-media/p/s/new.png", name: "new.png" },
		]);
		expect(out).toBe(
			'body\n\n## Attachments\n\n![old.png](story-media/p/s/old.png)\n![new.png](story-media/p/s/new.png)\n\n<p><a href="https://x">View in Fabric</a></p>',
		);
		expect(out.match(/## Attachments/g)).toHaveLength(1);
		expect(out.indexOf("story-media/p/s/new.png")).toBeLessThan(
			out.indexOf("View in Fabric"),
		);
	});
});
