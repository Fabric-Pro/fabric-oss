/**
 * The Proposal export's Word writer (Fizzy #2946), read back the way Word
 * reads it: each test builds a real DOCX, opens the package and asserts on
 * its parts.
 */

import {
	buildProposalThemeTokens,
	resolveThemePaint,
} from "@repo/utils/proposal-artifact/theme-tokens";
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type BuildDocxInput, buildProposalDocx } from "../build-docx";
import { prepareExportMarkdown } from "../markdown";
import type { ExportDiagram, ExportRaster, ExportThemeTokens } from "../types";

const PROJECT_ID = "project-example";
const DOCUMENT_ID = "document-example";
const MEDIA = `document-media/${PROJECT_ID}/${DOCUMENT_ID}/`;

const PRIMARY = "#1d4ed8";
const DISPLAY_FONT = "Example Display";
/** A mono family apart from the body's, so a label's face is provable. */
const MONO_FONT = "Example Mono";
/** The paint's colours for these tokens, as Word writes them. */
const BRAND = "1D4ED8";
const INK = "111827";
/** The brand accent, which reads as text on the paper. */
const LABEL = "475569";

function sourced<T>(value: T) {
	return { value, source: "MANUAL" as const };
}

function tokens(
	options: {
		proposerName?: string | null;
		recipientName?: string | null;
		proposerLogo?: ExportRaster | null;
		recipientLogo?: ExportRaster | null;
		hero?: ExportRaster | null;
	} = {},
): ExportThemeTokens {
	return {
		proposer: {
			name: sourced(
				options.proposerName === undefined
					? "Example Org"
					: options.proposerName,
			),
			logo: sourced(options.proposerLogo ?? null),
			primary: sourced(PRIMARY),
			accents: sourced(["#475569"]),
			surface: sourced("#ffffff"),
			ink: sourced("#111827"),
			fonts: {
				display: sourced(DISPLAY_FONT),
				body: sourced("Inter"),
				mono: sourced("Inter"),
			},
			hero: sourced(options.hero ?? null),
		},
		recipient: {
			name: sourced(
				options.recipientName === undefined
					? "Example Client"
					: options.recipientName,
			),
			logo: sourced(options.recipientLogo ?? null),
			colors: sourced([]),
		},
	};
}

async function raster(
	format: "png" | "jpeg",
	width = 40,
	height = 20,
): Promise<ExportRaster> {
	const image = sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 40, g: 90, b: 160 },
		},
	});
	const bytes =
		format === "png"
			? await image.png().toBuffer()
			: await image.jpeg().toBuffer();
	return {
		mimeType: format === "png" ? "image/png" : "image/jpeg",
		bytes,
		width,
		height,
	};
}

function input(
	markdown: string,
	overrides: Partial<BuildDocxInput> = {},
): BuildDocxInput {
	return {
		prepared: prepareExportMarkdown(markdown),
		diagrams: [],
		images: new Map(),
		tokens: tokens(),
		projectId: PROJECT_ID,
		documentId: DOCUMENT_ID,
		title: "Example Proposal",
		dateLabel: "October 15, 2026",
		...overrides,
	};
}

interface Package {
	files: string[];
	read(path: string): Promise<string>;
}

async function build(source: BuildDocxInput) {
	const result = await buildProposalDocx(source);
	const zip = await JSZip.loadAsync(result.buffer);
	const pkg: Package = {
		files: Object.keys(zip.files),
		async read(path) {
			const file = zip.file(path);
			if (!file) {
				throw new Error(`missing part ${path}`);
			}
			return file.async("string");
		},
	};
	return { ...result, pkg };
}

/** Tokens with no brand at all: every font role in the neutral style. */
function neutralTokens(): ExportThemeTokens {
	return buildProposalThemeTokens({
		organization: null,
		style: null,
		brandKit: null,
		recipient: null,
	}) as unknown as ExportThemeTokens;
}

/** A Main with headings, bold body text and a table's mono header cells. */
const FONT_SAMPLE = [
	"# Overview",
	"## Approach",
	"Text with **bold words**.",
	"| Phase | Weeks |\n|---|---|\n| Discovery | 2 |",
].join("\n\n");

/** One style's definition in `styles.xml`. */
function styleXml(styles: string, styleId: string): string | undefined {
	return new RegExp(
		`<w:style\\b[^>]*w:styleId="${styleId}"[\\s\\S]*?</w:style>`,
	).exec(styles)?.[0];
}

/** The font table's entries, its relationships and the embedded parts. */
async function fontTable(pkg: Package) {
	const read = async (path: string) =>
		pkg.files.includes(path) ? pkg.read(path) : "";
	const table = await read("word/fontTable.xml");
	const rels = await read("word/_rels/fontTable.xml.rels");
	const entries = new Map(
		[
			...table.matchAll(/<w:font w:name="([^"]+)">([\s\S]*?)<\/w:font>/g),
		].map(([, name, content]) => [name ?? "", content ?? ""]),
	);
	return {
		entries,
		/** The slots an entry fills, in the order it writes them. */
		slots: (name: string) =>
			[...(entries.get(name) ?? "").matchAll(/<w:(embed\w+) /g)].map(
				([, slot]) => slot,
			),
		references: [...table.matchAll(/r:id="([^"]+)"/g)].map(
			([, id]) => id ?? "",
		),
		targets: new Map(
			[...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(
				([, id, target]) => [id ?? "", target ?? ""],
			),
		),
		parts: pkg.files.filter(
			(file) => file.startsWith("word/fonts/") && !file.endsWith("/"),
		),
	};
}

/** Each section's properties, in document order (the cover first). */
function sections(documentXml: string): string[] {
	return documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) ?? [];
}

function attribute(element: string, name: string): string | null {
	const match = new RegExp(`${name}="([^"]*)"`).exec(element);
	return match?.[1] ?? null;
}

function pageSize(section: string): {
	width: number;
	height: number;
	orient: string | null;
} {
	const element = /<w:pgSz\b[^>]*\/>/.exec(section)?.[0] ?? "";
	return {
		width: Number(attribute(element, "w:w")),
		height: Number(attribute(element, "w:h")),
		orient: attribute(element, "w:orient"),
	};
}

/** The external targets `document.xml.rels` declares. */
function externalTargets(rels: string): string[] {
	return Array.from(
		rels.matchAll(/<Relationship\b[^>]*\/>/g),
		(match) => match[0],
	)
		.filter((element) => /TargetMode="External"/.test(element))
		.map((element) => attribute(element, "Target") ?? "");
}

function isMedia(file: string): boolean {
	return file.startsWith("word/media/") && !file.endsWith("/");
}

function tables(documentXml: string): string[] {
	return documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
}

function rowsOf(table: string): string[] {
	return table.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? [];
}

function cellsOf(row: string): string[] {
	return row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? [];
}

/** Whether a cell draws a border of its own. */
function isBordered(cell: string): boolean {
	return /<w:tcBorders>[\s\S]*?w:val="single"[\s\S]*?<\/w:tcBorders>/.test(
		cell,
	);
}

/** The first run whose text starts with `text`, properties included. */
function runWith(xml: string, text: string): string {
	const run = Array.from(
		xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g),
		(match) => match[0],
	).find((candidate) =>
		/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/
			.exec(candidate)?.[1]
			?.startsWith(
				text
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;"),
			),
	);
	expect(run, `a run starting "${text}"`).toBeDefined();
	return run ?? "";
}

