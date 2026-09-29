/**
 * Structure of the Glossy PDF and DOCX. jsPDF and docx are real; their
 * calls are recorded so the tests can read what landed on which page. The
 * canvas step is stubbed (jsdom has none), and so is Mermaid: this file is
 * about layout, and `visual-render.test.ts` covers the diagrams themselves.
 */
import { inflateRawSync } from "node:zlib";
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
	toWinAnsiText,
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

/** A dark, opaque 400×100 PNG: the kind of logo that read as a black block. */
const WIDE_LOGO = { width: 400, height: 100 };
const WIDE_LOGO_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAABkCAIAAAAnqfEgAAABDUlEQVR42u3UQREAAAzCMCzg3yw6tksk9NEU4IhIABgWgGEBhgVgWACGBRgWgGEBGBZgWACGBWBYgGEBGBaAYQGGBWBYAIYFGBaAYQEYFmBYAIYFYFiAYQEYFoBhAYYFYFiAYQEYFoBhAYYFYFgAhgUYFoBhARgWYFgAhgVgWIBhARgWgGEBhgVgWACGBRgWgGEBGBZgWACGBWBYgGEBGBaAYQGGBWBYgGEBGBaAYQGGBWBYAIYFGBaAYQEYFmBYAIYFYFiAYQEYFoBhAYYFYFgAhgUYFoBhARgWYFgAhgVgWIBhARgWgGEBhgVgWIBhARgWgGEBhgVgWACGBRgWgGEBGBZgWACGBWBYwF8D8RcikrgvS3oAAAAASUVORK5CYII=";

/**
 * A PNG whose header reads as 400×100 but whose image data is not a zlib
 * stream: it passes the size check and fails only when decoded.
 */
