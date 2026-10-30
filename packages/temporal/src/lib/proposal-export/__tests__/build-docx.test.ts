/**
 * The Proposal export's Word writer (Fizzy #2946), read back the way Word
 * reads it: each test builds a real DOCX, opens the package and asserts on
 * its parts.
 */

import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
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

	it("writes the neutral style's fonts as Arial, which every Word has, and none of the print faces", async () => {
		const neutral = buildProposalThemeTokens({
			organization: null,
			style: null,
			brandKit: null,
			recipient: null,
		}) as unknown as ExportThemeTokens;
		const { pkg } = await build(
			input("# Overview\n\n## Approach\n\nText.", { tokens: neutral }),
		);
		const styles = await pkg.read("word/styles.xml");
		const documentXml = await pkg.read("word/document.xml");
		expect(styles).toContain('w:ascii="Arial"');
		for (const face of ["Inter", "Poppins", "JetBrains Mono"]) {
			expect(`${styles}${documentXml}`).not.toContain(`"${face}"`);
		}
	});

	it("styles headings in the display font and the heading colour, never Word's blue", async () => {
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
		expect(heading1).toContain('<w:color w:val="1D4ED8"/>');
		for (const blue of ["2F5496", "4472C4", "2E74B5", "1F4D78", "0563C1"]) {
			expect(styles).not.toContain(blue);
		}
		const title =
			/<w:style\b[^>]*w:styleId="Title"[\s\S]*?<\/w:style>/.exec(
				styles,
			)?.[0];
		expect(title).toContain(`w:ascii="${DISPLAY_FONT}"`);
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
});
