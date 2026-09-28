/**
 * A visual slot is Glossy layout, not document content: the regular
 * Markdown, PDF, and DOCX downloads leave it out (R38). The PDF check reads
 * jsPDF's real, uncompressed output; the DOCX check records the text runs
 * handed to docx.
 */
import { serializeVisualSlot } from "@repo/utils/glossy/visual-slots";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	renderMarkdownToDocx,
	renderMarkdownToPdf,
} from "../markdown-to-document";

const recorder = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock("docx", async (importOriginal) => {
	const actual = await importOriginal<typeof import("docx")>();
	class Paragraph extends actual.Paragraph {
		constructor(
			options: ConstructorParameters<typeof actual.Paragraph>[0],
		) {
			super(options);
			if (typeof options === "string") {
				recorder.texts.push(options);
			} else if (options?.text) {
				recorder.texts.push(options.text);
			}
		}
	}
	class TextRun extends actual.TextRun {
		constructor(options: ConstructorParameters<typeof actual.TextRun>[0]) {
			super(options);
			recorder.texts.push(
				typeof options === "string"
					? options
					: String(options.text ?? ""),
			);
		}
	}
	return { ...actual, Paragraph, TextRun };
});

const slot = serializeVisualSlot({
	id: "slot-1",
	kind: "timeline",
	hint: "Rollout milestones",
});

const markdown = [
	"# Rollout",
	"",
	"Pilot starts in the first quarter.",
	"",
	slot,
	"",
	"General availability follows.",
].join("\n");

function readBlobText(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsText(blob);
	});
}

beforeEach(() => {
	recorder.texts.length = 0;
});

describe("regular downloads skip visual slots", () => {
	it("the markdown fixture really holds a slot line", () => {
		expect(markdown).toContain("<visual-slot");
	});

	it("leaves the slot out of the PDF", async () => {
		const pdf = await readBlobText(await renderMarkdownToPdf(markdown));

		expect(pdf).toContain("Pilot starts in the first quarter.");
		expect(pdf).toContain("General availability follows.");
		expect(pdf).not.toContain("visual-slot");
		expect(pdf).not.toContain("slot-1");
	});

	it("leaves the slot out of the DOCX", async () => {
		await renderMarkdownToDocx(markdown, "Rollout");

		expect(recorder.texts).toEqual(
			expect.arrayContaining([
				"Rollout",
				"Pilot starts in the first quarter.",
				"General availability follows.",
			]),
		);
		expect(recorder.texts.join("\n")).not.toMatch(/visual-slot|slot-1/);
	});

	it("keeps a slot tag shown inside a code block", async () => {
		await renderMarkdownToDocx(
			["```html", slot, "```"].join("\n"),
			"Sample",
		);

		expect(recorder.texts).toContain(slot);
	});
});