const CORRUPT_PNG_DATA_URL = (() => {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		return Buffer.concat([
			length,
			Buffer.from(type, "latin1"),
			data,
			Buffer.alloc(4),
		]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(WIDE_LOGO.width, 0);
	header.writeUInt32BE(WIDE_LOGO.height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", Buffer.from("this is not a zlib stream", "latin1")),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return `data:image/png;base64,${png.toString("base64")}`;
})();

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface CanvasCall {
	op: "fill" | "stroke" | "arcTo" | "drawImage";
	/** The fill or stroke style in force. */
	style?: string;
	box?: Box;
}

/**
 * A 2D canvas for the DOCX logo tiles (jsdom has none): each context
 * records what was drawn on it, and images load at once.
 */
function stubCanvas(output: string = PNG_DATA_URL): Array<{
	canvas: HTMLCanvasElement;
	calls: CanvasCall[];
}> {
	const canvases: Array<{ canvas: HTMLCanvasElement; calls: CanvasCall[] }> =
		[];
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		function (this: HTMLCanvasElement) {
			const calls: CanvasCall[] = [];
			canvases.push({ canvas: this, calls });
			const context = {
				fillStyle: "",
				strokeStyle: "",
				lineWidth: 1,
				imageSmoothingEnabled: true,
				imageSmoothingQuality: "low",
				beginPath: () => {},
				moveTo: () => {},
				lineTo: () => {},
				closePath: () => {},
				arcTo: () => calls.push({ op: "arcTo" }),
				fill: () =>
					calls.push({ op: "fill", style: context.fillStyle }),
				stroke: () =>
					calls.push({ op: "stroke", style: context.strokeStyle }),
				drawImage: (
					_image: unknown,
					x: number,
					y: number,
					width: number,
					height: number,
				) =>
					calls.push({
						op: "drawImage",
						box: { x, y, width, height },
					}),
			};
			return context as never;
		},
	);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(output);
	class LoadingImage {
		onload: (() => void) | null = null;
		onerror: ((error: unknown) => void) | null = null;
		set src(_value: string) {
			queueMicrotask(() => this.onload?.());
		}
	}
	vi.stubGlobal("Image", LoadingImage);
	return canvases;
}

const recorder = vi.hoisted(() => ({
	pdf: [] as Array<{
		op: "text" | "image" | "addPage" | "roundedRect";
		page: number;
		text?: string;
		/** `text` only: where its widest line ends, in points. */
		right?: number;
		box?: Box;
		/** `roundedRect` only: its corner radius, style, and colors. */
		radius?: number;
		style?: string;
		fill?: string;
		draw?: string;
	}>,
	docxParagraphs: [] as Array<Record<string, unknown>>,
	docxTexts: [] as string[],
	docxImages: 0,
	docxImageSizes: [] as Array<{ width: number; height: number }>,
	docxPackage: null as Buffer | null,
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
		const roundedRect = doc.roundedRect.bind(doc);
		const setFillColor = doc.setFillColor.bind(doc);
		const setDrawColor = doc.setDrawColor.bind(doc);
		let fill = "";
		let draw = "";
		doc.text = ((value: string | string[], ...rest: unknown[]) => {
			const lines = Array.isArray(value) ? value : [value];
			recorder.pdf.push({
				op: "text",
				page: page(),
				text: lines.join(" "),
				right:
					(rest[0] as number) +
					Math.max(0, ...lines.map((line) => doc.getTextWidth(line))),
			});
			return (text as (...a: unknown[]) => typeof doc)(value, ...rest);
		}) as typeof doc.text;
		doc.addImage = ((...params: unknown[]) => {
			const [x, y, width, height] = params.slice(2, 6) as number[];
			recorder.pdf.push({
				op: "image",
				page: page(),
				box: { x, y, width, height },
			});
			return (addImage as (...a: unknown[]) => typeof doc)(...params);
		}) as typeof doc.addImage;
		doc.setFillColor = ((...params: unknown[]) => {
			fill = String(params[0]);
			return (setFillColor as (...a: unknown[]) => typeof doc)(...params);
		}) as typeof doc.setFillColor;
		doc.setDrawColor = ((...params: unknown[]) => {
			draw = String(params[0]);
			return (setDrawColor as (...a: unknown[]) => typeof doc)(...params);
		}) as typeof doc.setDrawColor;
		doc.roundedRect = ((...params: unknown[]) => {
			const [x, y, width, height, radius] = params as number[];
			recorder.pdf.push({
				op: "roundedRect",
				page: page(),
				box: { x, y, width, height },
				radius,
				style: String(params[6]),
				fill,
				draw,
			});
			return (roundedRect as (...a: unknown[]) => typeof doc)(...params);
		}) as typeof doc.roundedRect;
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
			recorder.docxImageSizes.push({
				width: options.transformation.width,
				height: options.transformation.height,
			});
		}
	}
	// The package as Word receives it, for assertions on its XML.
	const Packer = {
		toBlob: async (file: InstanceType<typeof actual.Document>) => {
			recorder.docxPackage = await actual.Packer.toBuffer(file);
			return actual.Packer.toBlob(file);
		},
	};
	return { ...actual, Paragraph, TextRun, ImageRun, Packer };
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

/**
 * One part of the last DOCX package written, read straight from its ZIP
 * central directory (stored or deflated entries, as docx writes them).
 */
function docxPart(name: string): string {
	const zip = recorder.docxPackage;
	if (!zip) {
		throw new Error("No DOCX was written");
	}
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	let entry = zip.readUInt32LE(end + 16);
	for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
		const method = zip.readUInt16LE(entry + 10);
		const size = zip.readUInt32LE(entry + 20);
		const nameLength = zip.readUInt16LE(entry + 28);
		const skip =
			nameLength +
			zip.readUInt16LE(entry + 30) +
			zip.readUInt16LE(entry + 32);
		const local = zip.readUInt32LE(entry + 42);
		if (
			zip.toString("utf8", entry + 46, entry + 46 + nameLength) === name
		) {
			const start =
				local +
				30 +
				zip.readUInt16LE(local + 26) +
				zip.readUInt16LE(local + 28);
			const data = zip.subarray(start, start + size);
			return (method === 8 ? inflateRawSync(data) : data).toString(
				"utf8",
			);
		}
		entry += 46 + skip;
	}
	throw new Error(`The DOCX has no ${name}`);
}

/** The PDF file as written, one character per byte. */
async function pdfSource(blob: Blob): Promise<string> {
	return Buffer.from(await blob.arrayBuffer()).toString("latin1");
}

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
	recorder.docxImageSizes.length = 0;
	recorder.docxPackage = null;
	fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => pngBlob() }));
	vi.stubGlobal("fetch", fetchSpy);
	// jsdom has no 2D canvas; a test that needs one calls `stubCanvas`.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
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

	it("stores its images Flate-compressed (Fizzy #2589 follow-up)", async () => {
		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: WIDE_LOGO_DATA_URL },
			recipient: { name: "Example Org", logoUrl: WIDE_LOGO_DATA_URL },
			imageUrls: { "document-media/p1/map.png": LOGO_URLS.map },
		});

		// The logos, the timeline and the map; an image drawn twice is
		// stored once, and an alpha channel is an image of its own.
		const images = (await pdfSource(result.blob))
			.split("endobj")
			.filter((object) => object.includes("/Subtype /Image"));
		expect(images.length).toBeGreaterThanOrEqual(2);
		for (const image of images) {
			expect(image).toContain("/Filter /FlateDecode");
		}
	});
});

