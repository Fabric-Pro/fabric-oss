"use client";

/**
 * Browser-side renderers that turn a Markdown string into PDF or DOCX `Blob`s,
 * plus the small helpers shared with `DocumentDownloadDropdown.tsx`.
 *
 * Extracted from `DocumentDownloadDropdown.tsx` so it can be reused by the
 * per-row context-download submenu in `ProjectContextsList.tsx` (and any
 * future surface). All renderers use dynamic `import()` of `jspdf`, `docx`
 * and `mermaid` to keep them out of the initial bundle.
 *
 * Public exports (in import order):
 * - `triggerBlobDownload`     — anchor-click a `Blob` with a chosen filename
 * - `toSlug`                  — slugify free text for filenames
 * - `parseImgTag`             — read attributes off our serialized `<img/>` HTML
 * - `renderThemedMermaidSvg`  — mermaid code → SVG under the Glossy config
 * - `renderMermaidToPng`      — mermaid code → `{dataUrl, width, height}`
 * - `renderMarkdownToPdf`     — Markdown → PDF Blob (jsPDF, native text)
 * - `renderMarkdownToDocx`    — Markdown → DOCX Blob (docx + Packer)
 *
 * The image and text helpers these renderers share with the Glossy renderer
 * (`glossy/`) live in `document-export-helpers.ts`.
 *
 * Regular renders leave out visual slots (R38): a slot is a Glossy layout
 * marker, not document content.
 */

import { stripVisualSlots } from "@repo/utils/glossy/visual-slots";
import {
	normalizeOrderedMarkerEscape,
	stripInlineMarkdown,
	svgToPng,
	tryAddPdfImage,
	tryLoadImageBytes,
} from "./document-export-helpers";
import { withMermaidLock } from "./mermaid-lock";

export function toSlug(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "document"
	);
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/**
 * Matches an ordered-list line, tolerating a serializer-escaped period
 * (`38\\. GIVEN …`). The escape appears when a list item lost its list role
 * upstream; exports must still render it as a numbered item rather than
 * printing the backslash literally.
 */
export const ORDERED_ITEM_LINE_RE = /^\d+\\?\. /;

/** Regex matching a standalone markdown image line: ![alt](src) */
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
/** Regex matching an HTML <img> tag (as produced by our Turndown rule to preserve width + s3key) */
const IMG_TAG_LINE_RE = /^<img\s+[^>]*\/>\s*$/;

/** Parse attributes from an <img> tag string. */
export function parseImgTag(line: string): {
	src: string;
	alt: string;
	width: string;
	s3Key: string;
	caption: string;
} | null {
	if (!IMG_TAG_LINE_RE.test(line)) {
		return null;
	}
	const attr = (name: string) => {
		const m = line.match(new RegExp(`${name}="([^"]*)"`));
		return m?.[1] ?? "";
	};
	const src = attr("src");
	if (!src) {
		return null;
	}
	return {
		src,
		alt: attr("alt"),
		width: attr("width"),
		s3Key: attr("data-s3-key"),
		caption: attr("data-caption"),
	};
}

/** Convert a percentage width (25%, 50%, 100%) to a fraction of the content area. */
function widthFraction(width: string | undefined, maxWidth: number): number {
	if (!width) {
		return maxWidth;
	}
	const pctMatch = width.match(/^(\d+)%$/);
	if (pctMatch) {
		return maxWidth * (Number.parseInt(pctMatch[1], 10) / 100);
	}
	return maxWidth;
}

/** Brand theme for a Glossy render (KTD15). */
export interface MermaidExportTheme {
	/** Mermaid `themeVariables` for `theme: "base"`; only `#rrggbb` values are applied. */
	themeVariables: Readonly<Record<string, string>>;
	/** Font stack for labels. */
	fontFamily?: string;
}

const THEME_HEX = /^#[0-9a-f]{6}$/i;

/**
 * The per-diagram `%%{init}%%` directive carrying the brand theme. It is
 * appended, not prepended: front matter must stay first, and a later
 * directive wins over the diagram's own, so a document's restyled Mermaid
 * cannot switch the theme or HTML labels back. `theme: "base"` is repeated
 * here because mermaid only derives the dependent colors (node fills,
 * borders) when a directive names a theme.
 */
function mermaidThemeDirective(theme: MermaidExportTheme): string {
	const themeVariables = Object.fromEntries(
		Object.entries(theme.themeVariables).filter(([, value]) =>
			THEME_HEX.test(value),
		),
	);
	return `%%{init: ${JSON.stringify({
		theme: "base",
		htmlLabels: false,
		themeVariables,
	})}}%%`;
}

