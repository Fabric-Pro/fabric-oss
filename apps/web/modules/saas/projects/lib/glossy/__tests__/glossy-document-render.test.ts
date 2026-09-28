/**
 * Structure of the Glossy PDF and DOCX. jsPDF and docx are real; their
 * calls are recorded so the tests can read what landed on which page. The
 * canvas step is stubbed (jsdom has none), and so is Mermaid: this file is
 * about layout, and `visual-render.test.ts` covers the diagrams themselves.
 */
import type {
	EditionContent,
	EditionVisual,
} from "@repo/utils/glossy/edition-content";
import type { VisualSpec } from "@repo/utils/glossy/visual-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	renderGlossyDocx,
	renderGlossyPdf,
	resolveRecipientName,
} from "../glossy-document-render";
import { deriveGlossyPalette } from "../palette";

/** A valid 1×1 PNG, so jsPDF and docx really decode and embed it. */
const { PNG_BASE64, PNG_DATA_URL } = vi.hoisted(() => {
	const base64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	return {
		PNG_BASE64: base64,
		PNG_DATA_URL: `data:image/png;base64,${base64}`,
	};
});

const recorder = vi.hoisted(() => ({
	pdf: [] as Array<{
		op: "text" | "image" | "addPage";
		page: number;
		text?: string;
	}>,
	docxParagraphs: [] as Array<Record<string, unknown>>,
	docxTexts: [] as string[],
	docxImages: 0,
}));

vi.mock("jspdf", async (importOriginal) => {
	const actual = await importOriginal<typeof import("jspdf")>();
	// jsPDF is a factory-style constructor, so wrap the instance, not the class.
	function RecordingPdf(...args: ConstructorParameters<typeof actual.jsPDF>) {
		const doc = new actual.jsPDF(...args);
		const page = () => doc.getCurrentPageInfo().pageNumber;
		const text = doc.text.bind(doc);
		const addImage = doc.addImage.bind(doc);
		const addPage = doc.addPage.bind(doc);
		doc.text = ((value: string | string[], ...rest: unknown[]) => {
			recorder.pdf.push({
				op: "text",
				page: page(),
				text: Array.isArray(value) ? value.join(" ") : value,
			});
			return (text as (...a: unknown[]) => typeof doc)(value, ...rest);
		}) as typeof doc.text;
		doc.addImage = ((...params: unknown[]) => {
			recorder.pdf.push({ op: "image", page: page() });
			return (addImage as (...a: unknown[]) => typeof doc)(...params);
		}) as typeof doc.addImage;
		doc.addPage = ((...params: unknown[]) => {
			recorder.pdf.push({ op: "addPage", page: page() });
			return (addPage as (...a: unknown[]) => typeof doc)(...params);
		}) as typeof doc.addPage;
		return doc;
	}
	return { ...actual, default: RecordingPdf, jsPDF: RecordingPdf };
});

vi.mock("docx", async (importOriginal) => {
	const actual = await importOriginal<typeof import("docx")>();
	class Paragraph extends actual.Paragraph {
		constructor(
			options: ConstructorParameters<typeof actual.Paragraph>[0],
		) {
			super(options);
			recorder.docxParagraphs.push(
				typeof options === "string"
					? { text: options }
					: { ...options },
			);
		}
	}
	class TextRun extends actual.TextRun {
		constructor(options: ConstructorParameters<typeof actual.TextRun>[0]) {
			super(options);
			recorder.docxTexts.push(
				typeof options === "string"
					? options
					: String(options.text ?? ""),
			);
		}
	}
	class ImageRun extends actual.ImageRun {
		constructor(options: ConstructorParameters<typeof actual.ImageRun>[0]) {
			super(options);
			recorder.docxImages++;
		}
	}
	return { ...actual, Paragraph, TextRun, ImageRun };
});

vi.mock("../../document-export-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../document-export-helpers")>()),
	svgToPng: vi.fn(async () => ({
		dataUrl: PNG_DATA_URL,
		width: 320,
		height: 120,
	})),
}));

vi.mock("../../markdown-to-document", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../markdown-to-document")>();
	const png = { dataUrl: PNG_DATA_URL, width: 320, height: 120 };
	return {
		...actual,
		// A Mermaid source containing FAIL stands in for a diagram that cannot render.
		renderMermaidToPng: vi.fn(async (code: string) =>
			code.includes("FAIL") ? null : png,
		),
	};
});