describe("PDF text outside Windows-1252 (Fizzy #2589 follow-up)", () => {
	/**
	 * What Helvetica and Courier can draw: Latin-1 and Windows-1252's
	 * 0x80–0x9F, less the soft hyphen, which jsPDF draws as a visible hyphen.
	 */
	const WIN_ANSI =
		/^[\t\n\r\x20-\x7e\xa0-\xac\xae-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/;
	const PAGE_RIGHT_MARGIN = 595.28 - 56;

	it("writes common symbols in their ASCII forms", () => {
		expect(toWinAnsiText("≥ 30%")).toBe(">= 30%");
		expect(toWinAnsiText("a → b")).toBe("a -> b");
		expect(toWinAnsiText("≤ ≠ ← ↔ ≈")).toBe("<= != <- <-> ~");
		expect(toWinAnsiText("✓ ✔ ✅")).toBe("Yes Yes Yes");
		expect(toWinAnsiText("✗ ✘ ❌")).toBe("No No No");
	});

	it("turns hyphen, minus and space variants into plain ones and drops invisible characters", () => {
		expect(toWinAnsiText("end\u2011to\u2011end")).toBe("end-to-end");
		expect(toWinAnsiText("\u221215%")).toBe("-15%");
		expect(toWinAnsiText("10\u202f000")).toBe("10 000");
		// U+26A0 is outside Windows-1252; its emoji selector U+FE0F is dropped.
		expect(toWinAnsiText("\u26a0\ufe0f Risk")).toBe("? Risk");
		expect(toWinAnsiText("zero\u200bwidth\ufeff")).toBe("zerowidth");
	});

	it("keeps a Latin letter outside Windows-1252 as its base letter", () => {
		expect(toWinAnsiText("Dvořák")).toBe("Dvorák");
		// The same name with its marks decomposed.
		expect(toWinAnsiText("Dvor\u030ca\u0301k")).toBe("Dvorák");
		expect(toWinAnsiText("Łukasz")).toBe("Lukasz");
		expect(toWinAnsiText("đ Đ ı")).toBe("d D i");
		// A mark with no precomposed letter to join is dropped the same way.
		expect(toWinAnsiText("q\u0301 x\u0308\u0323")).toBe("q x");
	});

	it("passes every Windows-1252 character through unchanged", () => {
		const common = "— – “ ” ‘ ’ … € × · ° é ü ß";
		expect(toWinAnsiText(common)).toBe(common);
		// All of Latin-1 but the soft hyphen, which is dropped (tested below).
		const latin1 = Array.from({ length: 0x60 }, (_, i) =>
			String.fromCharCode(0xa0 + i),
		)
			.filter((char) => char !== "\u00ad")
			.join("");
		const extras = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
		expect(toWinAnsiText(latin1 + extras)).toBe(latin1 + extras);
	});

	it("writes anything else as one ? per code point", () => {
		expect(toWinAnsiText("\u2605")).toBe("?");
		expect(toWinAnsiText("日本")).toBe("??");
		// An emoji outside the Basic Multilingual Plane is one code point.
		expect(toWinAnsiText("Status \u{1f534}")).toBe("Status ?");
	});

	it("writes a character whose plain form is no better as ?", () => {
		// A Hangul syllable decomposes, but into letters that are no better.
		expect(toWinAnsiText("한")).toBe("?");
		// A spacing accent decomposes into a space and a mark: not a stand-in.
		expect(toWinAnsiText("a\u02ddb")).toBe("a?b");
	});

	it("writes up and down arrows as words and double arrows in ASCII", () => {
		expect(toWinAnsiText("Revenue \u2191 20%")).toBe("Revenue up 20%");
		expect(toWinAnsiText("\u219320%")).toBe("down 20%");
		expect(toWinAnsiText("Churn\u2193")).toBe("Churn down");
		expect(toWinAnsiText("\u2191\u2193")).toBe("up down");
		expect(toWinAnsiText("a \u21d2 b \u21d0 c \u21d4 d")).toBe(
			"a => b <= c <=> d",
		);
	});

	it("draws bullet variants as the Windows-1252 bullet", () => {
		expect(
			toWinAnsiText(
				"\u25cf one \u25aa two \u25e6 three \u25b8 four \u25ba five \u2023 six",
			),
		).toBe("• one • two • three • four • five • six");
	});

	it("writes primes as ASCII quotes", () => {
		expect(toWinAnsiText("5\u2032 11\u2033")).toBe("5' 11\"");
	});

	it("writes ligatures, full-width forms, super- and subscripts in their plain forms", () => {
		expect(toWinAnsiText("\ufb01nance \ufb02ow \ufb00 \ufb03 \ufb04")).toBe(
			"finance flow ff ffi ffl",
		);
		expect(toWinAnsiText("\uff21\uff22\uff23 \uff11\uff12\uff13")).toBe(
			"ABC 123",
		);
		// Subscripts flatten: they do not change a figure.
		expect(toWinAnsiText("CO\u2082 H\u2082O")).toBe("CO2 H2O");
		expect(toWinAnsiText("\u2116 5, 12 \u339e")).toBe("No 5, 12 km");
		// A decomposed letter keeps a Windows-1252 letter where it can: ž.
		expect(toWinAnsiText("\u01c5")).toBe("D\u017e");
	});

	it("writes a run of superscripts outside Windows-1252 after a caret, so the figure stays right", () => {
		expect(toWinAnsiText("10\u2076")).toBe("10^6");
		expect(toWinAnsiText("x\u2074")).toBe("x^4");
		expect(toWinAnsiText("10\u207b\u00b3")).toBe("10^-3");
		expect(toWinAnsiText("m\u2074\u2070")).toBe("m^40");
		expect(toWinAnsiText("Ca\u00b2\u207a")).toBe("Ca^2+");
		expect(toWinAnsiText("10\u2076 and 10\u2079 rows")).toBe(
			"10^6 and 10^9 rows",
		);
		// A Windows-1252 superscript in the same run joins it.
		expect(toWinAnsiText("10\u00b9\u2075")).toBe("10^15");
		// A run of ¹ ² ³ alone is Windows-1252 already and stays as it is.
		expect(toWinAnsiText("m\u00b2 m\u00b3 10\u00b9\u00b2")).toBe(
			"m\u00b2 m\u00b3 10\u00b9\u00b2",
		);
		// The caret form maps to itself.
		expect(toWinAnsiText("10^6 x^-3")).toBe("10^6 x^-3");
	});

	it("writes currencies outside Windows-1252 as their ISO codes, set off from the amount", () => {
		expect(toWinAnsiText("\u20b9500")).toBe("INR 500");
		expect(toWinAnsiText("\u20b9 500")).toBe("INR 500");
		expect(toWinAnsiText("500\u20b9")).toBe("500 INR");
		expect(toWinAnsiText("(\u20a9)")).toBe("(KRW)");
		expect(
			toWinAnsiText(
				"\u20bd1 \u20b41 \u20a91 \u20aa1 \u20ba1 \u20a61 \u20ab1",
			),
		).toBe("RUB 1 UAH 1 KRW 1 ILS 1 TRY 1 NGN 1 VND 1");
		// Windows-1252 currencies stay as they are.
		expect(toWinAnsiText("€5 £5 ¥5 $5")).toBe("€5 £5 ¥5 $5");
		// The same spacing for the other word stand-ins.
		expect(toWinAnsiText("\u2713confirmed")).toBe("Yes confirmed");
	});

	it("drops the soft hyphen, which is invisible in text but drawn by jsPDF", () => {
		expect(toWinAnsiText("co\u00adordinate")).toBe("coordinate");
	});

	it("maps its own output to itself", () => {
		const sample = [
			"Uptime ≥ 99.9% → 2026, end\u2011to\u2011end, 10\u202f000",
			"Dvořák Łukasz Dvor\u030ca\u0301k \u01c5 \ufb01 \uff21 x\u2074 10\u00b9\u2075 m\u00b2",
			"\u20b9500 \u2191 \u21d2 \u25cf \u2032 \u2033 co\u00adordinate",
			"日本 한 \u{1f534} \u26a0\ufe0f zero\u200bwidth \u02dd",
			"— – “ ” ‘ ’ … € × · ° é ü ß",
		].join("\n");
		const once = toWinAnsiText(sample);
		expect(once).toMatch(WIN_ANSI);
		expect(toWinAnsiText(once)).toBe(once);
	});

	it("maps 100k characters of CJK, Hangul, emoji and mixed text within budget", () => {
		// Distinct code points, so no per-character shortcut hides the cost.
		const parts: string[] = [];
		for (let i = 0; i < 25_000; i++) {
			parts.push(
				String.fromCodePoint(0x4e00 + (i % 20_000)),
				String.fromCodePoint(0xac00 + (i % 11_000)),
				String.fromCodePoint(0x1f300 + (i % 0x300)),
				i % 2 === 0 ? "ř" : "a",
			);
		}
		const text = parts.join("");
		expect([...text]).toHaveLength(100_000);

		const start = performance.now();
		const mapped = toWinAnsiText(text);
		expect(performance.now() - start).toBeLessThan(500);
		expect(mapped).toHaveLength(100_000);
		expect(mapped).toMatch(WIN_ANSI);
	});

	/** An edition whose every drawn string carries symbols outside Windows-1252. */
	const symbolEdition = () =>
		edition({
			title: "Uptime ≥ 99.9%",
			sections: [
				{
					sectionKey: "targets",
					headingPath: ["Targets → 2026"],
					heading: "Targets → 2026",
					level: 2,
					markdown: [
						"Latency drops ≥ 30% — a → b, end\u2011to\u2011end.",
						"",
						Array.from(
							{ length: 30 },
							(_, i) => `step ${i} → ≥ ${i}%`,
						).join(" "),
						"",
						"- Owner ✓ confirmed",
						"",
						"| Metric | Target |",
						"| --- | --- |",
						"| Uptime | ≥ 99.9% |",
						"",
						"```",
						"fetch → parse → store",
						"```",
					].join("\n"),
					wording: "rewritten",
					anchors: [],
				},
			],
			visuals: {},
		});

	it("draws every string of the PDF mapped and inside the margin: cover, headings, body, lists, tables, code", async () => {
		await renderGlossyPdf({
			content: symbolEdition(),
			palette,
			preparer: { name: "Example Studio → North" },
			recipient: { name: "Example Org ✓" },
		});

		expect(pdfTexts(1)).toEqual(
			expect.arrayContaining([
				"Uptime >= 99.9%",
				"Example Studio -> North",
				"Example Org Yes",
			]),
		);
		expect(pdfTexts()).toEqual(
			expect.arrayContaining([
				"Targets -> 2026",
				"Latency drops >= 30% — a -> b, end-to-end.",
				"• Owner Yes confirmed",
				">= 99.9%",
				"fetch -> parse -> store",
			]),
		);
		const texts = recorder.pdf.filter((event) => event.op === "text");
		expect(texts.length).toBeGreaterThan(10);
		for (const event of texts) {
			expect(event.text).toMatch(WIN_ANSI);
			expect(event.right).toBeLessThanOrEqual(PAGE_RIGHT_MARGIN + 0.01);
		}
	});

	it("keeps the original characters in the DOCX", async () => {
		await renderGlossyDocx({
			content: symbolEdition(),
			palette,
			preparer: { name: "Example Studio → North" },
		});

		expect(recorder.docxTexts).toEqual(
			expect.arrayContaining([
				"Uptime ≥ 99.9%",
				"Example Studio → North",
				"Latency drops ≥ 30% — a → b, end\u2011to\u2011end.",
				"fetch → parse → store",
			]),
		);
		expect(docxPart("docProps/core.xml")).toContain(
			"<dc:title>Uptime ≥ 99.9%</dc:title>",
		);
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

describe("cover logos (Fizzy #2589 follow-up)", () => {
	/** Every point of `inner` lies inside `outer`, clear of its edge. */
	const expectInside = (inner: Box, outer: Box) => {
		expect(inner.x).toBeGreaterThan(outer.x);
		expect(inner.y).toBeGreaterThan(outer.y);
		expect(inner.x + inner.width).toBeLessThan(outer.x + outer.width);
		expect(inner.y + inner.height).toBeLessThan(outer.y + outer.height);
	};

	it("PDF: draws each logo inside a light rounded tile with a border, aspect kept, from its data: URI", async () => {
		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: WIDE_LOGO_DATA_URL },
			recipient: { name: "Example Org", logoUrl: WIDE_LOGO_DATA_URL },
		});

		expect(result.omittedImages).toBe(1); // the unsigned map, not a logo
		expect(fetchSpy).not.toHaveBeenCalled();
		const cover = recorder.pdf.filter((event) => event.page === 1);
		const tiles = cover.filter((event) => event.op === "roundedRect");
		const logos = cover.filter((event) => event.op === "image");
		expect(tiles).toHaveLength(2);
		expect(logos).toHaveLength(2);
		tiles.forEach((tile, index) => {
			const logo = logos[index];
			// The backing is drawn first, filled and outlined.
			expect(cover.indexOf(tile)).toBeLessThan(cover.indexOf(logo));
			expect(tile).toMatchObject({
				style: "FD",
				fill: palette.surface,
				draw: palette.border,
			});
			expect(tile.radius).toBeGreaterThan(0);
			expectInside(logo.box as Box, tile.box as Box);
			const { width, height } = logo.box as Box;
			expect(width / height).toBeCloseTo(
				WIDE_LOGO.width / WIDE_LOGO.height,
			);
		});
	});

	it("DOCX: draws each logo on a light rounded tile with a border, aspect kept", async () => {
		const canvases = stubCanvas();

		await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: WIDE_LOGO_DATA_URL },
			recipient: { name: "Example Org", logoUrl: WIDE_LOGO_DATA_URL },
		});

		expect(canvases).toHaveLength(2);
		for (const tile of canvases) {
			const fill = tile.calls.find((call) => call.op === "fill");
			const stroke = tile.calls.find((call) => call.op === "stroke");
			const draw = tile.calls.find((call) => call.op === "drawImage");
			expect(fill?.style).toBe(palette.surface);
			expect(stroke?.style).toBe(palette.border);
			// Rounded: four arcs, one per corner.
			expect(
				tile.calls.filter((call) => call.op === "arcTo"),
			).toHaveLength(4);
			// The backing goes down before the logo.
			expect(tile.calls.indexOf(fill as never)).toBeLessThan(
				tile.calls.indexOf(draw as never),
			);
			const box = draw?.box as Box;
			expectInside(box, {
				x: 0,
				y: 0,
				width: tile.canvas.width,
				height: tile.canvas.height,
			});
			expect(box.width / box.height).toBeCloseTo(
				WIDE_LOGO.width / WIDE_LOGO.height,
			);
		}
		// The cover's image runs are the tiles, at the tiles' own shape.
		const tileAspect = canvases[0].canvas.width / canvases[0].canvas.height;
		for (const size of recorder.docxImageSizes.slice(0, 2)) {
			expect(size.width / size.height).toBeCloseTo(tileAspect, 1);
		}
	});

	it("DOCX: still draws the logo, without its tile, where no canvas is available", async () => {
		await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: WIDE_LOGO_DATA_URL },
		});

		expect(recorder.docxImageSizes[0].width).toBeGreaterThan(0);
		expect(
			recorder.docxImageSizes[0].width /
				recorder.docxImageSizes[0].height,
		).toBeCloseTo(WIDE_LOGO.width / WIDE_LOGO.height, 1);
	});

	it("DOCX: falls back to the bare logo when the composed tile cannot be read back", async () => {
		// What a browser's canvas returns when it cannot encode the tile.
		const canvases = stubCanvas("data:,");

		const result = await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: WIDE_LOGO_DATA_URL },
		});

		expect(canvases).toHaveLength(1);
		expect(result.omittedImages).toBe(1); // the unsigned map, not the logo
		const logo = recorder.docxImageSizes[0];
		expect(logo.width / logo.height).toBeCloseTo(
			WIDE_LOGO.width / WIDE_LOGO.height,
			1,
		);
	});

	it("PDF: leaves a logo the browser cannot decode off the cover, tile and all, and keeps the name", async () => {
		class BrokenImage {
			onload: (() => void) | null = null;
			onerror: ((error: unknown) => void) | null = null;
			set src(_value: string) {
				queueMicrotask(() => this.onerror?.(new Error("decode")));
			}
		}
		vi.stubGlobal("Image", BrokenImage);

		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: {
				name: "Example Studio",
				logoUrl: "data:image/png;base64,not-a-real-image",
			},
		});

		const cover = recorder.pdf.filter((event) => event.page === 1);
		expect(cover.filter((event) => event.op === "roundedRect")).toEqual([]);
		expect(cover.filter((event) => event.op === "image")).toEqual([]);
		expect(pdfTexts(1)).toContain("Example Studio");
		// The logo, and the map the render was not handed a URL for.
		expect(result.omittedImages).toBe(2);
	});

	it("PDF: draws no empty tile for a logo whose header reads but whose image data does not decode", async () => {
		const result = await renderGlossyPdf({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: CORRUPT_PNG_DATA_URL },
		});

		const cover = recorder.pdf.filter((event) => event.page === 1);
		expect(cover.filter((event) => event.op === "roundedRect")).toEqual([]);
		expect(cover.filter((event) => event.op === "image")).toEqual([]);
		expect(pdfTexts(1)).toContain("Example Studio");
		expect(result.blob.size).toBeGreaterThan(0);
	});
});