/**
 * Render Mermaid source to SVG under the Glossy configuration (KTD15):
 * mermaid.js only, `theme: "base"`, `securityLevel: "strict"`, plain SVG
 * text labels, and the brand theme as a per-diagram directive.
 *
 * Runs under `withMermaidLock`, as the regular export's and the editor's own
 * mermaid.js renders do, so neither can swap the configuration mid-render.
 * The shared configuration is captured first and restored afterwards, so
 * this never leaves it changed — in particular never loosened or tightened.
 * Throws when the source does not render.
 */
export async function renderThemedMermaidSvg(
	code: string,
	theme: MermaidExportTheme,
): Promise<string> {
	const mermaid = (await import("mermaid")).default;
	return withMermaidLock(async () => {
		const previous = mermaid.mermaidAPI.getSiteConfig();
		try {
			mermaid.initialize({
				startOnLoad: false,
				theme: "base",
				securityLevel: "strict",
				htmlLabels: false,
				suppressErrorRendering: true,
				fontFamily: theme.fontFamily ?? "Helvetica, sans-serif",
			});
			const id = `glossy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const { svg } = await mermaid.render(
				id,
				`${code.trim()}\n${mermaidThemeDirective(theme)}`,
			);
			return svg;
		} finally {
			mermaid.initialize(previous);
		}
	});
}

/**
 * Render a mermaid diagram to a PNG data URL.
 * Tries beautiful-mermaid first (flowchart, sequence, class, state, ER),
 * falls back to native mermaid.js for ALL other types (C4, mindmap, gantt, pie, etc.)
 *
 * With a `theme`, renders through `renderThemedMermaidSvg` only (the Glossy
 * path), so every diagram in an edition comes from one engine.
 */
export async function renderMermaidToPng(
	code: string,
	theme?: MermaidExportTheme,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	if (theme) {
		try {
			return await svgToPng(await renderThemedMermaidSvg(code, theme));
		} catch (e) {
			console.error("[Export] Themed Mermaid render failed:", e);
			return null;
		}
	}

	// Try beautiful-mermaid first (cleaner output for supported types)
	try {
		const beautifulMermaid = await import("beautiful-mermaid");
		const svg = beautifulMermaid.renderMermaidSVG(code.trim(), {
			bg: "#ffffff",
			fg: "#1a1a1a",
			line: "#888888",
			accent: "#9F2A3A",
			muted: "#666666",
			surface: "#f5f5f5",
			border: "#cccccc",
			font: "Helvetica, sans-serif",
		});
		const result = await svgToPng(svg);
		if (result) {
			return result;
		}
	} catch {
		// beautiful-mermaid doesn't support this diagram type — fall through
	}

	// Fallback: native mermaid.js (supports ALL diagram types)
	try {
		const mermaid = (await import("mermaid")).default;
		const svg = await withMermaidLock(async () => {
			// Restore the shared configuration afterwards, as the Glossy path
			// does, so this export's loose settings never outlive the render.
			const previous = mermaid.mermaidAPI.getSiteConfig();
			try {
				mermaid.initialize({
					startOnLoad: false,
					theme: "default",
					securityLevel: "loose",
					fontFamily: "Helvetica, sans-serif",
				});
				const id = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				return (await mermaid.render(id, code.trim())).svg;
			} finally {
				mermaid.initialize(previous);
			}
		});
		const result = await svgToPng(svg);
		if (result) {
			return result;
		}
	} catch (e) {
		console.error("[Export] Mermaid render failed:", e);
	}

	return null;
}

/** Generate a PDF Blob from markdown using jsPDF native text rendering. */
export async function renderMarkdownToPdf(content: string): Promise<Blob> {
	const { default: jsPDF } = await import("jspdf");

	const doc = new jsPDF({
		orientation: "portrait",
		unit: "pt",
		format: "a4",
	});
	const margin = 48;
	const pageWidth = 595.28;
	const pageHeight = 841.89;
	const contentWidth = pageWidth - margin * 2;
	let y = margin;

	const checkPageBreak = (needed: number) => {
		if (y + needed > pageHeight - margin) {
			doc.addPage();
			y = margin;
		}
	};

	// Visual slots are Glossy layout, not content (R38).
	const lines = stripVisualSlots(content).split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		if (/^### /.test(line)) {
			checkPageBreak(22);
			doc.setFontSize(13);
			doc.setFont("helvetica", "bold");
			doc.text(stripInlineMarkdown(line.slice(4)), margin, y);
			y += 20;
		} else if (/^## /.test(line)) {
			checkPageBreak(26);
			doc.setFontSize(16);
			doc.setFont("helvetica", "bold");
			doc.text(stripInlineMarkdown(line.slice(3)), margin, y);
			y += 24;
		} else if (/^# /.test(line)) {
			checkPageBreak(30);
			doc.setFontSize(20);
			doc.setFont("helvetica", "bold");
			doc.text(stripInlineMarkdown(line.slice(2)), margin, y);
			y += 28;
		} else if (line.startsWith("```mermaid")) {
			// Mermaid diagram block: render to PNG and embed
			const mermaidLines: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				mermaidLines.push(lines[i]);
				i++;
			}
			const mermaidCode = mermaidLines.join("\n");
			const rendered = await renderMermaidToPng(mermaidCode);
			if (rendered) {
				// Scale diagram to fit content width, preserving aspect ratio
				const aspect = rendered.width / rendered.height;
				const maxPageH = pageHeight - margin * 2;
				let imgW = Math.min(contentWidth, rendered.width);
				let imgH = imgW / aspect;
				if (imgH > maxPageH) {
					imgH = maxPageH;
					imgW = imgH * aspect;
				}
				// Move to next page if diagram doesn't fit
				if (y + imgH + 12 > pageHeight - margin) {
					doc.addPage();
					y = margin;
				}
				const offsetX = margin + (contentWidth - imgW) / 2;
				doc.addImage(rendered.dataUrl, "PNG", offsetX, y, imgW, imgH);
				y += imgH + 12;
			} else {
				// Fallback: labeled placeholder box
				const diagramTitle = mermaidLines[0] ?? "diagram";
				const boxH = 48;
				checkPageBreak(boxH + 10);
				doc.setDrawColor(180, 180, 180);
				doc.setFillColor(245, 245, 245);
				doc.roundedRect(margin, y, contentWidth, boxH, 4, 4, "FD");
				doc.setFontSize(11);
				doc.setFont("helvetica", "italic");
				doc.setTextColor(100, 100, 100);
				doc.text(
					`[Diagram: ${diagramTitle}]`,
					margin + contentWidth / 2,
					y + boxH / 2 + 4,
					{ align: "center" },
				);
				doc.setTextColor(0, 0, 0);
				y += boxH + 10;
			}
		} else if (line.startsWith("```")) {
			i++;
			doc.setFontSize(9);
			doc.setFont("courier", "normal");
			while (i < lines.length && !lines[i].startsWith("```")) {
				const codeLines = doc.splitTextToSize(
					lines[i],
					contentWidth - 16,
				);
				checkPageBreak(codeLines.length * 13);
				doc.text(codeLines, margin + 8, y);
				y += codeLines.length * 13;
				i++;
			}
			y += 6;
		} else if (parseImgTag(line) || IMAGE_LINE_RE.test(line)) {
			// Image line: HTML <img> tag or markdown ![alt](src)
			const parsed = parseImgTag(line);
			const mdMatch = !parsed ? line.match(IMAGE_LINE_RE) : null;
			const src = parsed?.src ?? mdMatch?.[2] ?? "";
			const alt = parsed?.alt ?? mdMatch?.[1] ?? "";
			const widthStr = parsed?.width ?? "";
			const caption = parsed?.caption ?? "";
			const targetW = widthFraction(widthStr, contentWidth);
			const added = await tryAddPdfImage(
				doc,
				src,
				margin,
				contentWidth,
				targetW,
				() => y,
				(v) => {
					y = v;
				},
				pageHeight,
			);
			if (added > 0) {
				y += added;
			} else {
				checkPageBreak(18);
				doc.setFontSize(10);
				doc.setFont("helvetica", "italic");
				doc.setTextColor(100, 100, 100);
				doc.text(alt ? `[Image: ${alt}]` : "[Image]", margin, y);
				doc.setTextColor(0, 0, 0);
				y += 18;
			}
			// Render caption below image
			if (caption) {
				doc.setFontSize(9);
				doc.setFont("helvetica", "italic");
				doc.setTextColor(120, 120, 120);
				const captionWrapped = doc.splitTextToSize(
					caption,
					contentWidth,
				);
				checkPageBreak(captionWrapped.length * 12);
				doc.text(captionWrapped, margin + contentWidth / 2, y, {
					align: "center",
				});
				doc.setTextColor(0, 0, 0);
				y += captionWrapped.length * 12 + 4;
			}
		} else if (/^[-*+] /.test(line)) {
			doc.setFontSize(11);
			doc.setFont("helvetica", "normal");
			const text = `\u2022 ${stripInlineMarkdown(line.slice(2))}`;
			const wrapped = doc.splitTextToSize(text, contentWidth - 12);
			checkPageBreak(wrapped.length * 15);
			doc.text(wrapped, margin + 8, y);
			y += wrapped.length * 15;
		} else if (ORDERED_ITEM_LINE_RE.test(line)) {
			doc.setFontSize(11);
			doc.setFont("helvetica", "normal");
			const text = stripInlineMarkdown(line);
			const wrapped = doc.splitTextToSize(text, contentWidth - 12);
			checkPageBreak(wrapped.length * 15);
			doc.text(wrapped, margin + 8, y);
			y += wrapped.length * 15;
		} else if (line.trim() === "" || line.trim() === "---") {
			y += 8;
		} else {
			doc.setFontSize(11);
			doc.setFont("helvetica", "normal");
			const wrapped = doc.splitTextToSize(
				stripInlineMarkdown(line),
				contentWidth,
			);
			checkPageBreak(wrapped.length * 15);
			doc.text(wrapped, margin, y);
			y += wrapped.length * 15;
		}

		i++;
	}

	return doc.output("blob");
}

