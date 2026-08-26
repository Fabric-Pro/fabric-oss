import { describe, expect, it } from "vitest";
import { contextDownloadFilename } from "../context-download-filename";

describe("contextDownloadFilename", () => {
	describe("slug rules", () => {
		it("lowercases and replaces non-[a-z0-9] runs with a single hyphen", () => {
			expect(
				contextDownloadFilename({
					title: "Hello World!!!",
					class: "B",
				}),
			).toBe("hello-world.md");
		});

		it("collapses repeated hyphens and trims leading/trailing hyphens", () => {
			expect(
				contextDownloadFilename({
					title: "---Foo   Bar---",
					class: "B",
				}),
			).toBe("foo-bar.md");
		});

		it("falls back to 'context' for empty slug after normalization", () => {
			expect(contextDownloadFilename({ title: "   ", class: "B" })).toBe(
				"context.md",
			);
			expect(contextDownloadFilename({ title: null, class: "B" })).toBe(
				"context.md",
			);
			expect(contextDownloadFilename({ title: "***", class: "B" })).toBe(
				"context.md",
			);
		});

		it("normalizes unicode and emoji deterministically", () => {
			expect(
				contextDownloadFilename({
					title: "Café au lait ☕ 2026",
					class: "B",
				}),
			).toBe("caf-au-lait-2026.md");
		});

		it("truncates the stem to 80 characters before appending extension", () => {
			const longTitle = "a".repeat(200);
			const result = contextDownloadFilename({
				title: longTitle,
				class: "B",
			});
			expect(result).toBe(`${"a".repeat(80)}.md`);
			expect(result.endsWith(".md")).toBe(true);
		});
	});

	describe("Class A extension selection", () => {
		it("preserves the original uploaded filename exactly when available", () => {
			// Class A mirrors the source object — the ZIP entry / download name
			// is the uploaded filename verbatim. We do NOT slugify it.
			expect(
				contextDownloadFilename({
					title: "Acme Portal Brief",
					class: "A",
					originalFilename: "brief.pdf",
				}),
			).toBe("brief.pdf");
		});

		it("preserves punctuation and multi-dot original filenames", () => {
			expect(
				contextDownloadFilename({
					title: "ignored",
					class: "A",
					originalFilename: "uncle-bob.txt.txt",
				}),
			).toBe("uncle-bob.txt.txt");
		});

		it("strips path separators from originalFilename for safety", () => {
			expect(
				contextDownloadFilename({
					title: "ignored",
					class: "A",
					originalFilename: "../etc/passwd",
				}),
			).toBe("etc_passwd");
		});

		it("falls back to mimeType mapping when originalFilename missing", () => {
			expect(
				contextDownloadFilename({
					title: "Report",
					class: "A",
					originalFilename: null,
					mimeType: "application/pdf",
				}),
			).toBe("report.pdf");
		});

		it("falls back to .bin when neither originalFilename nor mimeType resolve", () => {
			expect(
				contextDownloadFilename({
					title: "Blob",
					class: "A",
				}),
			).toBe("blob.bin");
		});
	});

	describe("Class B extension", () => {
		it("always uses .md", () => {
			expect(
				contextDownloadFilename({ title: "My Note", class: "B" }),
			).toBe("my-note.md");
		});
	});

	describe("Class C extension", () => {
		it("uses .txt without integration suffix when integration missing", () => {
			expect(
				contextDownloadFilename({
					title: "Release Kickoff",
					class: "C",
				}),
			).toBe("release-kickoff.txt");
		});

		it("appends -{integration} to the stem when integration provided", () => {
			expect(
				contextDownloadFilename({
					title: "Release Kickoff Call",
					class: "C",
					integration: "teams",
				}),
			).toBe("release-kickoff-call-teams.txt");
		});

		it("applies integration suffix after 80-char stem truncation", () => {
			const longTitle = "a".repeat(200);
			const result = contextDownloadFilename({
				title: longTitle,
				class: "C",
				integration: "teams",
			});
			expect(result).toBe(`${"a".repeat(80)}-teams.txt`);
		});
	});
});
