import { describe, expect, it } from "vitest";
import {
	appendAttachmentBlock,
	renderAttachmentBlock,
	stripAttachmentBlock,
} from "../gitlab-attachment-block";

const PATH = `/uploads/${"a".repeat(32)}/spec.pdf`;

describe("renderAttachmentBlock", () => {
	it("returns empty string when there is nothing to say", () => {
		expect(renderAttachmentBlock({ links: [], excluded: [] })).toBe("");
	});

	it("renders synced files as markdown links", () => {
		const out = renderAttachmentBlock({
			links: [{ filename: "spec.pdf", path: PATH }],
			excluded: [],
		});
		expect(out).toContain(`[spec.pdf](${PATH})`);
		expect(out).toContain("<!-- fabric:attachments -->");
		expect(out).toContain("<!-- /fabric:attachments -->");
	});

	it("renders one protected note per excluded file, with no path", () => {
		const out = renderAttachmentBlock({
			links: [],
			excluded: ["design_v2.png", "mock.sketch"],
		});
		expect(out).toContain(
			"[Fabric protected attachment — not synced] design_v2.png",
		);
		expect(out).toContain(
			"[Fabric protected attachment — not synced] mock.sketch",
		);
		expect(out).not.toContain("/uploads/");
	});

	it("escapes markdown metacharacters in filenames", () => {
		const out = renderAttachmentBlock({
			links: [{ filename: "a[b](c).pdf", path: PATH }],
			excluded: [],
		});
		expect(out).toContain("a\\[b\\]\\(c\\).pdf");
	});

	it("leaves an ordinary filename unchanged apart from existing escaping", () => {
		const out = renderAttachmentBlock({
			links: [{ filename: "normal-file_v2.final.pdf", path: PATH }],
			excluded: [],
		});
		expect(out).toContain(`[normal-file_v2.final.pdf](${PATH})`);
	});
});

describe("stripAttachmentBlock", () => {
	it("removes exactly the block and leaves surrounding text", () => {
		const body = "before\n\n";
		const tail = "\n\nafter";
		const block = renderAttachmentBlock({
			links: [{ filename: "spec.pdf", path: PATH }],
			excluded: [],
		});
		expect(stripAttachmentBlock(body + block + tail).trim()).toBe(
			"before\n\nafter".trim(),
		);
	});

	it("is a no-op when there is no block", () => {
		expect(stripAttachmentBlock("plain body")).toBe("plain body");
	});

	it("removes every block when a duplicate slipped in", () => {
		const block = renderAttachmentBlock({ links: [], excluded: ["a.png"] });
		const out = stripAttachmentBlock(`x${block}${block}y`);
		expect(out).not.toContain("fabric:attachments");
		expect(out).toContain("x");
		expect(out).toContain("y");
	});

	it("does not eat text when the close marker is missing", () => {
		const broken = "keep me <!-- fabric:attachments --> dangling";
		expect(stripAttachmentBlock(broken)).toContain("keep me");
		expect(stripAttachmentBlock(broken)).toContain("dangling");
	});

	it("fully removes a block whose synced filename contains the literal close-fence text", () => {
		const evilFilename = "evil<!-- /fabric:attachments -->.pdf";
		const block = renderAttachmentBlock({
			links: [{ filename: evilFilename, path: PATH }],
			excluded: [],
		});
		const out = stripAttachmentBlock(`before${block}after`);
		expect(out).not.toContain("fabric:attachments");
	});

	it("fully removes a block whose excluded filename contains the literal close-fence text", () => {
		const evilFilename = "evil<!-- /fabric:attachments -->.png";
		const block = renderAttachmentBlock({
			links: [],
			excluded: [evilFilename],
		});
		const out = stripAttachmentBlock(`before${block}after`);
		expect(out).not.toContain("fabric:attachments");
	});
});

describe("round trip", () => {
	it("append → strip returns the original body", () => {
		const body = "the description";
		const block = renderAttachmentBlock({
			links: [{ filename: "spec.pdf", path: PATH }],
			excluded: ["secret.png"],
		});
		expect(
			stripAttachmentBlock(appendAttachmentBlock(body, block)).trim(),
		).toBe(body);
	});

	it("append → strip → append is byte-identical", () => {
		const body = "the description";
		const block = renderAttachmentBlock({
			links: [{ filename: "spec.pdf", path: PATH }],
			excluded: [],
		});
		const once = appendAttachmentBlock(body, block);
		const twice = appendAttachmentBlock(stripAttachmentBlock(once), block);
		expect(twice).toBe(once);
	});
});