const palette = deriveGlossyPalette({ overrides: { primary: "#1e3a8a" } });

const timeline: VisualSpec = {
	kind: "timeline",
	items: [
		{ date: "Q1 2026", label: "Pilot launch" },
		{ date: "Q2 2026", label: "General availability" },
	],
};

function visual(spec: VisualSpec): EditionVisual {
	return {
		kind: spec.kind,
		spec,
		specHash: "hash",
		source:
			spec.kind === "existing_mermaid" ? "existing_mermaid" : "detected",
	};
}

function edition(overrides: Partial<EditionContent> = {}): EditionContent {
	return {
		title: "Example Field Service Portal",
		pipelineVersion: "glossy-1",
		lengthMode: "standard",
		mode: "roll_the_dice",
		sections: [
			{
				sectionKey: "goals",
				headingPath: ["Goals"],
				heading: "Goals",
				level: 2,
				markdown:
					"Dispatch gets **faster** for every crew.\n\n- Fewer handoffs\n- Clear ownership",
				wording: "rewritten",
				anchors: [
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: "rollout" },
					},
				],
			},
			{
				sectionKey: "scope",
				headingPath: ["Scope"],
				heading: "Scope",
				level: 2,
				markdown:
					"| Area | Owner |\n| --- | --- |\n| Dispatch | Operations |\n\nThe map shows coverage.",
				wording: "original",
				keptOriginalReason: "fact_guard",
				anchors: [
					{
						blockIndex: 2,
						ref: {
							type: "image",
							s3Key: "document-media/p1/map.png",
						},
					},
				],
			},
		],
		visuals: { rollout: visual(timeline) },
		appendix: {
			sources: [{ id: "S1", text: "Discovery workshop notes" }],
			details: [{ label: "Client", value: "Example Org" }],
			placeholders: [{ heading: "Proposal Cover", text: "Sponsor: TBD" }],
			assumptions: [
				{
					heading: "Budget",
					text: "The ceiling holds for phase one",
					status: "ASSUMED",
					qualifier: "assumed",
				},
			],
			additionalMaterial: [],
		},
		report: {
			keptOriginal: [],
			droppedVisuals: [],
			unfilledSlots: [],
			scaffoldingUnrecognized: false,
		},
		provenance: {
			sourceTitle: "Project Proposal: Example Field Service Portal",
			sourceVersion: 7,
			builtAt: "2026-09-24T10:15:00.000Z",
		},
		...overrides,
	};
}

const PROVENANCE =
	'Built from "Project Proposal: Example Field Service Portal", version 7, on 2026-09-24.';

const LOGO_URLS = {
	preparer: "https://assets.example.com/preparer.png?signature=1",
	recipient: "https://assets.example.com/recipient.png?signature=2",
	map: "https://assets.example.com/map.png?signature=3",
};

function pngBlob(): Blob {
	const binary = atob(PNG_BASE64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new Blob([bytes], { type: "image/png" });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	recorder.pdf.length = 0;
	recorder.docxParagraphs.length = 0;
	recorder.docxTexts.length = 0;
	recorder.docxImages = 0;
	fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => pngBlob() }));
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const pdfTexts = (page?: number) =>
	recorder.pdf
		.filter(
			(event) =>
				event.op === "text" &&
				(page === undefined || event.page === page),
		)
		.map((event) => event.text ?? "");