/** Parse minimal markdown and return docx Paragraph/HeadingLevel arrays. */
export async function renderMarkdownToDocx(
	content: string,
	_title: string,
): Promise<Blob> {
	const {
		Document,
		Packer,
		Paragraph,
		TextRun,
		HeadingLevel,
		AlignmentType,
		ImageRun,
	} = await import("docx");

	const children: InstanceType<typeof Paragraph>[] = [];

	// Visual slots are Glossy layout, not content (R38).
	const lines = stripVisualSlots(content).split("\n");
	let i = 0;

	const parseInline = (text: string): InstanceType<typeof TextRun>[] => {
		const runs: InstanceType<typeof TextRun>[] = [];
		// First, replace inline image references with placeholder text
		const textWithImagePlaceholders = text.replace(
			/!\[([^\]]*)\]\([^)]+\)/g,
			(_match, alt) => (alt ? `[Image: ${alt}]` : "[Image]"),
		);
		// Split on bold+italic, bold, italic, inline code
		const parts = textWithImagePlaceholders.split(
			/(\*\*\*.+?\*\*\*|\*\*.+?\*\*|\*.+?\*|`[^`]+`)/g,
		);
		for (const part of parts) {
			if (!part) {
				continue;
			}
			if (part.startsWith("***") && part.endsWith("***")) {
				runs.push(
					new TextRun({
						text: part.slice(3, -3),
						bold: true,
						italics: true,
					}),
				);
			} else if (part.startsWith("**") && part.endsWith("**")) {
				runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
			} else if (part.startsWith("*") && part.endsWith("*")) {
				runs.push(
					new TextRun({ text: part.slice(1, -1), italics: true }),
				);
			} else if (part.startsWith("`") && part.endsWith("`")) {
				runs.push(
					new TextRun({
						text: part.slice(1, -1),
						font: "Courier New",
					}),
				);
			} else {
				runs.push(new TextRun({ text: part }));
			}
		}
		return runs;
	};

	while (i < lines.length) {
		const line = lines[i];

		if (/^### /.test(line)) {
			children.push(
				new Paragraph({
					text: normalizeOrderedMarkerEscape(line.slice(4)),
					heading: HeadingLevel.HEADING_3,
				}),
			);
		} else if (/^## /.test(line)) {
			children.push(
				new Paragraph({
					text: normalizeOrderedMarkerEscape(line.slice(3)),
					heading: HeadingLevel.HEADING_2,
				}),
			);
		} else if (/^# /.test(line)) {
			children.push(
				new Paragraph({
					text: normalizeOrderedMarkerEscape(line.slice(2)),
					heading: HeadingLevel.HEADING_1,
				}),
			);
		} else if (/^[-*+] /.test(line)) {
			children.push(
				new Paragraph({
					children: parseInline(line.slice(2)),
					bullet: { level: 0 },
				}),
			);
		} else if (ORDERED_ITEM_LINE_RE.test(line)) {
			children.push(
				new Paragraph({
					children: parseInline(
						line.replace(ORDERED_ITEM_LINE_RE, ""),
					),
					numbering: { reference: "default-numbering", level: 0 },
				}),
			);
		} else if (line.startsWith("```mermaid")) {
			// Mermaid diagram: render to PNG and embed as image
			const mermaidLines: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				mermaidLines.push(lines[i]);
				i++;
			}
			const mermaidCode = mermaidLines.join("\n");
			const rendered = await renderMermaidToPng(mermaidCode);
			if (rendered) {
				// Convert data URL to bytes for DOCX ImageRun
				const base64Part = rendered.dataUrl.split(",")[1];
				if (base64Part) {
					const binary = atob(base64Part);
					const bytes = new Uint8Array(binary.length);
					for (let j = 0; j < binary.length; j++) {
						bytes[j] = binary.charCodeAt(j);
					}
					// Scale to fit page width
					const maxW = 576;
					const aspect = rendered.width / rendered.height;
					let w = Math.min(maxW, rendered.width);
					let h = w / aspect;
					if (h > 700) {
						h = 700;
						w = h * aspect;
					}
					children.push(new Paragraph({}));
					children.push(
						new Paragraph({
							children: [
								new ImageRun({
									data: bytes,
									transformation: {
										width: Math.round(w),
										height: Math.round(h),
									},
									type: "png",
								}),
							],
							alignment: AlignmentType.CENTER,
						}),
					);
					children.push(new Paragraph({}));
				}
			} else {
				// Fallback: italic placeholder
				const diagramTitle = mermaidLines[0] ?? "diagram";
				children.push(new Paragraph({}));
				children.push(
					new Paragraph({
						children: [
							new TextRun({
								text: `[Diagram: ${diagramTitle}]`,
								italics: true,
								color: "666666",
							}),
						],
					}),
				);
				children.push(new Paragraph({}));
			}
		} else if (line.startsWith("```")) {
			// Regular code block
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				codeLines.push(lines[i]);
				i++;
			}
			for (const codeLine of codeLines) {
				children.push(
					new Paragraph({
						children: [
							new TextRun({
								text: codeLine,
								font: "Courier New",
								size: 18,
							}),
						],
					}),
				);
			}
		} else if (parseImgTag(line) || IMAGE_LINE_RE.test(line)) {
			// Image line: HTML <img> tag or markdown ![alt](src)
			const parsed = parseImgTag(line);
			const mdMatch = !parsed ? line.match(IMAGE_LINE_RE) : null;
			const src = parsed?.src ?? mdMatch?.[2] ?? "";
			const alt = parsed?.alt ?? mdMatch?.[1] ?? "";
			const widthStr = parsed?.width ?? "";
			const caption = parsed?.caption ?? "";
			const docxMaxW = 576; // ~6 inches at 96dpi
			const targetW = widthFraction(widthStr, docxMaxW);
			const imgData = await tryLoadImageBytes(src);
			if (imgData) {
				const aspect = imgData.width / imgData.height;
				const w = targetW;
				const h = w / aspect;
				children.push(
					new Paragraph({
						children: [
							new ImageRun({
								data: imgData.data,
								transformation: {
									width: Math.round(w),
									height: Math.round(h),
								},
								type: "png",
							}),
						],
						alignment: AlignmentType.CENTER,
					}),
				);
			} else {
				children.push(
					new Paragraph({
						children: [
							new TextRun({
								text: alt ? `[Image: ${alt}]` : "[Image]",
								italics: true,
								color: "666666",
							}),
						],
					}),
				);
			}
			// Render caption below image
			if (caption) {
				children.push(
					new Paragraph({
						children: [
							new TextRun({
								text: caption,
								italics: true,
								color: "888888",
								size: 18,
							}),
						],
						alignment: AlignmentType.CENTER,
					}),
				);
			}
		} else if (line.trim() === "" || line.trim() === "---") {
			children.push(new Paragraph({}));
		} else {
			children.push(new Paragraph({ children: parseInline(line) }));
		}

		i++;
	}

	const doc = new Document({
		numbering: {
			config: [
				{
					reference: "default-numbering",
					levels: [
						{
							level: 0,
							format: "decimal",
							text: "%1.",
							alignment: AlignmentType.START,
						},
					],
				},
			],
		},
		sections: [
			{
				properties: {},
				children,
			},
		],
	});

	return Packer.toBlob(doc);
}