describe("DOCX styling (Fizzy #2589 follow-up)", () => {
	const hex = (color: string) => color.replace("#", "").toUpperCase();

	it("sets a sans-serif default font and colors every heading style with the palette's heading color", async () => {
		await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio" },
		});

		const styles = docxPart("word/styles.xml");
		const defaults =
			/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/.exec(styles)?.[1] ??
			"";
		expect(defaults).toMatch(/<w:rFonts [^>]*w:ascii="Arial"/);
		for (let level = 1; level <= 6; level++) {
			const style =
				new RegExp(
					`<w:style [^>]*w:styleId="Heading${level}"[^>]*>([\\s\\S]*?)</w:style>`,
				).exec(styles)?.[1] ?? "";
			expect(style).toContain(
				`<w:color w:val="${hex(palette.heading)}"/>`,
			);
			expect(style).toMatch(/<w:rFonts [^>]*w:ascii="Arial"/);
		}
	});

	it("keeps a brand color that fails contrast on white out of heading text", async () => {
		// Yellow on white is far below 4.5:1, so headings take the neutral ink.
		const light = deriveGlossyPalette({
			overrides: { primary: "#fde047" },
		});
		expect(light.heading).not.toBe(light.primary);

		await renderGlossyDocx({
			content: edition(),
			palette: light,
			preparer: { name: "Example Studio" },
		});

		const styles = docxPart("word/styles.xml");
		const document = docxPart("word/document.xml");
		const brandText = `<w:color w:val="${hex(light.primary)}"/>`;
		expect(styles).not.toContain(brandText);
		expect(document).not.toContain(brandText);
		expect(styles).toContain(`<w:color w:val="${hex(light.heading)}"/>`);
	});

	/** The `<w:p>` holding `text`, from its start tag through its end tag. */
	const paragraphOf = (document: string, text: string) => {
		const at = document.indexOf(`>${text}</w:t>`);
		expect(at).toBeGreaterThan(-1);
		return document.slice(
			document.lastIndexOf("<w:p>", at),
			document.indexOf("</w:p>", at) + "</w:p>".length,
		);
	};
	/** A paragraph's own properties: the `<w:pPr>` it opens with. */
	const propertiesOf = (paragraph: string) =>
		/^<w:p><w:pPr>([\s\S]*?)<\/w:pPr>/.exec(paragraph)?.[1] ?? "";
	/** Where the paragraph holding `text` ends, just past its `</w:p>`. */
	const paragraphEnd = (document: string, text: string) =>
		document.indexOf(paragraphOf(document, text)) +
		paragraphOf(document, text).length;
	const BREAK_BEFORE = "<w:pageBreakBefore/>";
	const breaks = (document: string) =>
		document.split(BREAK_BEFORE).length - 1;

	// A page ends through "page break before" on the paragraph that opens
	// the next one. Quick Look draws a page-break run as a box glyph and
	// does not break there; the paragraph property breaks in Word and draws
	// nothing where a reader ignores it.
	it("ends the cover through page break before on the first body paragraph: no break run, section break, empty paragraph, stray text, or box glyph", async () => {
		await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio", logoUrl: PNG_DATA_URL },
			recipient: { name: "Example Org", logoUrl: PNG_DATA_URL },
		});

		const document = docxPart("word/document.xml");
		const texts = [
			...document.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g),
		].map((match) => match[1]);
		for (const text of texts) {
			expect(text).not.toMatch(/[□�\f]/);
		}
		expect(document).not.toContain("<w:sym");
		expect(document).not.toContain('<w:br w:type="page"/>');
		expect(document).not.toContain("<w:br");
		// One section for the whole document: its properties close the body.
		expect(document.match(/<w:sectPr[\s>]/g)).toHaveLength(1);
		expect(document.indexOf("<w:sectPr")).toBeGreaterThan(
			document.indexOf("version 7, on 2026-09-24."),
		);

		// The cover's last paragraph is followed directly by the first
		// heading, which carries the break in its own properties.
		const coverEnd = paragraphEnd(document, "Example Org");
		const goals = paragraphOf(document, "Goals");
		expect(document.slice(coverEnd).startsWith(goals)).toBe(true);
		expect(propertiesOf(goals)).toContain(BREAK_BEFORE);
		expect(
			propertiesOf(paragraphOf(document, "Example Org")),
		).not.toContain(BREAK_BEFORE);
		expect(breaks(document)).toBe(2);
	});

	it("ends the page before the appendix the same way, and breaks only once when the body is empty", async () => {
		await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio" },
		});

		let document = docxPart("word/document.xml");
		expect(propertiesOf(paragraphOf(document, "Appendix"))).toContain(
			BREAK_BEFORE,
		);
		expect(breaks(document)).toBe(2);

		// Nothing between the cover and the appendix: one break, no blank page.
		await renderGlossyDocx({
			content: edition({ sections: [] }),
			palette,
			preparer: { name: "Example Studio" },
		});
		document = docxPart("word/document.xml");
		expect(breaks(document)).toBe(1);
		expect(propertiesOf(paragraphOf(document, "Appendix"))).toContain(
			BREAK_BEFORE,
		);
		expect(document).not.toContain("<w:br");
	});

	it("breaks the page before a body that opens with a table", async () => {
		const content = edition();
		content.sections = [
			{
				sectionKey: "lead",
				headingPath: [],
				heading: "",
				level: 1,
				markdown:
					"| Area | Owner |\n| --- | --- |\n| Dispatch | Operations |\n\nDispatch follows the table.",
				wording: "original",
				anchors: [],
			},
		];

		await renderGlossyDocx({
			content,
			palette,
			preparer: { name: "Example Studio" },
		});

		const document = docxPart("word/document.xml");
		// The paragraph after the table took no second break.
		expect(
			propertiesOf(paragraphOf(document, "Dispatch follows the table.")),
		).not.toContain(BREAK_BEFORE);
		// The recipient comes from the source's client field; its paragraph
		// ends the cover. A table cannot take the break, so one empty
		// paragraph in front of it does.
		const coverEnd = paragraphEnd(document, "Example Org");
		const before = document.slice(coverEnd, document.indexOf("<w:tbl>"));
		expect(before.match(/<w:p>/g)).toHaveLength(1);
		expect(propertiesOf(before)).toContain(BREAK_BEFORE);
		expect(before).not.toContain("<w:r>");
		expect(breaks(document)).toBe(2);
		expect(document.match(/<w:sectPr[\s>]/g)).toHaveLength(1);
	});

	it("gives each table column widths that fill the body, so Quick Look does not squeeze its columns", async () => {
		const table = (columns: number) => {
			const row = (label: string) =>
				`| ${Array.from({ length: columns }, (_, c) => `${label} ${c + 1}`).join(" | ")} |`;
			return [
				row("Column"),
				`|${" --- |".repeat(columns)}`,
				row("Value"),
			].join("\n");
		};
		const content = edition();
		content.sections = [
			{
				sectionKey: "tables",
				headingPath: ["Tables"],
				heading: "Tables",
				level: 2,
				markdown: `${table(2)}\n\n${table(4)}`,
				wording: "original",
				anchors: [],
			},
		];

		await renderGlossyDocx({
			content,
			palette,
			preparer: { name: "Example Studio" },
		});

		const document = docxPart("word/document.xml");
		// The body's width, from the page the document itself declares.
		const attribute = (tag: string, name: string) =>
			Number(
				new RegExp(`<w:${tag} [^>]*w:${name}="(\\d+)"`).exec(
					document,
				)?.[1],
			);
		const bodyWidth =
			attribute("pgSz", "w") -
			attribute("pgMar", "left") -
			attribute("pgMar", "right");
		expect(bodyWidth).toBeGreaterThan(0);
		const tables = [
			...document.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g),
		].map((match) => match[1]);
		expect(tables).toHaveLength(2);
		tables.forEach((xml, index) => {
			const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(
				(match) => Number(match[1]),
			);
			expect(grid).toHaveLength([2, 4][index]);
			// docx's own grid, when no widths are given, is 100 twips a column.
			expect(grid).not.toContain(100);
			expect(grid.reduce((sum, width) => sum + width, 0)).toBe(bodyWidth);
			expect(Math.max(...grid) - Math.min(...grid)).toBeLessThanOrEqual(
				1,
			);
			expect(xml).toContain(`<w:tblW w:type="dxa" w:w="${bodyWidth}"/>`);
			// Cell text is padded off the borders.
			const cellMargins = xml.match(
				/<w:tblCellMar>([\s\S]*?)<\/w:tblCellMar>/,
			);
			expect(cellMargins?.[1]).toMatch(
				/<w:left w:type="dxa" w:w="100"\/>/,
			);
			expect(cellMargins?.[1]).toMatch(
				/<w:right w:type="dxa" w:w="100"\/>/,
			);
		});
	});

	it("breaks the page before a body that opens with a visual", async () => {
		const content = edition();
		content.sections = [
			{
				sectionKey: "lead",
				headingPath: [],
				heading: "",
				level: 1,
				markdown: "The rollout runs in two steps.",
				wording: "original",
				anchors: [
					{
						blockIndex: 0,
						ref: { type: "visual", visualKey: "rollout" },
					},
				],
			},
		];

		await renderGlossyDocx({
			content,
			palette,
			preparer: { name: "Example Studio" },
		});

		const document = docxPart("word/document.xml");
		const coverEnd = paragraphEnd(document, "Example Org");
		const visual = document.slice(
			coverEnd,
			document.indexOf("</w:p>", coverEnd) + "</w:p>".length,
		);
		expect(visual).toContain("<w:drawing>");
		expect(propertiesOf(visual)).toContain(BREAK_BEFORE);
		expect(breaks(document)).toBe(2);
	});

	it("names Arial on every text run and Courier New on code, so readers that skip the default font keep it", async () => {
		const content = edition();
		content.sections.push({
			sectionKey: "build",
			headingPath: ["Build"],
			heading: "Build",
			level: 2,
			markdown:
				"Run `pnpm build` first.\n\n> Keep the **quote** short.\n\n```\nconst answer = 42;\n```",
			wording: "original",
			anchors: [],
		});

		await renderGlossyDocx({
			content,
			palette,
			preparer: { name: "Example Studio", logoUrl: PNG_DATA_URL },
			recipient: { name: "Example Org", logoUrl: PNG_DATA_URL },
			imageUrls: { "document-media/p1/map.png": LOGO_URLS.map },
		});

		const document = docxPart("word/document.xml");
		const runs = [...document.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map(
			(match) => match[1],
		);
		const textRuns = runs.filter((run) => run.includes("<w:t"));
		// Image runs carry a drawing and no text or font.
		expect(runs.filter((run) => run.includes("<w:drawing>"))).toHaveLength(
			4,
		);
		expect(textRuns.length).toBeGreaterThan(20);
		const code = ["pnpm build", "const answer = 42;"];
		for (const run of textRuns) {
			const text = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/.exec(run)?.[1] ?? "";
			const font = /<w:rFonts [^>]*w:ascii="([^"]+)"/.exec(run)?.[1];
			expect(font, text).toBe(
				code.includes(text) ? "Courier New" : "Arial",
			);
		}
	});

	it("spaces body paragraphs, list items and headings, on the paragraphs and in the styles", async () => {
		await renderGlossyDocx({
			content: edition(),
			palette,
			preparer: { name: "Example Studio" },
		});

		/** The `<w:spacing>` values in `xml`, as numbers. */
		const spacing = (xml: string) => {
			const attributes = /<w:spacing ([^>]*)\/>/.exec(xml)?.[1] ?? "";
			const value = (name: string) =>
				Number(
					new RegExp(`w:${name}="(\\d+)"`).exec(attributes)?.[1] ?? 0,
				);
			return {
				before: value("before"),
				after: value("after"),
				line: value("line"),
			};
		};
		const document = docxPart("word/document.xml");
		const body = spacing(
			propertiesOf(paragraphOf(document, "Dispatch gets ")),
		);
		const item = spacing(
			propertiesOf(paragraphOf(document, "Fewer handoffs")),
		);
		const heading = spacing(propertiesOf(paragraphOf(document, "Scope")));
		expect(body.after).toBeGreaterThan(0);
		expect(body.line).toBeGreaterThan(240);
		expect(item.after).toBeGreaterThan(0);
		expect(item.after).toBeLessThan(body.after);
		expect(heading.before).toBeGreaterThan(body.after);
		expect(heading.after).toBeGreaterThan(0);

		const styles = docxPart("word/styles.xml");
		const defaults =
			/<w:pPrDefault>([\s\S]*?)<\/w:pPrDefault>/.exec(styles)?.[1] ?? "";
		expect(spacing(defaults)).toEqual(body);
		for (let level = 1; level <= 6; level++) {
			const style =
				new RegExp(
					`<w:style [^>]*w:styleId="Heading${level}"[^>]*>([\\s\\S]*?)</w:style>`,
				).exec(styles)?.[1] ?? "";
			expect(spacing(style).before).toBeGreaterThan(body.after);
		}

		// Level 1 and level 3 headings carry their spacing on the paragraph
		// too, not only level 2.
		const content = edition();
		content.sections.push(
			{
				sectionKey: "overview",
				headingPath: ["Overview"],
				heading: "Overview",
				level: 1,
				markdown: "The overview opens the second part.",
				wording: "original",
				anchors: [],
			},
			{
				sectionKey: "overview-risks",
				headingPath: ["Overview", "Risks"],
				heading: "Risks",
				level: 3,
				markdown: "Two risks remain open.",
				wording: "original",
				anchors: [],
			},
		);
		await renderGlossyDocx({
			content,
			palette,
			preparer: { name: "Example Studio" },
		});
		const withLevels = docxPart("word/document.xml");
		const levelOne = propertiesOf(paragraphOf(withLevels, "Overview"));
		const levelThree = propertiesOf(paragraphOf(withLevels, "Risks"));
		expect(levelOne).toContain('<w:pStyle w:val="Heading1"/>');
		expect(levelThree).toContain('<w:pStyle w:val="Heading3"/>');
		for (const properties of [levelOne, levelThree]) {
			expect(spacing(properties).before).toBeGreaterThan(body.after);
			expect(spacing(properties).after).toBeGreaterThan(0);
			expect(spacing(properties).after).toBeLessThan(
				spacing(properties).before,
			);
		}
		// A larger heading gets at least as much room above it.
		expect(spacing(levelOne).before).toBeGreaterThanOrEqual(
			spacing(levelThree).before,
		);
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

	it("reads a Proposal's Client/Team field, however the slash is spaced, but never its Sponsor", () => {
		const withDetails = (
			details: EditionContent["appendix"]["details"],
		): EditionContent =>
			edition({ appendix: { ...edition().appendix, details } });

		expect(
			resolveRecipientName(
				null,
				withDetails([
					{ label: "Sponsor", value: "Example Sponsor" },
					{ label: "Client/Team", value: "Example Co" },
				]),
			),
		).toBe("Example Co");
		expect(
			resolveRecipientName(
				null,
				withDetails([
					{ label: "**Client / Team**", value: "Example Co" },
				]),
			),
		).toBe("Example Co");
		expect(
			resolveRecipientName(
				null,
				withDetails([{ label: "Sponsor", value: "Example Sponsor" }]),
			),
		).toBeNull();
	});

	it("puts a Client/Team recipient on the PDF cover when no recipient brand is saved", async () => {
		await renderGlossyPdf({
			content: edition({
				appendix: {
					...edition().appendix,
					details: [{ label: "Client/Team", value: "Example Co" }],
				},
			}),
			palette,
			preparer: { name: "Example Studio" },
			recipient: null,
		});

		expect(pdfTexts(1)).toEqual(
			expect.arrayContaining(["Prepared for", "Example Co"]),
		);
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