describe("buildProposalDocx: raw HTML", () => {
	const KEY = `${MEDIA}chart.png`;
	const SIGNED = "https://storage.example.com/chart.png?X-Amz-Signature=abc";

	it("leaves comments out, block and inline, as the page does", async () => {
		const { pkg } = await build(
			input(
				[
					"<!-- internal note for the team -->",
					"",
					"Visible <!-- hidden aside --> text.",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).not.toContain("internal note");
		expect(documentXml).not.toContain("hidden aside");
		expect(documentXml).toContain("Visible");
	});

	it("places an uploaded image whose alt and caption hold < and >", async () => {
		const png = await raster("png");
		const { pkg } = await build(
			input(
				`<img src="${SIGNED}" alt="Before -> after" data-s3-key="${KEY}" data-caption="1 &lt; 2 > 0" />`,
				{ images: new Map([[KEY, png]]) },
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(pkg.files.some((file) => file.startsWith("word/media/"))).toBe(
			true,
		);
		expect(documentXml).toContain("1 &lt; 2 &gt; 0");
		expect(documentXml).not.toContain("X-Amz-Signature");
		expect(documentXml).not.toContain(KEY);
	});

	it("leaves out a refused stored-image tag and a stored file link's tag, never printing the key or signed URL", async () => {
		const png = await raster("png");
		const { pkg } = await build(
			input(
				[
					`<img src="${SIGNED}" alt="x" data-s3-key="${KEY}" data-s3-key="${KEY}" />`,
					"",
					`Inline <a href="${SIGNED}" data-s3-key="${KEY}">file</a> link.`,
				].join("\n"),
				{ images: new Map([[KEY, png]]) },
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).not.toContain("X-Amz-Signature");
		expect(documentXml).not.toContain(KEY);
		expect(documentXml).toContain("file");
	});

	it("never prints or links an image tag the parser could not read, or one with no key", async () => {
		const { pkg, warnings } = await build(
			input(
				[
					"Before.",
					"",
					`<img src="${SIGNED}" alt="27" display.png" width="320" data-s3-key="${KEY}" data-caption="Our desk" />`,
					"",
					`<img src="${SIGNED}" alt="Desk" />`,
					"",
					'<img src="https://example.com/team.png" alt="Team" />',
					"",
					"After.",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const rels = await pkg.read("word/_rels/document.xml.rels");
		expect(documentXml).toContain("Before.");
		expect(documentXml).toContain("After.");
		expect(`${documentXml}${rels}`).not.toContain("X-Amz-Signature");
		expect(`${documentXml}${rels}`).not.toContain("storage.example.com");
		expect(documentXml).not.toContain(KEY);
		expect(documentXml).not.toContain("team.png");
		expect(warnings).toEqual([
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 1 },
		]);
	});

	it("never prints or links a stored object's URL written into Main", async () => {
		const { pkg } = await build(
			input(
				[
					`See ${SIGNED} for the chart.`,
					"",
					`Or [the chart](${SIGNED}) and <https://storage.example.com/${KEY}>.`,
					"",
					`[brief]: https://storage.example.com/${KEY}`,
					"",
					"The [brief][brief] stays as words.",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const rels = await pkg.read("word/_rels/document.xml.rels");
		expect(`${documentXml}${rels}`).not.toMatch(
			/X-Amz|document-media|storage\.example\.com/,
		);
		expect(documentXml).toContain("for the chart.");
		expect(documentXml).toContain("the chart");
		expect(documentXml).toContain("stays as words.");
	});

	it("prints raw HTML less its comments", async () => {
		const { pkg } = await build(
			input("<!-- draft note --> visible remainder"),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).toContain("visible remainder");
		expect(documentXml).not.toContain("draft note");
	});
});

describe("buildProposalDocx", () => {
	it("gives every ordered list its own numbering, each restarting at its start", async () => {
		const { pkg } = await build(
			input(
				[
					"1. First step",
					"2. Second step",
					"",
					"Between the lists.",
					"",
					"1. Another first",
					"2. Another second",
					"",
					"Then a list that starts later.",
					"",
					"3. Third",
					"4. Fourth",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const numbering = await pkg.read("word/numbering.xml");

		const numIds = Array.from(
			documentXml.matchAll(/<w:numId w:val="(\d+)"\/>/g),
			(match) => match[1],
		);
		const distinct = [...new Set(numIds)];
		expect(numIds).toHaveLength(6);
		expect(distinct).toHaveLength(3);

		const startOf = (numId: string | undefined) => {
			const num = new RegExp(
				`<w:num w:numId="${numId}">[\\s\\S]*?</w:num>`,
			).exec(numbering)?.[0];
			expect(num).toBeDefined();
			return attribute(
				/<w:startOverride\b[^>]*\/>/.exec(num ?? "")?.[0] ?? "",
				"w:val",
			);
		};
		expect(startOf(distinct[0])).toBe("1");
		expect(startOf(distinct[1])).toBe("1");
		expect(startOf(distinct[2])).toBe("3");
	});

	it("embeds an uploaded JPEG and PNG with their real types and leaves a foreign key out", async () => {
		const jpeg = await raster("jpeg");
		const png = await raster("png");
		const { pkg } = await build(
			input(
				[
					`<img src="https://example.com/a.jpg" alt="Team photo" data-s3-key="${MEDIA}photo.jpg" data-caption="Our delivery team" />`,
					"",
					`<img src="https://example.com/b.png" alt="Chart" width="200" data-s3-key="${MEDIA}chart.png" />`,
					"",
					`<img src="https://example.com/c.png" alt="Elsewhere" data-s3-key="document-media/other-project/other-document/x.png" />`,
				].join("\n"),
				{
					images: new Map([
						[`${MEDIA}photo.jpg`, jpeg],
						[`${MEDIA}chart.png`, png],
						[
							"document-media/other-project/other-document/x.png",
							png,
						],
					]),
				},
			),
		);
		const media = pkg.files.filter(isMedia);
		expect(media).toHaveLength(2);
		expect(media.some((file) => /\.(jpe?g)$/.test(file))).toBe(true);
		expect(media.some((file) => file.endsWith(".png"))).toBe(true);

		const contentTypes = await pkg.read("[Content_Types].xml");
		const defaults = Array.from(
			contentTypes.matchAll(/<Default\b[^>]*\/>/g),
			(match) => match[0],
		);
		const typeOf = (extension: string) =>
			attribute(
				defaults.find((element) =>
					element.includes(`Extension="${extension}"`),
				) ?? "",
				"ContentType",
			);
		expect(typeOf("jpg")).toBe("image/jpeg");
		expect(typeOf("png")).toBe("image/png");

		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).toContain("Our delivery team");
		expect(documentXml).not.toContain("data-s3-key");
		expect(documentXml).not.toContain("other-project");
		const rels = await pkg.read("word/_rels/document.xml.rels");
		expect(externalTargets(rels)).toEqual([]);
	});

	it("sets a table wider than six columns on a landscape page between portrait Letter pages", async () => {
		const header = `| ${Array.from({ length: 7 }, (_, i) => `Column ${i + 1}`).join(" | ")} |`;
		const rule = `|${" --- |".repeat(7)}`;
		const row = `| ${Array.from({ length: 7 }, (_, i) => `Value ${i + 1}`).join(" | ")} |`;
		const { pkg } = await build(
			input(
				[
					"## Pricing",
					"",
					"Before the table.",
					"",
					header,
					rule,
					row,
					"",
					"After the table.",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const sizes = sections(documentXml).map(pageSize);
		// Cover, contents, body, the landscape table, the body again.
		expect(sizes).toHaveLength(5);
		for (const index of [0, 1, 2, 4]) {
			expect(sizes[index]).toEqual({
				width: 12240,
				height: 15840,
				orient: "portrait",
			});
		}
		const landscape = sizes[3];
		expect(landscape?.orient).toBe("landscape");
		expect(landscape?.width).toBeGreaterThan(landscape?.height ?? 0);
		expect(landscape).toEqual({
			width: 15840,
			height: 12240,
			orient: "landscape",
		});

		// The wide table carries the header row Word repeats on each page.
		const [wide] = tables(documentXml);
		expect(wide).toContain("<w:tblHeader/>");
		expect(wide).toContain("Column 7");
	});

	it("takes a section heading right before a wide table onto its landscape page", async () => {
		const header = `| ${Array.from({ length: 7 }, (_, i) => `Column ${i + 1}`).join(" | ")} |`;
		const rule = `|${" --- |".repeat(7)}`;
		const row = `| ${Array.from({ length: 7 }, (_, i) => `Value ${i + 1}`).join(" | ")} |`;
		const { pkg } = await build(
			input(
				[
					"## Pricing",
					"",
					"Fees by phase.",
					"",
					"## Appendix A: Assumptions",
					"",
					header,
					rule,
					row,
					"",
					"Start date: TBD",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const sizes = sections(documentXml).map(pageSize);
		// A section's break sits in the properties of its last paragraph, so
		// the section a text belongs to is counted from the start of the
		// paragraph holding it: one break per section that ended before. The
		// last occurrence, since the contents field lists the headings too.
		const sectionOf = (text: string) => {
			const at = documentXml.lastIndexOf(text);
			const starts = [...documentXml.matchAll(/<w:p[ >]/g)].map(
				(match) => match.index ?? 0,
			);
			const paragraphStart = Math.max(
				...starts.filter((start) => start < at),
			);
			return (
				documentXml.slice(0, paragraphStart).match(/<w:sectPr\b/g) ?? []
			).length;
		};

		expect(sizes[sectionOf("Appendix A: Assumptions")]?.orient).toBe(
			"landscape",
		);
		expect(sectionOf("Appendix A: Assumptions")).toBe(
			sectionOf("Column 7"),
		);
		expect(sizes[sectionOf("Fees by phase.")]?.orient).toBe("portrait");
		expect(sizes[sectionOf("Start date: TBD")]?.orient).toBe("portrait");
	});

	it("sets the neutral style in the print faces, Inter's bold as Inter set bold", async () => {
		const { pkg } = await build(
			input(FONT_SAMPLE, { tokens: neutralTokens() }),
		);
		const styles = await pkg.read("word/styles.xml");
		const documentXml = await pkg.read("word/document.xml");

		expect(styleXml(styles, "Heading1")).toContain('w:ascii="Poppins"');
		expect(
			/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)?.[0],
		).toContain('w:ascii="Inter"');
		// The cover eyebrow is in the mono role, in its Medium face.
		expect(documentXml).toContain('w:ascii="JetBrains Mono Medium"');
		const boldRun = /<w:r>(?:(?!<\/w:r>)[\s\S])*?bold words/.exec(
			documentXml,
		)?.[0];
		expect(boldRun).toContain('w:ascii="Inter"');
		expect(boldRun).toContain("<w:b/>");
		expect(`${styles}${documentXml}`).not.toContain("Arial");
		expect(`${styles}${documentXml}`).not.toContain("Inter Bold");
	});

	it("embeds the neutral print faces, each in its family's slots", async () => {
		const { pkg } = await build(
			input(FONT_SAMPLE, { tokens: neutralTokens() }),
		);
		const fonts = await fontTable(pkg);

		expect([...fonts.entries.keys()]).toEqual([
			"Inter",
			"Poppins",
			"JetBrains Mono",
			"JetBrains Mono Medium",
		]);
		expect(fonts.slots("Inter")).toEqual(["embedRegular", "embedBold"]);
		// Poppins ships bold only; display runs are bold and take that slot.
		expect(fonts.slots("Poppins")).toEqual(["embedRegular", "embedBold"]);
		expect(fonts.slots("JetBrains Mono")).toEqual(["embedRegular"]);
		// The Medium face is a family of its own, which the labels name.
		expect(fonts.slots("JetBrains Mono Medium")).toEqual(["embedRegular"]);
		expect(fonts.parts).toHaveLength(5);
		for (const part of fonts.parts) {
			expect(part).toMatch(/^word\/fonts\/font\d\.odttf$/);
		}
		// Every face the table names is a part of the package.
		expect(fonts.references.length).toBe(6);
		for (const id of fonts.references) {
			expect(fonts.parts).toContain(`word/${fonts.targets.get(id)}`);
		}
	});

	it("names a brand's fonts and embeds none, even a neutral family the brand chose", async () => {
		// The fixture's brand chose Inter for body and mono.
		const { pkg } = await build(input(FONT_SAMPLE));
		const styles = await pkg.read("word/styles.xml");
		const fonts = await fontTable(pkg);

		expect(styleXml(styles, "Heading1")).toContain(
			`w:ascii="${DISPLAY_FONT}"`,
		);
		expect(fonts.entries.size).toBe(0);
		expect(fonts.parts).toEqual([]);
		expect(fonts.targets.size).toBe(0);
	});

	it("embeds only the faces of the roles a brand left neutral", async () => {
		const neutral = neutralTokens();
		const { pkg } = await build(
			input(FONT_SAMPLE, {
				tokens: {
					...neutral,
					proposer: {
						...neutral.proposer,
						fonts: {
							...neutral.proposer.fonts,
							display: sourced(DISPLAY_FONT),
						},
					},
				},
			}),
		);
		const styles = await pkg.read("word/styles.xml");
		const fonts = await fontTable(pkg);

		expect(styleXml(styles, "Heading1")).toContain(
			`w:ascii="${DISPLAY_FONT}"`,
		);
		expect([...fonts.entries.keys()]).toEqual([
			"Inter",
			"JetBrains Mono",
			"JetBrains Mono Medium",
		]);
		expect(fonts.parts).toHaveLength(4);
	});

	it("embeds Poppins' bold face in its bold slot only when a brand sets body text in Poppins", async () => {
		const neutral = neutralTokens();
		const { pkg } = await build(
			input(FONT_SAMPLE, {
				tokens: {
					...neutral,
					proposer: {
						...neutral.proposer,
						fonts: {
							...neutral.proposer.fonts,
							body: sourced("Poppins"),
						},
					},
				},
			}),
		);
		const styles = await pkg.read("word/styles.xml");
		const fonts = await fontTable(pkg);

		// Body runs and the neutral display name the same family; a bold
		// face in the regular slot would set every body run bold.
		expect(styleXml(styles, "Heading1")).toContain('w:ascii="Poppins"');
		expect(
			/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)?.[0],
		).toContain('w:ascii="Poppins"');
		expect([...fonts.entries.keys()]).toEqual([
			"Poppins",
			"JetBrains Mono",
			"JetBrains Mono Medium",
		]);
		expect(fonts.slots("Poppins")).toEqual(["embedBold"]);
		expect(fonts.slots("JetBrains Mono")).toEqual(["embedRegular"]);
		expect(fonts.parts).toHaveLength(3);
	});

	it("embeds both of Inter's faces when a brand sets the display in Inter", async () => {
		const neutral = neutralTokens();
		const { pkg } = await build(
			input(FONT_SAMPLE, {
				tokens: {
					...neutral,
					proposer: {
						...neutral.proposer,
						fonts: {
							...neutral.proposer.fonts,
							display: sourced("Inter"),
						},
					},
				},
			}),
		);
		const styles = await pkg.read("word/styles.xml");
		const fonts = await fontTable(pkg);

		// Each Inter face is its own weight, so the brand's bold display runs
		// take the real bold face and nothing changes.
		expect(styleXml(styles, "Heading1")).toContain('w:ascii="Inter"');
		expect([...fonts.entries.keys()]).toEqual([
			"Inter",
			"JetBrains Mono",
			"JetBrains Mono Medium",
		]);
		expect(fonts.slots("Inter")).toEqual(["embedRegular", "embedBold"]);
		expect(fonts.parts).toHaveLength(4);
	});

	it("styles headings in the display font and in ink, never Word's blue", async () => {
		const { pkg } = await build(
			input("# Overview\n\n## Approach\n\nText."),
		);
		const styles = await pkg.read("word/styles.xml");
		const heading1 =
			/<w:style\b[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/.exec(
				styles,
			)?.[0];
		expect(heading1).toBeDefined();
		expect(heading1).toContain(`w:ascii="${DISPLAY_FONT}"`);
		expect(heading1).toContain(`<w:color w:val="${INK}"/>`);
		expect(heading1).not.toContain(BRAND);
		for (const blue of ["2F5496", "4472C4", "2E74B5", "1F4D78", "0563C1"]) {
			expect(styles).not.toContain(blue);
		}
		const title =
			/<w:style\b[^>]*w:styleId="Title"[\s\S]*?<\/w:style>/.exec(
				styles,
			)?.[0];
		expect(title).toContain(`w:ascii="${DISPLAY_FONT}"`);
		expect(title).toContain(`<w:color w:val="${INK}"/>`);
		// Links keep the brand colour.
		const hyperlink =
			/<w:style\b[^>]*w:styleId="Hyperlink"[\s\S]*?<\/w:style>/.exec(
				styles,
			)?.[0];
		expect(hyperlink).toContain(`<w:color w:val="${BRAND}"/>`);
	});

	it("sets every heading run, the cover title and the Contents heading in ink, and bullets in the label colour", async () => {
		const { pkg } = await build(
			input(
				[
					"## Approach with [a link](https://example.com/approach)",
					"",
					"### Detail",
					"",
					"- First point",
					"- Second point",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const paragraphs = documentXml.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
		const styled = (style: string) =>
			paragraphs.filter((paragraph) =>
				paragraph.includes(`<w:pStyle w:val="${style}"/>`),
			);
		const colours = (paragraph: string) =>
			Array.from(paragraph.matchAll(/<w:r>[\s\S]*?<\/w:r>/g), (run) => ({
				text: /<w:t[^>]*>([^<]*)<\/w:t>/.exec(run[0])?.[1] ?? "",
				color: /<w:color w:val="([0-9A-F]{6})"\/>/.exec(run[0])?.[1],
			})).filter((run) => run.text !== "");

		const [heading2] = styled("Heading2");
		expect(colours(heading2 ?? "")).toEqual([
			{ text: "Approach with ", color: INK },
			// A link in a heading keeps the link colour.
			{ text: "a link", color: BRAND },
		]);
		expect(colours(styled("Heading3")[0] ?? "")).toEqual([
			{ text: "Detail", color: INK },
		]);
		expect(colours(styled("Title")[0] ?? "")).toEqual([
			{ text: "Example Proposal", color: INK },
		]);
		const contents = paragraphs.find((paragraph) =>
			paragraph.includes(">Contents</w:t>"),
		);
		expect(colours(contents ?? "")).toEqual([
			{ text: "Contents", color: INK },
		]);

		// The list's own first level, not docx's built-in default list.
		const numbering = await pkg.read("word/numbering.xml");
		const bullets = (
			numbering.match(/<w:lvl\b[\s\S]*?<\/w:lvl>/g) ?? []
		).filter((level) => level.includes('<w:lvlText w:val="•"/>'));
		expect(bullets.length).toBeGreaterThan(0);
		for (const bullet of bullets) {
			expect(bullet).toContain(`<w:color w:val="${LABEL}"/>`);
		}
	});

	it("keeps only http(s) and mailto links and prints every other link as text", async () => {
		const markdown = String.raw`See [the site](https://example.com/page), [mail us](mailto:dev@example.com), [a file](file:///etc/hosts), [a share](\\\\server\\share), [a script](javascript:alert(1)) and [pricing](#pricing).`;
		const { pkg } = await build(input(markdown));
		const rels = await pkg.read("word/_rels/document.xml.rels");
		expect(externalTargets(rels).sort()).toEqual([
			"https://example.com/page",
			"mailto:dev@example.com",
		]);
		expect(rels).not.toMatch(/file:|javascript:|server/);

		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml.match(/<w:hyperlink\b/g)).toHaveLength(2);
		for (const text of ["a file", "a share", "a script", "pricing"]) {
			expect(documentXml).toContain(text);
		}
	});

	it("carries no citation marker and no Source Index section", async () => {
		const { pkg } = await build(
			input(
				[
					"## Results",
					"",
					"Onboarding time fell by a third [S1] across sites [S2].",
					"",
					"## Source Index",
					"",
					"- [S1] Example pilot report",
					"- [S2] Example survey",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).toContain("Onboarding time fell by a third");
		expect(documentXml).not.toMatch(/\[S\d+\]/);
		expect(documentXml).not.toContain("Source Index");
		expect(documentXml).not.toContain("Example pilot report");
	});

	it("writes a contents TOC field over the section headings and asks Word to update fields", async () => {
		const { pkg } = await build(
			input("## Approach\n\nText.\n\n## Pricing\n\nMore text."),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).toMatch(/<w:instrText[^>]*>TOC [^<]*\\o[^<]*2-2/);
		expect(documentXml).toMatch(/<w:instrText[^>]*>TOC [^<]*\\h/);
		// Until Word updates the field, its cached result lists both sections.
		const contents =
			/<w:sdt>[\s\S]*?<\/w:sdt>/.exec(documentXml)?.[0] ?? "";
		expect(contents).toContain(">Approach<");
		expect(contents).toContain(">Pricing<");
		expect(contents).not.toContain("Contents<");

		const settings = await pkg.read("word/settings.xml");
		expect(settings).toMatch(/<w:updateFields(?: w:val="(?:true|1)")?\/>/);
	});

	it("runs the title in the header and the page count in the footer, but not on the cover", async () => {
		const { pkg } = await build(input("## Approach\n\nText."));
		const documentXml = await pkg.read("word/document.xml");
		const [cover, ...rest] = sections(documentXml);
		expect(cover).toBeDefined();
		expect(cover).not.toMatch(/headerReference|footerReference/);
		expect(rest.length).toBeGreaterThan(0);
		for (const section of rest) {
			expect(section).toMatch(/<w:headerReference\b/);
			expect(section).toMatch(/<w:footerReference\b/);
		}

		const headers = pkg.files.filter((file) =>
			/^word\/header\d*\.xml$/.test(file),
		);
		const footers = pkg.files.filter((file) =>
			/^word\/footer\d*\.xml$/.test(file),
		);
		expect(headers.length).toBeGreaterThan(0);
		for (const header of headers) {
			expect(await pkg.read(header)).toContain("Example Proposal");
		}
		for (const footer of footers) {
			const xml = await pkg.read(footer);
			expect(xml).toContain(
				"Example Org · Example Proposal · October 15, 2026 · Confidential",
			);
			expect(xml).toMatch(/<w:instrText[^>]*>PAGE<\/w:instrText>/);
			expect(xml).toMatch(/<w:instrText[^>]*>NUMPAGES<\/w:instrText>/);
		}
	});

	it("leaves an unknown proposer out of the footer and the cover without a stray separator", async () => {
		const { pkg } = await build(
			input("Text.", {
				tokens: tokens({ proposerName: null, recipientName: null }),
			}),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).not.toContain("Prepared for");
		expect(documentXml).not.toContain("Prepared by");
		expect(documentXml).toContain('<w:pStyle w:val="Title"/>');
		const footers = pkg.files.filter((file) =>
			/^word\/footer\d*\.xml$/.test(file),
		);
		for (const footer of footers) {
			const xml = await pkg.read(footer);
			expect(xml).toContain(
				"Example Proposal · October 15, 2026 · Confidential",
			);
			expect(xml).not.toMatch(/>\s*·/);
		}
	});

	it("puts both logos and the hero on the cover", async () => {
		const { pkg } = await build(
			input("Text.", {
				tokens: tokens({
					proposerLogo: await raster("png", 600, 200),
					recipientLogo: await raster("jpeg", 300, 300),
					hero: await raster("jpeg", 1200, 600),
				}),
			}),
		);
		const media = pkg.files.filter(isMedia);
		expect(media).toHaveLength(3);
		const documentXml = await pkg.read("word/document.xml");
		const cover = documentXml.slice(0, documentXml.indexOf("<w:sectPr"));
		expect(cover).toContain("Prepared for");
		expect(cover).toContain("Example Client");
		expect(cover.match(/<pic:pic\b/g)).toHaveLength(3);
		// Every drawing carries an id of its own.
		const ids = Array.from(
			documentXml.matchAll(/<wp:docPr id="(\d+)"/g),
			(match) => match[1],
		);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		// A 600 x 200 logo fits the 2.75in x 0.75in box: 216 x 72 px.
		expect(cover).toContain(`cx="${216 * 9525}" cy="${72 * 9525}"`);
	});

	it("renders valid stat tiles as a table and a refused block as code", async () => {
		const { pkg } = await build(
			input(
				[
					"```stat-tiles",
					"Faster onboarding: 40%",
					"Pilot sites: 3",
					"```",
					"",
					"```stat-tiles",
					"One: 1",
					"Two: 2",
					"Three: 3",
					"Four: 4",
					"Five: 5",
					"```",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const found = tables(documentXml);
		expect(found).toHaveLength(1);
		expect(found[0]).toContain("40%");
		expect(found[0]).toContain("Pilot sites");
		expect(found[0]).toContain("Faster onboarding");
		// The refused block keeps its lines, in the code font, outside any table.
		expect(documentXml).toContain("Five: 5");
		expect(found[0]).not.toContain("Five: 5");
		expect(documentXml).toContain('w:ascii="Consolas"');
	});

	it("sets a stat tile's value and label at print's sizes, the label in muted body text at regular weight in its own case", async () => {
		const base = tokens();
		const bodyFont = "Example Body";
		const cases: [ExportThemeTokens, string][] = [
			[neutralTokens(), "Inter"],
			[
				{
					...base,
					proposer: {
						...base.proposer,
						fonts: {
							...base.proposer.fonts,
							body: sourced(bodyFont),
						},
					},
				},
				bodyFont,
			],
		];
		for (const [source, body] of cases) {
			const { pkg } = await build(
				input("```stat-tiles\nPilot sites: 3\n```", { tokens: source }),
			);
			const table = tables(await pkg.read("word/document.xml"))[0] ?? "";
			const muted = resolveThemePaint(source)
				.muted.replace("#", "")
				.toUpperCase();

			const label = runWith(table, "Pilot sites");
			expect(label).toContain(`w:ascii="${body}"`);
			expect(label).toContain(`<w:color w:val="${muted}"/>`);
			expect(label).toContain('<w:sz w:val="16"/>');
			for (const absent of ["<w:b/>", "<w:caps/>", "<w:spacing "]) {
				expect(label).not.toContain(absent);
			}
			const value = runWith(table, "3");
			expect(value).toContain('<w:sz w:val="34"/>');
			expect(value).toContain("<w:b/>");
		}
	});

	it("writes cards as bordered cells two to a row, each with a mono label in the label colour, a title and text", async () => {
		const base = tokens();
		const branded: ExportThemeTokens = {
			...base,
			proposer: {
				...base.proposer,
				fonts: { ...base.proposer.fonts, mono: sourced(MONO_FONT) },
			},
		};
		const muted = resolveThemePaint(branded)
			.muted.replace("#", "")
			.toUpperCase();
		const { pkg } = await build(
			input(
				[
					"```cards",
					"01",
					"**Route planning**",
					"Plans each *stop* before `08:00`.",
					"",
					"Pilot",
					"**Example Harbor Co**",
					"",
					"Scope",
					"Risk: <script>alert(1)</script>",
					"",
					"Fee",
					"**Fixed**",
					"Paid in two parts.",
					"",
					"Term",
					"Twelve weeks.",
					"```",
				].join("\n"),
				{ tokens: branded },
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const found = tables(documentXml);
		expect(found).toHaveLength(1);
		const table = found[0] ?? "";

		// One bordered cell per card, two to a row; the fifth card's row
		// keeps an empty slot beside it.
		const cardRows = rowsOf(table)
			.map((row) => cellsOf(row).filter(isBordered).length)
			.filter((count) => count > 0);
		expect(cardRows).toEqual([2, 2, 1]);
		expect(table).toMatch(/<w:tblBorders>[\s\S]*?w:val="none"/);

		const label = runWith(table, "01");
		expect(label).toContain("<w:caps/>");
		expect(label).toContain(`w:color w:val="${LABEL}"`);
		expect(label).toContain(`w:ascii="${MONO_FONT}"`);

		const title = runWith(table, "Route planning");
		expect(title).toContain("<w:b/>");
		expect(title).toContain(`w:ascii="${DISPLAY_FONT}"`);
		expect(title).toContain(`w:color w:val="${INK}"`);

		const text = runWith(table, "Plans each ");
		expect(text).toContain(`w:color w:val="${muted}"`);
		expect(text).toContain('w:ascii="Inter"');
		expect(text).not.toContain(MONO_FONT);
		expect(runWith(table, "stop")).toContain("<w:i/>");
		expect(runWith(table, "08:00")).toContain('w:ascii="Consolas"');

		// Card text is text, never markup.
		expect(table).toContain("Risk: &lt;script&gt;alert(1)&lt;/script&gt;");
		expect(documentXml).not.toContain("<script>");
	});

	it("sets exactly three cards in one row", async () => {
		const { pkg } = await build(
			input(
				[
					"```cards",
					"A",
					"One.",
					"",
					"B",
					"Two.",
					"",
					"C",
					"Three.",
					"```",
				].join("\n"),
			),
		);
		const found = tables(await pkg.read("word/document.xml"));
		expect(found).toHaveLength(1);
		expect(
			rowsOf(found[0] ?? "").map(
				(row) => cellsOf(row).filter(isBordered).length,
			),
		).toEqual([3]);
	});

	it("writes columns as a borderless two-cell table of headings, bullets and paragraphs, outside the contents", async () => {
		const { pkg } = await build(
			input(
				[
					"## Approach",
					"",
					"```columns",
					"### Today",
					"- Paper route sheets",
					"- Calls to *every* depot",
					"---",
					"#### With the platform",
					"One schedule **every** depot reads.",
					"```",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const found = tables(documentXml);
		expect(found).toHaveLength(1);
		const table = found[0] ?? "";

		const rows = rowsOf(table);
		expect(rows).toHaveLength(1);
		const [left, right] = cellsOf(rows[0] ?? "");
		expect(cellsOf(rows[0] ?? "")).toHaveLength(2);
		expect(table).not.toMatch(/w:val="single"/);

		// A column heading is bold display text, never a Word heading.
		const heading = runWith(left ?? "", "Today");
		expect(heading).toContain("<w:b/>");
		expect(heading).toContain(`w:ascii="${DISPLAY_FONT}"`);
		expect(heading).toContain(`w:color w:val="${INK}"`);
		expect(table).not.toContain('w:pStyle w:val="Heading');

		// Each bullet is a list paragraph; the paragraph after the heading is not.
		expect(left?.match(/<w:numPr>/g)).toHaveLength(2);
		expect(left).toContain("Paper route sheets");
		expect(right).toContain("With the platform");
		expect(right).toContain("One schedule ");
		expect(right).not.toContain("<w:numPr>");
		expect(runWith(right ?? "", "every")).toContain("<w:b/>");

		// The contents lists the section, not the column headings.
		expect(documentXml).toContain("Approach");
		const contentsEntries = Array.from(
			documentXml.matchAll(/<w:pStyle w:val="TOC2"\/>[\s\S]*?<\/w:p>/g),
			(match) => match[0],
		).join("");
		expect(contentsEntries).toContain("Approach");
		expect(contentsEntries).not.toContain("Today");
	});

	it("writes cards, columns and stat tiles without the citation markers written into them", async () => {
		const { pkg } = await build(
			input(
				[
					"## Results",
					"",
					"```cards",
					"01",
					"**Route planning**",
					"Saves 12 hours a week [S2]",
					"",
					"Pilot",
					"[S4]",
					"Twelve weeks.",
					"```",
					"",
					"```columns",
					"### Today",
					"- Paper route sheets [cite]",
					"---",
					"One schedule.",
					"```",
					"",
					"```stat-tiles",
					"Hours saved [S1]: 12",
					"Pilot sites: 3 [S3]",
					"```",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const [cards, columns, tiles, ...rest] = tables(documentXml);
		expect(rest).toEqual([]);

		// Two cards, each whole: a line of markers alone splits nothing.
		expect(
			rowsOf(cards ?? "").map(
				(row) => cellsOf(row).filter(isBordered).length,
			),
		).toEqual([2]);
		expect(cards).toContain(">Saves 12 hours a week<");
		expect(cards).toContain(">Twelve weeks.<");
		expect(columns).toContain(">Paper route sheets<");
		expect(tiles).toContain(">Hours saved<");
		expect(tiles).toContain(">12<");
		expect(tiles).toContain(">Pilot sites<");
		expect(tiles).toContain(">3<");
		expect(documentXml).not.toMatch(/\[(?:S\d|cite)/);
	});

	it.each([
		["cards", ["**A bold first line**", "Text."]],
		["columns", ["### Only one side", "- No separator"]],
	])(
		"writes a refused %s block as shaded code, outside any table",
		async (language, lines) => {
			const { pkg } = await build(
				input([`\`\`\`${language}`, ...lines, "```"].join("\n")),
			);
			const documentXml = await pkg.read("word/document.xml");

			expect(tables(documentXml)).toHaveLength(0);
			const box = Array.from(
				documentXml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g),
				(match) => match[0],
			).find((paragraph) => paragraph.includes(lines[0] ?? ""));
			// One shaded, boxed paragraph that keeps both lines in the code font.
			expect(box).toMatch(/<w:shd w:fill="[0-9A-F]{6}"/);
			expect(box).toContain("<w:pBdr>");
			expect(box).toContain(lines[1] ?? "");
			expect(runWith(box ?? "", lines[0] ?? "")).toContain(
				'w:ascii="Consolas"',
			);
		},
	);

	it("embeds a rendered diagram and prints a placeholder's caption", async () => {
		const png = await raster("png", 800, 400);
		const diagrams: ExportDiagram[] = [
			{
				kind: "svg",
				svg: "<svg/>",
				width: 400,
				height: 200,
				png,
				numbered: true,
			},
			{
				kind: "placeholder",
				caption: "Diagram could not be rendered.",
				numbered: true,
			},
			{
				kind: "svg",
				svg: "<svg/>",
				width: 400,
				height: 200,
				png: null,
				numbered: true,
			},
		];
		const fence = (label: string) =>
			["```mermaid", "flowchart LR", `  A[${label}] --> B`, "```"].join(
				"\n",
			);
		const { pkg } = await build(
			input([fence("one"), fence("two"), fence("three")].join("\n\n"), {
				diagrams,
			}),
		);
		const media = pkg.files.filter(isMedia);
		expect(media).toHaveLength(1);
		expect(media[0]).toMatch(/\.png$/);
		const documentXml = await pkg.read("word/document.xml");
		// Shown at the SVG's own size: 400 x 200 px.
		expect(documentXml).toContain(`cx="${400 * 9525}" cy="${200 * 9525}"`);
		expect(documentXml).toContain("Diagram could not be rendered.");
		expect(documentXml).toContain(
			"This diagram is available in the online version of this document.",
		);
		// A drawn diagram without its picture keeps its number, as in print.
		expect(documentXml).toContain("Figure 3.");
		expect(documentXml).not.toContain("flowchart");
	});

	it("prints a diagram's caption line under its picture and under a placeholder", async () => {
		const png = await raster("png", 800, 400);
		const fence = (caption: string) =>
			[
				"```mermaid",
				`%% caption: ${caption}`,
				"flowchart LR",
				"  A --> B",
				"```",
			].join("\n");
		const { pkg } = await build(
			input(
				[fence("Delivery plan & <scope>"), fence("Launch plan")].join(
					"\n\n",
				),
				{
					diagrams: [
						{
							kind: "svg",
							svg: "<svg/>",
							width: 400,
							height: 200,
							png,
							numbered: true,
						},
						{
							kind: "placeholder",
							caption: "Not available.",
							numbered: true,
						},
					],
				},
			),
		);
		const documentXml = await pkg.read("word/document.xml");

		expect(documentXml).toContain("Delivery plan &amp; &lt;scope&gt;");
		expect(documentXml).toContain(
			'descr="Delivery plan &amp; &lt;scope&gt;"',
		);
		expect(documentXml.indexOf("Not available.")).toBeLessThan(
			documentXml.indexOf("Launch plan"),
		);
		expect(documentXml).not.toContain("%% caption");
	});

	it("numbers the figures that print in document order and leaves a broken one out", async () => {
		const png = await raster("png", 800, 400);
		const drawn: ExportDiagram = {
			kind: "svg",
			svg: "<svg/>",
			width: 400,
			height: 200,
			png,
			numbered: true,
		};
		const fence = (caption: string | null, label: string) =>
			[
				"```mermaid",
				...(caption ? [`%% caption: ${caption}`] : []),
				"flowchart LR",
				`  A[${label}] --> B`,
				"```",
			].join("\n");
		const { pkg } = await build(
			input(
				[
					fence("Delivery plan", "one"),
					fence("Broken plan", "two"),
					fence(null, "three"),
					fence("Release calendar", "four"),
				].join("\n\n"),
				{
					diagrams: [
						drawn,
						{ kind: "omitted", numbered: false },
						drawn,
						{
							kind: "placeholder",
							caption: "Not available.",
							numbered: true,
						},
					],
				},
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const text = Array.from(
			documentXml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g),
			(match) => match[1],
		).join("|");

		expect(text).toContain("Figure 1.| Delivery plan");
		// The uncaptioned figure still reads "Figure n.", numbered after the
		// broken one is left out.
		expect(text).toContain("|Figure 2.|");
		expect(text).toContain("Not available.|Figure 3.| Release calendar");
		expect(documentXml).not.toContain("Broken plan");
		expect(documentXml).not.toContain("Figure 4.");
		expect(documentXml.indexOf("Figure 1.")).toBeLessThan(
			documentXml.indexOf("Figure 2."),
		);
	});

	it("never fetches a Markdown image and reports the ones it left out", async () => {
		const { pkg, warnings } = await build(
			input(
				[
					"![Chart](https://example.com/chart.png)",
					"",
					"Inline ![logo][logo] image.",
					"",
					"[logo]: https://example.com/logo.png",
				].join("\n"),
			),
		);
		expect(warnings).toEqual([
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 2 },
		]);
		const rels = await pkg.read("word/_rels/document.xml.rels");
		expect(rels).not.toContain("example.com");
		expect(pkg.files.some(isMedia)).toBe(false);
	});

	it("prints raw HTML as its literal text and a <br> as a line break", async () => {
		const { pkg, warnings } = await build(
			input(
				[
					'<div onclick="alert(1)">Hello</div>',
					"",
					"First line<br>second line.",
				].join("\n"),
			),
		);
		expect(warnings).toEqual([]);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).toContain(
			"&lt;div onclick=&quot;alert(1)&quot;&gt;Hello&lt;/div&gt;",
		);
		expect(documentXml).toMatch(/First line<\/w:t><\/w:r><w:r><w:br\/>/);
	});

	it("drops characters XML cannot hold rather than writing a file Word refuses", async () => {
		const { pkg } = await build(
			input("Before\u0001after \uD800 and a pair 😀.", {
				title: "Example\u0007 Proposal",
			}),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).toContain("Beforeafter");
		expect(documentXml).toContain("😀");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
		expect(documentXml).not.toMatch(/[\u0001\u0007]/);
		expect(documentXml).not.toMatch(/\uD800(?![\uDC00-\uDFFF])/);
	});

	it("marks task items with ballot boxes and renders callouts, code and rules", async () => {
		const { pkg } = await build(
			input(
				[
					"- [ ] Open item",
					"- [x] Done item",
					"",
					"> **Note:** pricing holds for 90 days.",
					"",
					"```",
					"line one",
					"  indented line",
					"```",
					"",
					"---",
					"",
					"Text with `inline code` and ~~struck~~ words.",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		expect(documentXml).toContain("☐");
		expect(documentXml).toContain("☑");
		// The callout: tinted, under a primary rule on its left.
		expect(documentXml).toMatch(
			/<w:left w:val="single" w:color="1D4ED8" w:sz="24"/,
		);
		expect(documentXml).toContain("pricing holds for 90 days.");
		expect(documentXml).toContain(
			'<w:t xml:space="preserve">  indented line</w:t>',
		);
		expect(documentXml).toContain("<w:strike/>");
	});

	it("names its colours from the paint", () => {
		const paint = resolveThemePaint(tokens());
		const hex = (color: string) => color.replace("#", "").toUpperCase();
		expect(hex(paint.heading)).toBe(BRAND);
		expect(hex(paint.ink)).toBe(INK);
		expect(hex(paint.label)).toBe(LABEL);
	});

	it("leaves out a header row whose cells are all empty, with no repeating header and its first row plain", async () => {
		const tint = resolveThemePaint(tokens())
			.tint.replace("#", "")
			.toUpperCase();
		const { pkg } = await build(
			input(
				[
					"|  |  |",
					"| --- | --- |",
					"| Scope | Pilot |",
					"| Fee | $9 |",
					"| Term | 12 weeks |",
					"",
					"| Phase |  |",
					"| --- | --- |",
					"| Build | $9 |",
					"",
					"|  |  |",
					"| --- | --- |",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		// The blank header over nothing writes no table at all.
		const [headerless, headed, ...rest] = tables(documentXml);
		expect(rest).toEqual([]);

		const rows = headerless?.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? [];
		expect(rows).toHaveLength(3);
		expect(headerless).not.toContain("<w:tblHeader/>");
		expect(rows[0]).toContain(">Scope<");
		// Plain, tinted, plain: counted over the rows it writes.
		expect(rows.map((row) => row.includes(`w:fill="${tint}"`))).toEqual([
			false,
			true,
			false,
		]);
		// Nothing is filled as a header.
		expect(headerless).not.toContain(`w:fill="${BRAND}"`);

		// One header cell with text keeps the header row.
		expect(headed).toContain("<w:tblHeader/>");
		expect(headed).toContain(">Phase<");

		// A wide blank header over nothing takes no landscape page, and
		// leaves its section heading in the portrait flow.
		const wide = await build(
			input(
				`## Rates\n\n|${"  |".repeat(7)}\n|${" --- |".repeat(7)}\n\nAfter.`,
			),
		);
		const wideXml = await wide.pkg.read("word/document.xml");
		expect(tables(wideXml)).toEqual([]);
		expect(
			sections(wideXml).map((section) => pageSize(section).orient),
		).toEqual(["portrait", "portrait", "portrait"]);
	});

	it("keeps the header row over a Markdown image, which writes nothing, and over a footnote call", async () => {
		const image = await build(
			input(
				"| ![Logo](https://example.com/logo.png) |  |\n| --- | --- |\n| Fee | $9 |",
			),
		);
		const [imageTable] = tables(await image.pkg.read("word/document.xml"));
		expect(imageTable).toContain("<w:tblHeader/>");
		expect(rowsOf(imageTable ?? "")).toHaveLength(2);
		expect(image.warnings).toEqual([
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 1 },
		]);

		const note = await build(
			input(
				"| [^1] |  |\n| --- | --- |\n| Fee | $9 |\n\n[^1]: Example note.",
			),
		);
		const [noteTable] = tables(await note.pkg.read("word/document.xml"));
		expect(noteTable).toContain("<w:tblHeader/>");
		expect(rowsOf(noteTable ?? "")).toHaveLength(2);
	});

	it("puts Main's leading H1 on the cover, in the header, the footer and the properties, and not in the body", async () => {
		const { pkg } = await build(
			input("# Generated Title\n\n## Approach\n\nText.", {
				title: "Renamed Record",
			}),
		);
		const documentXml = await pkg.read("word/document.xml");
		const cover = documentXml.slice(0, documentXml.indexOf("<w:sectPr"));
		expect(cover).toMatch(
			/<w:pStyle w:val="Title"\/>[\s\S]*?>Generated Title<\/w:t>/,
		);
		expect(documentXml).not.toContain('<w:pStyle w:val="Heading1"/>');
		expect(documentXml.match(/>Generated Title</g)).toHaveLength(1);

		const parts = async (pattern: RegExp) =>
			Promise.all(
				pkg.files
					.filter((file) => pattern.test(file))
					.map((file) => pkg.read(file)),
			);
		const headers = await parts(/^word\/header\d*\.xml$/);
		const footers = await parts(/^word\/footer\d*\.xml$/);
		expect(headers.length).toBeGreaterThan(0);
		for (const header of headers) {
			expect(header).toContain(">Generated Title<");
		}
		for (const footer of footers) {
			expect(footer).toContain(
				"Example Org · Generated Title · October 15, 2026 · Confidential",
			);
		}
		const core = await pkg.read("docProps/core.xml");
		expect(core).toContain("<dc:title>Generated Title</dc:title>");
		// The record's name is the download's, never the document's.
		for (const part of [documentXml, core, ...headers, ...footers]) {
			expect(part).not.toContain("Renamed Record");
		}
	});

	it("keeps an H1 in the body, under the record's title, when Main has no sections", async () => {
		const { pkg } = await build(input("# Generated Title\n\nText."));
		const documentXml = await pkg.read("word/document.xml");
		const cover = documentXml.slice(0, documentXml.indexOf("<w:sectPr"));
		expect(cover).toMatch(
			/<w:pStyle w:val="Title"\/>[\s\S]*?>Example Proposal<\/w:t>/,
		);
		expect(documentXml).toMatch(
			/<w:pStyle w:val="Heading1"\/>[\s\S]*?>Generated Title<\/w:t>/,
		);
	});
});

/** The `<w:p>` holding `text`, properties included. */
function paragraphWith(xml: string, text: string): string {
	const paragraph = Array.from(
		xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g),
		(match) => match[0],
	).find((candidate) => candidate.includes(`>${text}<`));
	expect(paragraph, `a paragraph holding "${text}"`).toBeDefined();
	return paragraph ?? "";
}

/** The body XML of each section, in document order. */
function sectionBodies(documentXml: string): string[] {
	return documentXml.split(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
}

const COVER_FENCE = [
	"```cover",
	"eyebrow: Proposal · Operations board",
	"organization: Example Harbor Co · Harbour operations",
	"for: Example Harbor Co",
	"for: 1 Example Quay, Example City",
	"by: Example Studio",
	"by: example.com",
	"version: 12",
	"```",
].join("\n");

describe("buildProposalDocx: cover details", () => {
	it("sets the eyebrow, the organization line, the party lines and the version from a cover fence, and leaves the fence out of the body", async () => {
		const { pkg } = await build(
			input(`${COVER_FENCE}\n\n## Approach\n\nText.`),
		);
		const documentXml = await pkg.read("word/document.xml");
		const [cover = "", ...rest] = sectionBodies(documentXml);

		expect(cover).toContain(">Proposal · Operations board<");
		expect(cover).not.toContain(">Proposal<");
		const organization = paragraphWith(
			cover,
			"Example Harbor Co · Harbour operations",
		);
		expect(organization).toMatch(/<w:jc w:val="(?:right|end)"\/>/);
		expect(organization).toContain("<w:caps/>");
		// Each party's first line in the name's style, the rest under it.
		const parties = cover.slice(cover.indexOf("Prepared for"));
		expect(runWith(parties, "Example Harbor Co")).toContain("<w:b/>");
		expect(runWith(parties, "1 Example Quay")).not.toContain("<w:b/>");
		expect(runWith(parties, "Example Studio")).toContain("<w:b/>");
		expect(cover).toContain(">example.com<");
		expect(cover).not.toContain("Example Client");
		expect(cover).toContain(">October 15, 2026 · Version 12<");
		// Prepared for, then Prepared by, as before.
		expect(cover.indexOf("Prepared for")).toBeLessThan(
			cover.indexOf("Prepared by"),
		);

		const body = rest.join("");
		expect(body).not.toContain("eyebrow:");
		expect(body).not.toContain("Harbour operations");
		expect(body).not.toContain("1 Example Quay");
	});

	it("keeps the default of each field the fence leaves out", async () => {
		const { pkg } = await build(
			input("```cover\nversion: v3\n```\n\n## Approach"),
		);
		const [cover = ""] = sectionBodies(await pkg.read("word/document.xml"));

		expect(cover).toContain(">Proposal<");
		expect(cover).toContain(">Example Client<");
		expect(cover).toContain(">Example Org<");
		expect(cover).toContain(">October 15, 2026 · v3<");
	});

	it("prints the version alone when there is no date", async () => {
		const { pkg } = await build(
			input("```cover\nversion: 2.1\n```\n\n## Approach", {
				dateLabel: " ",
			}),
		);
		const [cover = ""] = sectionBodies(await pkg.read("word/document.xml"));

		expect(cover).toContain(">Version 2.1<");
	});

	it("writes a refused cover fence as code in the body and keeps the cover's defaults", async () => {
		const { pkg } = await build(
			input("```cover\neyebrow: Board\ncolour: red\n```\n\n## Approach"),
		);
		const documentXml = await pkg.read("word/document.xml");
		const [cover = "", ...rest] = sectionBodies(documentXml);

		expect(cover).toContain(">Proposal<");
		expect(cover).not.toContain("Board");
		expect(rest.join("")).toContain(">colour: red<");
	});

	it("leaves out every other cover fence the parser takes, and writes a refused one as code", async () => {
		const { pkg } = await build(
			input(
				[
					"```cover",
					"eyebrow: First",
					"```",
					"",
					"```cover",
					"eyebrow: Second",
					"```",
					"",
					"## Approach",
					"",
					"```cover",
					"eyebrow: Third",
					"```",
					"",
					"- In a list:",
					"",
					"  ```cover",
					"  eyebrow: Fourth",
					"  ```",
					"",
					"```cover",
					"colour: red",
					"```",
				].join("\n"),
			),
		);
		const documentXml = await pkg.read("word/document.xml");
		const [cover = "", ...rest] = sectionBodies(documentXml);
		const body = rest.join("");

		expect(cover).toContain(">First<");
		expect(body).not.toContain("eyebrow:");
		expect(body).toContain(">In a list:<");
		expect(body).toContain(">colour: red<");
	});

	it("drops characters XML cannot hold from the fence's values", async () => {
		const { pkg } = await build(
			input(
				"```cover\neyebrow: Board\u0001 <b>& co</b>\n```\n\n## Approach",
			),
		);
		const [cover = ""] = sectionBodies(await pkg.read("word/document.xml"));

		expect(cover).toContain(">Board &lt;b&gt;&amp; co&lt;/b&gt;<");
	});
});

const LETTER_MAIN = [
	"# Route planning for Example Harbor Co",
	"",
	"## Cover letter",
	"",
	"12 March 2027",
	"",
	"Jordan Example, Head of Operations, Example Harbor Co",
	"",
	"Re: Route planning for Example Harbor Co",
	"",
	"Thank you for the conversation.",
	"",
	"Kind regards,",
	"",
	"**Alex Example**",
	"",
	"Head of Delivery · Example Studio",
	"",
	"## 1. Overview",
	"",
	"Text.",
	"",
	"## 2. Pricing",
	"",
	"More text.",
].join("\n");

describe("buildProposalDocx: cover letter", () => {
	it("writes the letter in its own section after the cover and before the contents, under the running header and footer", async () => {
		const { pkg } = await build(
			input(LETTER_MAIN, {
				tokens: tokens({ proposerLogo: await raster("png", 600, 200) }),
			}),
		);
		const documentXml = await pkg.read("word/document.xml");
		const [coverProperties, letterProperties] = sections(documentXml);
		const [cover = "", letter = "", contents = "", ...body] =
			sectionBodies(documentXml);

		expect(coverProperties).not.toMatch(/headerReference|footerReference/);
		expect(letterProperties).toMatch(/<w:headerReference\b/);
		expect(letterProperties).toMatch(/<w:footerReference\b/);
		expect(cover).toContain('<w:pStyle w:val="Title"/>');
		expect(letter).toContain(">Cover letter<");
		expect(letter).toContain(">Kind regards,<");
		// The proposer logo heads the letter.
		expect(letter.match(/<pic:pic\b/g)).toHaveLength(1);
		expect(contents).toContain(">Contents<");
		expect(contents).not.toContain("Kind regards");
		const rest = body.join("");
		expect(rest).not.toContain("Kind regards");
		expect(rest).not.toContain("Cover letter");
		expect(rest).toContain(">1. Overview<");
	});

	it("sets the letter's heading as a label, never a Heading 2, so the contents never list it", async () => {
		const { pkg } = await build(input(LETTER_MAIN));
		const documentXml = await pkg.read("word/document.xml");
		const [, letter = ""] = sectionBodies(documentXml);

		const heading = paragraphWith(letter, "Cover letter");
		expect(heading).not.toContain("<w:pStyle");
		expect(heading).not.toContain("<w:outlineLvl");
		expect(runWith(heading, "Cover letter")).toContain("<w:caps/>");
		expect(
			documentXml.match(/<w:pStyle w:val="Heading2"\/>/g),
		).toHaveLength(2);
		for (const paragraph of documentXml.match(
			/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g,
		) ?? []) {
			if (paragraph.includes('<w:pStyle w:val="Heading2"/>')) {
				expect(paragraph).not.toContain("Cover letter");
			}
		}
		// The TOC field's cached entries list the sections only.
		const contents =
			/<w:sdt>[\s\S]*?<\/w:sdt>/.exec(documentXml)?.[0] ?? "";
		expect(contents).toContain(">1. Overview<");
		expect(contents).toContain(">2. Pricing<");
		expect(contents).not.toContain("Cover letter");
	});

	it("sets the date, the subject line and the signer's line in their roles", async () => {
		const base = tokens();
		const branded: ExportThemeTokens = {
			...base,
			proposer: {
				...base.proposer,
				fonts: { ...base.proposer.fonts, mono: sourced(MONO_FONT) },
			},
		};
		const { pkg } = await build(input(LETTER_MAIN, { tokens: branded }));
		const [, letter = ""] = sectionBodies(
			await pkg.read("word/document.xml"),
		);
		const muted = resolveThemePaint(branded)
			.muted.replace("#", "")
			.toUpperCase();

		const date = runWith(letter, "12 March 2027");
		expect(date).toContain("<w:caps/>");
		expect(date).toContain(`<w:color w:val="${LABEL}"/>`);
		expect(date).toContain(`w:ascii="${MONO_FONT}"`);
		expect(runWith(letter, "Cover letter")).toContain(
			`w:ascii="${MONO_FONT}"`,
		);
		expect(runWith(letter, "Thank you")).not.toContain(MONO_FONT);
		expect(runWith(letter, "Re: Route planning")).toContain("<w:b/>");
		expect(runWith(letter, "Alex Example")).toContain("<w:b/>");
		expect(runWith(letter, "Head of Delivery")).toContain(
			`<w:color w:val="${muted}"/>`,
		);
		expect(runWith(letter, "Thank you")).toContain(
			`<w:color w:val="${INK}"/>`,
		);
		expect(runWith(letter, "Thank you")).not.toContain("<w:b/>");
	});

	it("keeps a section of that name after the first as an ordinary section", async () => {
		const { pkg } = await build(
			input("## Approach\n\nText.\n\n## Cover letter\n\nDear reader."),
		);
		const documentXml = await pkg.read("word/document.xml");
		const [, contents = "", ...body] = sectionBodies(documentXml);

		expect(sections(documentXml)).toHaveLength(3);
		expect(paragraphWith(body.join(""), "Cover letter")).toContain(
			'<w:pStyle w:val="Heading2"/>',
		);
		expect(contents).toContain(">Cover letter<");
	});

	it("writes no letter section without a letter", async () => {
		const { pkg } = await build(input("## Approach\n\nText."));
		const documentXml = await pkg.read("word/document.xml");

		// The cover, the contents and the body.
		expect(sections(documentXml)).toHaveLength(3);
	});
});

/**
 * Every mono run the Word file sets: at print's 500 the cover eyebrow, the
 * party labels, the letter's heading and date, a table's header cells and a
 * card's label; at print's 400 the cover's line about the client.
 */
const MONO_MAIN = [
	COVER_FENCE,
	"",
	LETTER_MAIN,
	"",
	"| Phase | Weeks |\n|---|---|\n| Discovery | 2 |",
	"",
	"```cards",
	"Scope",
	"**Route planning**",
	"```",
].join("\n");

describe("buildProposalDocx: mono weights", () => {
	/** The runs print sets at 500, then those it sets at 400. */
	async function monoRuns(source: BuildDocxInput) {
		const { pkg } = await build(source);
		const documentXml = await pkg.read("word/document.xml");
		const [cover = "", letter = ""] = sectionBodies(documentXml);
		return {
			medium: [
				runWith(cover, "Proposal · Operations board"),
				runWith(cover, "Prepared for"),
				runWith(cover, "Prepared by"),
				runWith(letter, "Cover letter"),
				runWith(letter, "12 March 2027"),
				runWith(documentXml, "Phase"),
				runWith(documentXml, "Scope"),
			],
			regular: [runWith(cover, "Example Harbor Co · Harbour operations")],
		};
	}

	it("sets the mono text print sets at 500 in JetBrains Mono's Medium face and at 400 in its regular face, none of it bold", async () => {
		const { medium, regular } = await monoRuns(
			input(MONO_MAIN, { tokens: neutralTokens() }),
		);

		for (const run of medium) {
			expect(run).toContain('w:ascii="JetBrains Mono Medium"');
			expect(run).not.toContain("<w:b/>");
		}
		for (const run of regular) {
			expect(run).toContain('w:ascii="JetBrains Mono"');
			expect(run).not.toContain("<w:b/>");
		}
	});

	it("sets a brand's mono text at 500 bold in the brand's family, and at 400 not bold", async () => {
		const base = tokens();
		const { medium, regular } = await monoRuns(
			input(MONO_MAIN, {
				tokens: {
					...base,
					proposer: {
						...base.proposer,
						fonts: {
							...base.proposer.fonts,
							mono: sourced(MONO_FONT),
						},
					},
				},
			}),
		);

		for (const run of medium) {
			expect(run).toContain(`w:ascii="${MONO_FONT}"`);
			expect(run).toContain("<w:b/>");
		}
		for (const run of regular) {
			expect(run).toContain(`w:ascii="${MONO_FONT}"`);
			expect(run).not.toContain("<w:b/>");
		}
	});
});