describe("renderGlossyPdf", () => {
	it("puts the title and both logos on page one, then sections, then the appendix", async () => {
		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: LOGO_URLS.preparer },
			recipient: { name: "Example Org", logoUrl: LOGO_URLS.recipient },
			imageUrls: { "document-media/p1/map.png": LOGO_URLS.map },
		});

		expect(result.blob.size).toBeGreaterThan(0);
		expect(result).toMatchObject({ omittedVisuals: 0, omittedImages: 0 });

		const pageOne = pdfTexts(1);
		expect(pageOne).toContain("Example Field Service Portal");
		expect(pageOne).toEqual(
			expect.arrayContaining([
				"Prepared by",
				"Example Studio",
				"Prepared for",
				"Example Org",
			]),
		);
		expect(
			recorder.pdf.filter(
				(event) => event.op === "image" && event.page === 1,
			),
		).toHaveLength(2);

		const texts = recorder.pdf.filter((event) => event.op === "text");
		const pageOf = (text: string) =>
			texts.find((event) => event.text === text)?.page ?? -1;
		expect(pageOf("Goals")).toBeGreaterThan(1);
		expect(pageOf("Scope")).toBeGreaterThanOrEqual(pageOf("Goals"));
		expect(pageOf("Appendix")).toBeGreaterThan(pageOf("Scope"));
		// Body content: emphasis stripped, list and table cells drawn.
		const all = pdfTexts();
		expect(all).toContain("Dispatch gets faster for every crew.");
		expect(all).toContain("• Fewer handoffs");
		expect(all).toEqual(expect.arrayContaining(["Area", "Operations"]));
		// The visual and the uploaded image are drawn after page one.
		expect(
			recorder.pdf.filter(
				(event) => event.op === "image" && event.page > 1,
			),
		).toHaveLength(2);

		// Only the three URLs this render was handed were fetched.
		expect(fetchSpy.mock.calls.map(([url]) => url).sort()).toEqual(
			Object.values(LOGO_URLS).sort(),
		);
	});

	it("ends the appendix with the provenance line", async () => {
		await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio" },
		});

		const all = pdfTexts();
		expect(all.at(-1)).toBe(PROVENANCE);
		expect(all).toEqual(
			expect.arrayContaining([
				"Sources",
				"• S1: Discovery workshop notes",
				"• Proposal Cover: Sponsor: TBD",
				"• The ceiling holds for phase one (assumed)",
			]),
		);
	});

	it("names the recipient from the source's client field without a recipient brand", async () => {
		await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio" },
			recipient: null,
		});

		expect(pdfTexts(1)).toEqual(
			expect.arrayContaining(["Prepared for", "Example Org"]),
		);
	});

	it("leaves a failed visual out, counts it, and prints no stand-in", async () => {
		const content = edition({
			visuals: {
				rollout: visual(timeline),
				legacy: visual({
					kind: "existing_mermaid",
					source: "flowchart TD\nFAIL --> B",
				}),
			},
		});
		content.sections[0].anchors.push({
			blockIndex: 0,
			ref: { type: "visual", visualKey: "legacy" },
		});

		const result = await renderGlossyPdf({
			content,
			palette,
			preparer: { name: "Example Studio" },
		});

		expect(result.omittedVisuals).toBe(1);
		const all = pdfTexts().join("\n");
		expect(all).not.toContain("[Diagram");
		expect(all).not.toContain("flowchart");
		expect(all).not.toContain("FAIL");
		// Only the timeline was drawn in the body.
		expect(
			recorder.pdf.filter(
				(event) => event.op === "image" && event.page > 1,
			),
		).toHaveLength(1);
	});

	it("does not count or draw a discarded visual", async () => {
		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio" },
			excludedVisualKeys: new Set(["rollout"]),
		});

		expect(result.omittedVisuals).toBe(0);
		expect(
			recorder.pdf.filter((event) => event.op === "image"),
		).toHaveLength(0);
	});

	it("never fetches a remote image in section text", async () => {
		const content = edition({
			sections: [
				{
					sectionKey: "intro",
					headingPath: ["Intro"],
					heading: "Intro",
					level: 2,
					markdown: [
						"Opening line.",
						"",
						"![tracking pixel](https://tracker.example.com/pixel.png)",
						"",
						'<img src="https://tracker.example.com/tag.png" alt="tag" />',
						"",
						"Inline ![beacon](https://tracker.example.com/beacon.png) text.",
					].join("\n"),
					wording: "rewritten",
					anchors: [],
				},
			],
			visuals: {},
		});

		const result = await renderGlossyPdf({
			content,
			palette,
			preparer: { name: "Example Studio" },
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.omittedImages).toBe(3);
		const all = pdfTexts().join("\n");
		expect(all).not.toContain("tracker.example.com");
		expect(all).not.toContain("[Image");
		expect(all).toContain("Inline text.");
	});

	it("drops raw HTML, slot tags, and diagram source from section text", async () => {
		const content = edition({
			sections: [
				{
					sectionKey: "intro",
					headingPath: ["Intro"],
					heading: "Intro",
					level: 2,
					markdown: [
						'<div onclick="steal()">Kept words</div>',
						"",
						'<visual-slot data-slot-id="s1" data-kind="timeline"></visual-slot>',
						"",
						"```mermaid",
						"flowchart TD",
						"A --> B",
						"```",
					].join("\n"),
					wording: "rewritten",
					anchors: [],
				},
			],
			visuals: {},
		});

		await renderGlossyPdf({
			content,
			palette,
			preparer: { name: "Example Studio" },
		});

		const all = pdfTexts().join("\n");
		expect(all).toContain("Kept words");
		expect(all).not.toMatch(/<div|onclick|visual-slot|flowchart/);
	});

	it("counts a cover logo that fails to load, such as an expired signed read", async () => {
		fetchSpy.mockImplementation(async (url: string) =>
			url === LOGO_URLS.recipient
				? { ok: false, blob: async () => new Blob() }
				: { ok: true, blob: async () => pngBlob() },
		);

		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: LOGO_URLS.preparer },
			recipient: { name: "Example Org", logoUrl: LOGO_URLS.recipient },
			imageUrls: { "document-media/p1/map.png": LOGO_URLS.map },
		});

		// The recipient keeps its name on the cover; only its logo is missing.
		expect(result.omittedImages).toBe(1);
		expect(pdfTexts(1)).toEqual(
			expect.arrayContaining(["Prepared for", "Example Org"]),
		);
		expect(
			recorder.pdf.filter(
				(event) => event.op === "image" && event.page === 1,
			),
		).toHaveLength(1);

		fetchSpy.mockImplementation(async (url: string) => {
			if (url === LOGO_URLS.preparer) {
				throw new TypeError("Failed to fetch");
			}
			return { ok: true, blob: async () => pngBlob() };
		});
		const docx = await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: LOGO_URLS.preparer },
			imageUrls: { "document-media/p1/map.png": LOGO_URLS.map },
		});
		expect(docx.omittedImages).toBe(1);
	});

	it("leaves out an uploaded image the server did not sign", async () => {
		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio" },
			imageUrls: {},
		});

		expect(result.omittedImages).toBe(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("renderGlossyDocx", () => {
	it("has a shaded cover paragraph with the title and image runs for logos and visuals", async () => {
		const result = await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: PNG_DATA_URL },
			recipient: { name: "Example Org", logoUrl: PNG_DATA_URL },
			imageUrls: { "document-media/p1/map.png": LOGO_URLS.map },
		});

		expect(result.blob.size).toBeGreaterThan(0);
		expect(result).toMatchObject({ omittedVisuals: 0, omittedImages: 0 });
		const shaded = recorder.docxParagraphs.filter(
			(options) =>
				(options.shading as { fill?: string } | undefined)?.fill ===
				"1E3A8A",
		);
		expect(shaded.length).toBeGreaterThan(0);
		expect(recorder.docxTexts).toContain("Example Field Service Portal");
		// Two logos, the timeline, and the uploaded map.
		expect(recorder.docxImages).toBe(4);
		expect(recorder.docxTexts).toEqual(
			expect.arrayContaining([
				"Example Studio",
				"Example Org",
				"Appendix",
			]),
		);
		expect(recorder.docxTexts.at(-1)).toBe(PROVENANCE);
	});

	it("leaves a failed visual out and counts it", async () => {
		const content = edition({
			visuals: {
				rollout: visual({
					kind: "existing_mermaid",
					source: "flowchart TD\nFAIL --> B",
				}),
			},
		});

		const result = await renderGlossyDocx({
			content,
			palette,
			preparer: { name: "Example Studio" },
			imageUrls: { "document-media/p1/map.png": LOGO_URLS.map },
		});

		expect(result.omittedVisuals).toBe(1);
		expect(recorder.docxImages).toBe(1);
		expect(recorder.docxTexts.join("\n")).not.toMatch(/\[Diagram|FAIL/);
	});
});

describe("resolveRecipientName", () => {
	it("prefers the saved recipient brand name", () => {
		expect(resolveRecipientName("  Example Buyer ", edition())).toBe(
			"Example Buyer",
		);
	});

	it("falls back to the source's client field", () => {
		expect(resolveRecipientName(null, edition())).toBe("Example Org");
		expect(
			resolveRecipientName(
				"",
				edition({
					appendix: {
						...edition().appendix,
						details: [
							{ label: "**Customer**", value: "**Example Org**" },
						],
					},
				}),
			),
		).toBe("Example Org");
	});

	it("returns null when neither is known", () => {
		expect(
			resolveRecipientName(
				null,
				edition({ appendix: { ...edition().appendix, details: [] } }),
			),
		).toBeNull();
	});
});
