"use client";

/**
 * Text and image helpers shared by the two browser-side document exporters:
 * the regular PDF/DOCX download (`markdown-to-document.ts`) and the Glossy
 * edition renderer (`glossy/`).
 *
 * Exports:
 * - `normalizeOrderedMarkerEscape` — drop a serializer-escaped ordered marker
 *   (re-exported from `@repo/utils`, which the Glossy cache keys share)
 * - `stripInlineMarkdown`          — inline Markdown → plain text for jsPDF
 * - `TABLE_ROW`, `TABLE_SEPARATOR`, `splitTableRow`, `readMarkdownTable`
 *                                  — read a GFM table out of Markdown lines
 * - `readMarkdownBlockquote`       — read a `>` blockquote's paragraphs
 * - `readBoldRuns`, `layOutPdfRuns` — split text at bold and wrap it for jsPDF
 * - `layOutPdfTable`               — PDF table column widths sized to their words
 * - `toWinAnsiText`                — text jsPDF's built-in fonts can draw
 * - `getImageDimensions`           — natural size of an image data URL
 * - `tryAddPdfImage`               — place an image on a jsPDF page
 * - `tryLoadImageBytes`            — image → bytes and size for a DOCX `ImageRun`
 * - `svgToPng`                     — rasterize an SVG string through a canvas
 */

import { normalizeOrderedMarkerEscape } from "@repo/utils/normalize-for-comparison";

export { normalizeOrderedMarkerEscape };

/** Strip inline markdown to plain text for PDF rendering. */
export function stripInlineMarkdown(text: string): string {
	return (
		normalizeOrderedMarkerEscape(text)
			// Strip inline image references: ![alt](src)
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, alt) =>
				alt ? `[Image: ${alt}]` : "[Image]",
			)
			// Strip inline <img> HTML tags
			.replace(/<img\s[^>]*alt="([^"]*)"[^>]*\/>/g, (_match, alt) =>
				alt ? `[Image: ${alt}]` : "[Image]",
			)
			.replace(/\*\*\*(.+?)\*\*\*/g, "$1")
			.replace(/\*\*(.+?)\*\*/g, "$1")
			// An underscore inside a word (`snake_case_name`) is not emphasis.
			// The emphasized text holds underscores only inside a word
			// (`__max_retries__`), so each opener scans no further than the
			// next underscore between words and a long line stays linear.
			.replace(
				/(?<![\p{L}\p{N}_])___((?:[^_\n]|(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}]))+?)___(?![\p{L}\p{N}_])/gu,
				"$1",
			)
			.replace(
				/(?<![\p{L}\p{N}_])__((?:[^_\n]|(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}]))+?)__(?![\p{L}\p{N}_])/gu,
				"$1",
			)
			.replace(/\*(.+?)\*/g, "$1")
			.replace(
				/(?<![\p{L}\p{N}_])_((?:[^_\n]|(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}]))+?)_(?![\p{L}\p{N}_])/gu,
				"$1",
			)
			.replace(/`([^`]+)`/g, "$1")
	);
}

/**
 * A horizontal rule in any CommonMark spelling: three or more of one of
 * `-`, `*` or `_`, spaces allowed between. Documents saved by older editor
 * versions spell the rule `* * *`, which would otherwise read as a list item.
 */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

export function isThematicBreak(line: string): boolean {
	return THEMATIC_BREAK.test(line);
}

/** A GFM table row: a line wrapped in pipes. */
export const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** The delimiter row under a GFM table's header (`| --- | :---: |`). */
export const TABLE_SEPARATOR =
	/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?\|?\s*$/;

/** The cells of a table row, split on unescaped pipes and trimmed. */
export function splitTableRow(line: string): string[] {
	const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return cells.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * The GFM table starting at `lines[start]`, if one does: a header row, the
 * delimiter row, then every row up to the first line that is not one. Rows
 * keep their cells' inline Markdown; `next` is the index after the table.
 * Null when `start` is not a header row followed by a delimiter row.
 */
export function readMarkdownTable(
	lines: readonly string[],
	start: number,
): { rows: string[][]; columns: number; next: number } | null {
	const header = lines[start];
	if (
		header === undefined ||
		!TABLE_ROW.test(header) ||
		!TABLE_SEPARATOR.test(lines[start + 1] ?? "")
	) {
		return null;
	}
	const rows = [splitTableRow(header)];
	let next = start + 2;
	while (next < lines.length && TABLE_ROW.test(lines[next])) {
		rows.push(splitTableRow(lines[next]));
		next++;
	}
	const columns = Math.max(...rows.map((row) => row.length));
	return { rows, columns, next };
}

/** A blockquote line: `>` after optional indentation, one space dropped. */
const BLOCKQUOTE_LINE = /^\s*> ?/;

/**
 * The blockquote starting at `lines[start]`, if one does: every consecutive
 * `>` line, its marker removed. A bare `>` line separates paragraphs; the
 * lines of one paragraph join with a space, as Markdown reflows them. Each
 * paragraph keeps its inline Markdown, so a quote's bold label stays bold;
 * `next` is the index after the quote. Null when `start` is not a quote line.
 */
export function readMarkdownBlockquote(
	lines: readonly string[],
	start: number,
): { paragraphs: string[]; next: number } | null {
	if (!BLOCKQUOTE_LINE.test(lines[start] ?? "")) {
		return null;
	}
	const paragraphs: string[] = [];
	let current: string[] = [];
	const close = () => {
		if (current.length > 0) {
			paragraphs.push(current.join(" "));
			current = [];
		}
	};
	let next = start;
	while (next < lines.length && BLOCKQUOTE_LINE.test(lines[next])) {
		const text = lines[next].replace(BLOCKQUOTE_LINE, "").trim();
		if (text === "") {
			close();
		} else {
			current.push(text);
		}
		next++;
	}
	close();
	return { paragraphs, next };
}

/** A stretch of PDF text drawn in one font: bold, or the regular font. */
export interface PdfTextRun {
	text: string;
	bold: boolean;
}

/**
 * `**bold**` or `***bold italic***`, which a plain PDF draws in bold. The
 * markers hug the text, so `2 ** 3 and 4 ** 2` holds no bold.
 */
const BOLD_SPAN = /(\*\*\*(?!\s).+?(?<!\s)\*\*\*|\*\*(?!\s).+?(?<!\s)\*\*)/;

/**
 * A paragraph as the plain PDF draws it, after `stripInlineMarkdown` and
 * `toWinAnsiText`, split where bold starts and ends. Where the split would
 * change the drawn text, as for emphasis that spans a bold word
 * (`*a **b** c*`) or a stand-in word glued to the bold (`**↑**12%`, drawn
 * `up 12%`), the paragraph comes back as one regular run, drawn as before.
 */
export function readBoldRuns(markdown: string): PdfTextRun[] {
	const drawn = toWinAnsiText(stripInlineMarkdown(markdown));
	const runs = markdown
		.split(BOLD_SPAN)
		.map((part, index) => {
			const bold = index % 2 === 1;
			const marks =
				part.startsWith("***") && part.endsWith("***") ? 3 : 2;
			const inner = bold ? part.slice(marks, -marks) : part;
			return { text: toWinAnsiText(stripInlineMarkdown(inner)), bold };
		})
		.filter((run) => run.text !== "");
	if (
		!runs.some((run) => run.bold) ||
		runs.map((run) => run.text).join("") !== drawn
	) {
		return [{ text: drawn, bold: false }];
	}
	return runs;
}

/** A run placed on a line, `x` from the line's start. */
export interface PlacedPdfRun extends PdfTextRun {
	x: number;
}

/**
 * Lines of mixed bold and regular text that fit `width`, breaking at
 * spaces as `splitTextToSize` does: bold text glued to punctuation
 * (`**Label**:`) stays together, and a word wider than the line, such as a
 * link, breaks inside it. Each line holds one string per stretch of the
 * same font, without a leading or trailing space; a space between two
 * stretches moves the next one along. `measure` returns a string's width
 * and `split` wraps one, both in the given font.
 */
export function layOutPdfRuns(
	runs: readonly PdfTextRun[],
	width: number,
	measure: (text: string, bold: boolean) => number,
	split: (text: string, bold: boolean, width: number) => string[],
): PlacedPdfRun[][] {
	// Words, each with the spaces before it; parts glued to one another
	// with no space between keep their own fonts.
	type Word = { gap: string; parts: PdfTextRun[] };
	const words: Word[] = [];
	let gap = "";
	let open = false;
	for (const run of runs) {
		for (const piece of run.text.split(/( +)/)) {
			if (piece === "") {
				continue;
			}
			if (piece.startsWith(" ")) {
				gap = piece;
				open = false;
			} else if (open) {
				words[words.length - 1].parts.push({
					text: piece,
					bold: run.bold,
				});
			} else {
				words.push({ gap, parts: [{ text: piece, bold: run.bold }] });
				gap = "";
				open = true;
			}
		}
	}

	// A word wider than the line breaks into pieces that each fit it.
	const fitted = words.flatMap((word): Word[] => {
		const wide =
			word.parts.reduce(
				(sum, part) => sum + measure(part.text, part.bold),
				0,
			) > width;
		if (!wide) {
			return [word];
		}
		return word.parts.flatMap((part, partIndex) =>
			split(part.text, part.bold, width).map((text, index) => ({
				gap: partIndex === 0 && index === 0 ? word.gap : "",
				parts: [{ text, bold: part.bold }],
			})),
		);
	});

	const lines: Word[][] = [];
	let line: Word[] = [];
	let lineWidth = 0;
	for (const word of fitted) {
		const wordWidth = word.parts.reduce(
			(sum, part) => sum + measure(part.text, part.bold),
			0,
		);
		const gapWidth = line.length > 0 ? measure(word.gap, false) : 0;
		if (line.length > 0 && lineWidth + gapWidth + wordWidth > width) {
			lines.push(line);
			line = [];
			lineWidth = 0;
		}
		line.push(line.length > 0 ? word : { ...word, gap: "" });
		lineWidth += (line.length > 1 ? gapWidth : 0) + wordWidth;
	}
	if (line.length > 0 || lines.length === 0) {
		// An empty paragraph still takes one line, as `splitTextToSize` gives it.
		lines.push(line);
	}

	return lines.map((words) => {
		const placed: (PlacedPdfRun & { gap: string })[] = [];
		for (const word of words) {
			word.parts.forEach((part, index) => {
				const before = index === 0 ? word.gap : "";
				const last = placed[placed.length - 1];
				if (last && last.bold === part.bold) {
					last.text += before + part.text;
				} else {
					placed.push({ ...part, gap: before, x: 0 });
				}
			});
		}
		placed.forEach((run, index) => {
			if (index > 0) {
				const previous = placed[index - 1];
				run.x =
					previous.x +
					measure(previous.text, previous.bold) +
					measure(run.gap, false);
			}
		});
		return placed.map(({ text, bold, x }) => ({ text, bold, x }));
	});
}

/**
 * The widest word a table always keeps on one line, in ems of the table's
 * font: wider than any dictionary word (about 10 em in bold Helvetica).
 * A longer word, such as an identifier, a path or a link, stays whole when
 * an even share of the table holds it, and otherwise breaks in its cell
 * rather than squeezing every other column.
 */
const TABLE_WORD_CAP_EM = 11;

/** What a word wider than the cap settles for when an even share would crowd the other columns' words, in ems. */
const TABLE_LINK_MIN_EM = 4;

/** Where each column of a PDF table starts and how wide it is, and the font size and cell padding its cells use. */
export interface PdfTableLayout {
	fontSize: number;
	/** The requested padding, or less when the table has so many columns that it would leave a column no room for text. */
	padding: number;
	/** `left` is the column's offset from the table's left edge; widths include padding and add up to the table width. */
	columns: { left: number; width: number }[];
}

/**
 * Column widths for a PDF table, sized to its words (Fizzy #2946): jsPDF's
 * `splitTextToSize` breaks a word wider than its cell between letters, and
 * an even share of the page leaves a seven-column table about 60pt of text
 * per cell. Each column holds at least its widest word on one line, and the
 * width left over goes to the columns whose text runs longest, as a browser
 * lays out an auto-width table. A word wider than the cap, such as a link,
 * asks for no more than an even share of the table, or a few ems when that
 * would crowd the other columns' words, and counts at the cap when the rest
 * of the width is shared. When even the widest words do not fit side by
 * side, the font steps down, by quarter points to `minFontSize`; only past
 * that can a word still break.
 *
 * `rows` holds the text as drawn, header row first; `measure` returns its
 * width at `fontSize`, in the header's font when `header` is set.
 */
export function layOutPdfTable(
	rows: readonly (readonly string[])[],
	options: {
		columns: number;
		width: number;
		padding: number;
		fontSize: number;
		minFontSize: number;
		measure: (text: string, header: boolean) => number;
	},
): PdfTableLayout {
	const { columns, width, fontSize, minFontSize, measure } = options;
	// Padding takes at most a quarter of each column's even share, so a
	// table with many columns keeps three quarters of its width for text.
	const padding = Math.min(options.padding, width / columns / 8);
	const cap = TABLE_WORD_CAP_EM * fontSize;
	const room = width - columns * padding * 2;
	// jsPDF keeps a word whose width equals the line's; a hair more absorbs
	// rounding between its measure and ours.
	const hair = 0.01;
	// Per column, the widest word within the cap and the widest past it.
	const word: number[] = Array(columns).fill(0);
	const long: number[] = Array(columns).fill(0);
	let preferred: number[] = Array(columns).fill(0);
	rows.forEach((row, index) => {
		const header = index === 0;
		for (let c = 0; c < columns; c++) {
			const text = row[c] ?? "";
			let overCap = 0;
			for (const token of text.split(" ")) {
				const tokenWidth = measure(token, header);
				if (tokenWidth > cap) {
					long[c] = Math.max(long[c], tokenWidth + hair);
					overCap += tokenWidth - cap;
				} else {
					word[c] = Math.max(word[c], tokenWidth + hair);
				}
			}
			preferred[c] = Math.max(
				preferred[c],
				measure(text, header) - overCap + hair,
			);
		}
	});

	const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
	// Comparisons allow for rounding in the sums.
	const fits = (values: number[], space: number) =>
		sum(values) <= space + 1e-6;
	const minimumFor = (longAsk: number) =>
		word.map((value, c) => Math.max(value, Math.min(long[c], longAsk)));
	let minimum = minimumFor(room / columns);
	if (!fits(minimum, room)) {
		minimum = minimumFor(TABLE_LINK_MIN_EM * fontSize);
	}
	preferred = preferred.map((value, c) => Math.max(value, minimum[c]));

	let size = fontSize;
	if (!fits(minimum, room)) {
		size = Math.max(
			minFontSize,
			Math.floor(((fontSize * room) / sum(minimum)) * 4) / 4,
		);
		// Text widths scale with the font size.
		minimum = minimum.map((value) => (value * size) / fontSize);
		preferred = preferred.map((value) => (value * size) / fontSize);
	}

	let text: number[];
	if (fits(preferred, room)) {
		// Every cell fits on one line: widen in proportion.
		text = preferred.map((value) => (value * room) / sum(preferred));
	} else if (fits(minimum, room)) {
		// Every word fits: share what is left by how much text runs longer.
		const slack = room - sum(minimum);
		const flex = sum(preferred) - sum(minimum);
		text = minimum.map(
			(value, c) => value + (slack * (preferred[c] - value)) / flex,
		);
	} else {
		text = minimum.map((value) => (value * room) / sum(minimum));
	}

	let left = 0;
	return {
		fontSize: size,
		padding,
		columns: text.map((value) => {
			const column = { left, width: value + padding * 2 };
			left += column.width;
			return column;
		}),
	};
}

/**
 * Read image dimensions from a base64 data URL by parsing the binary header.
 * Much faster than creating an HTMLImageElement (avoids full decode).
 * Returns { width, height } or null if parsing fails.
 */
function readImageDimensions(
	dataUrl: string,
): { width: number; height: number } | null {
	try {
		const base64 = dataUrl.split(",")[1];
		if (!base64) {
			return null;
		}
		const binary = atob(base64.slice(0, 400)); // only need first bytes
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}

		// PNG: width at offset 16, height at offset 20 (big-endian uint32)
		if (bytes[0] === 0x89 && bytes[1] === 0x50) {
			const w =
				(bytes[16] << 24) |
				(bytes[17] << 16) |
				(bytes[18] << 8) |
				bytes[19];
			const h =
				(bytes[20] << 24) |
				(bytes[21] << 16) |
				(bytes[22] << 8) |
				bytes[23];
			if (w > 0 && h > 0) {
				return { width: w, height: h };
			}
		}

		// JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
		if (bytes[0] === 0xff && bytes[1] === 0xd8) {
			let offset = 2;
			while (offset < bytes.length - 9) {
				if (bytes[offset] !== 0xff) {
					break;
				}
				const marker = bytes[offset + 1];
				if (marker === 0xc0 || marker === 0xc2) {
					const h = (bytes[offset + 5] << 8) | bytes[offset + 6];
					const w = (bytes[offset + 7] << 8) | bytes[offset + 8];
					if (w > 0 && h > 0) {
						return { width: w, height: h };
					}
				}
				const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
				offset += 2 + segLen;
			}
		}

		// GIF: width at offset 6, height at offset 8 (little-endian uint16)
		if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
			const w = bytes[6] | (bytes[7] << 8);
			const h = bytes[8] | (bytes[9] << 8);
			if (w > 0 && h > 0) {
				return { width: w, height: h };
			}
		}

		// WebP: RIFF header, VP8 chunk
		if (
			bytes[0] === 0x52 &&
			bytes[1] === 0x49 && // "RI"
			bytes[8] === 0x57 &&
			bytes[9] === 0x45 // "WE"
		) {
			// VP8 lossy
			if (
				bytes[12] === 0x56 &&
				bytes[13] === 0x50 &&
				bytes[14] === 0x38 &&
				bytes[15] === 0x20
			) {
				const w = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
				const h = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
				if (w > 0 && h > 0) {
					return { width: w, height: h };
				}
			}
		}

		return null;
	} catch {
		return null;
	}
}

/** Fallback: Load image into HTMLImageElement to get dimensions. Slower but works for all formats. */
function loadImageElement(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		if (src.startsWith("http")) {
			img.crossOrigin = "anonymous";
		}
		img.src = src;
	});
}

/** Get image dimensions — fast path for base64, fallback to Image element. */
export async function getImageDimensions(
	dataUrl: string,
): Promise<{ width: number; height: number }> {
	// Fast path: parse binary header (no full decode needed)
	const dims = readImageDimensions(dataUrl);
	if (dims) {
		return dims;
	}
	// Fallback: load image element
	const img = await loadImageElement(dataUrl);
	return {
		width: img.naturalWidth || img.width || 400,
		height: img.naturalHeight || img.height || 300,
	};
}

/**
 * Try to add an image to a jsPDF document with proper aspect ratio.
 * Scales to fit within targetWidth while preserving proportions.
 * Uses getY callback to get current Y position (which may change after page break).
 * Returns the height consumed, or 0 if the image could not be embedded.
 */
export async function tryAddPdfImage(
	doc: InstanceType<typeof import("jspdf").jsPDF>,
	src: string,
	margin: number,
	contentWidth: number,
	targetWidth: number,
	getY: () => number,
	setY: (v: number) => void,
	pageHeight: number,
): Promise<number> {
	try {
		let dataUrl = src;

		// If it is an HTTP(S) URL, fetch it and convert to data URL
		if (src.startsWith("http://") || src.startsWith("https://")) {
			const resp = await fetch(src);
			if (!resp.ok) {
				return 0;
			}
			const blob = await resp.blob();
			dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result as string);
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
		}

		if (!dataUrl.startsWith("data:image/")) {
			return 0;
		}

		// Get image dimensions (fast binary header parse, no full decode)
		const dims = await getImageDimensions(dataUrl);
		const aspect = dims.width / dims.height;
		// Use targetWidth directly — respects the S/M/L size chosen by user
		let imgWidth = targetWidth;
		let imgHeight = imgWidth / aspect;
		// Cap height to usable page area
		const maxPageHeight = pageHeight - margin * 2;
		if (imgHeight > maxPageHeight) {
			imgHeight = maxPageHeight;
			imgWidth = imgHeight * aspect;
		}

		// Determine format from the data URL
		const formatMatch = dataUrl.match(/^data:image\/(\w+)/);
		const format = (formatMatch?.[1] ?? "png").toUpperCase();

		// Page break if image doesn't fit remaining space — move to new page
		if (getY() + imgHeight + 12 > pageHeight - margin) {
			doc.addPage();
			setY(margin);
		}

		// Center the image horizontally within content area
		const offsetX = margin + (contentWidth - imgWidth) / 2;
		const currentY = getY();

		doc.addImage(dataUrl, format, offsetX, currentY, imgWidth, imgHeight);
		return imgHeight + 12;
	} catch {
		return 0;
	}
}

/**
 * Try to convert a data URL or fetch an HTTP image to a Uint8Array for DOCX embedding.
 * Reads the real image dimensions and scales to fit within the DOCX page width (~6 inches = 576px).
 * Returns null if it cannot be loaded.
 */
export async function tryLoadImageBytes(
	src: string,
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
	try {
		let dataUrl = src;

		if (src.startsWith("http://") || src.startsWith("https://")) {
			const resp = await fetch(src);
			if (!resp.ok) {
				return null;
			}
			const blob = await resp.blob();
			dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result as string);
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
		}

		if (!dataUrl.startsWith("data:image/")) {
			return null;
		}

		// Get image dimensions (fast binary header parse, no full decode)
		const dims = await getImageDimensions(dataUrl);
		const naturalW = dims.width;
		const naturalH = dims.height;

		// Scale to fit DOCX page width (~6 inches at 96dpi = 576px)
		const maxDocxWidth = 576;
		const maxDocxHeight = 700;
		const aspect = naturalW / naturalH;
		let width = Math.min(maxDocxWidth, naturalW);
		let height = width / aspect;
		if (height > maxDocxHeight) {
			height = maxDocxHeight;
			width = height * aspect;
		}

		// Get binary data
		const base64Part = dataUrl.split(",")[1];
		if (!base64Part) {
			return null;
		}
		const binary = atob(base64Part);
		const bytes = new Uint8Array(binary.length);
		for (let j = 0; j < binary.length; j++) {
			bytes[j] = binary.charCodeAt(j);
		}

		return {
			data: bytes,
			width: Math.round(width),
			height: Math.round(height),
		};
	} catch {
		return null;
	}
}

/**
 * Replace <foreignObject> elements in SVG with <text> approximations.
 * Browsers refuse to render SVGs with foreignObject to canvas for security reasons.
 * This converts HTML labels (used by mermaid C4, mindmap, gantt) to plain SVG text.
 */
function replaceForeignObjects(svgString: string): string {
	const parser = new DOMParser();
	const doc = parser.parseFromString(svgString, "image/svg+xml");
	const foreignObjects = doc.querySelectorAll("foreignObject");

	for (const fo of foreignObjects) {
		const x = Number.parseFloat(fo.getAttribute("x") || "0");
		const y = Number.parseFloat(fo.getAttribute("y") || "0");
		const w = Number.parseFloat(fo.getAttribute("width") || "100");
		const h = Number.parseFloat(fo.getAttribute("height") || "30");

		// Extract all text content, split into lines
		const rawText = fo.textContent?.trim() || "";
		const lines = rawText
			.split(/\n/)
			.map((l) => l.trim())
			.filter(Boolean);

		// Create a <g> group with <text> elements
		const g = doc.createElementNS("http://www.w3.org/2000/svg", "g");
		const fontSize = Math.min(14, h / Math.max(lines.length, 1) - 2);
		const centerX = x + w / 2;
		const startY = y + h / 2 - ((lines.length - 1) * (fontSize + 2)) / 2;

		for (let i = 0; i < lines.length; i++) {
			const textEl = doc.createElementNS(
				"http://www.w3.org/2000/svg",
				"text",
			);
			textEl.setAttribute("x", String(centerX));
			textEl.setAttribute("y", String(startY + i * (fontSize + 2)));
			textEl.setAttribute("text-anchor", "middle");
			textEl.setAttribute("dominant-baseline", "central");
			textEl.setAttribute("font-size", String(fontSize));
			textEl.setAttribute("font-family", "Helvetica, sans-serif");
			textEl.setAttribute("fill", "#333333");
			textEl.textContent = lines[i];
			g.appendChild(textEl);
		}

		fo.parentNode?.replaceChild(g, fo);
	}

	return new XMLSerializer().serializeToString(doc);
}

/**
 * Convert an SVG string to a PNG data URL via canvas.
 * Handles foreignObject by replacing with SVG text elements.
 */
export async function svgToPng(
	svg: string,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	// Parse dimensions
	const vbMatch = svg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
	const wMatch = svg.match(/width="([\d.]+)/);
	const hMatch = svg.match(/height="([\d.]+)/);
	const svgW = vbMatch
		? Number.parseFloat(vbMatch[1])
		: wMatch
			? Number.parseFloat(wMatch[1])
			: 400;
	const svgH = vbMatch
		? Number.parseFloat(vbMatch[2])
		: hMatch
			? Number.parseFloat(hMatch[1])
			: 300;

	// Replace foreignObject elements with SVG text (canvas can't render foreignObject)
	let cleanSvg = svg.includes("<foreignObject")
		? replaceForeignObjects(svg)
		: svg;

	// Ensure xmlns
	if (!cleanSvg.includes('xmlns="http://www.w3.org/2000/svg"')) {
		cleanSvg = cleanSvg.replace(
			"<svg",
			'<svg xmlns="http://www.w3.org/2000/svg"',
		);
	}

	const scale = 2;
	const canvas = document.createElement("canvas");
	canvas.width = svgW * scale;
	canvas.height = svgH * scale;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}

	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const svgBase64 = btoa(unescape(encodeURIComponent(cleanSvg)));
	const dataUrl = `data:image/svg+xml;base64,${svgBase64}`;

	const img = new Image();
	await new Promise<void>((resolve, reject) => {
		img.onload = () => {
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			resolve();
		};
		img.onerror = reject;
		img.src = dataUrl;
	});

	return {
		dataUrl: canvas.toDataURL("image/png"),
		width: svgW,
		height: svgH,
	};
}

/**
 * The characters of Windows-1252 at 0x80–0x9F: with Latin-1, all that the
 * PDF's built-in Helvetica and Courier can draw.
 */
const WIN_ANSI_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Readable stand-ins for common characters outside Windows-1252. */
const WIN_ANSI_FALLBACKS: Readonly<Record<string, string>> = {
	"≥": ">=",
	"≤": "<=",
	"→": "->",
	"←": "<-",
	"↔": "<->",
	"⇒": "=>",
	"⇐": "<=",
	"⇔": "<=>",
	"≠": "!=",
	"≈": "~",
	// Bullet variants: Windows-1252 has the bullet itself.
	"●": "•",
	"▪": "•",
	"◦": "•",
	"▸": "•",
	"►": "•",
	"‣": "•",
	"′": "'",
	"″": '"',
	// Latin letters that do not decompose into a base letter and a mark.
	ł: "l",
	Ł: "L",
	đ: "d",
	Đ: "D",
	ı: "i",
};

/**
 * Words that stand in for a symbol. Each is set off by a space from a
 * letter or digit beside it: `₹500` is `INR 500`, `↑20%` is `up 20%`.
 */
const WIN_ANSI_WORDS: Readonly<Record<string, string>> = {
	"✓": "Yes",
	"✔": "Yes",
	"✅": "Yes",
	"✗": "No",
	"✘": "No",
	"❌": "No",
	"↑": "up",
	"↓": "down",
	// Currencies outside Windows-1252, as their ISO 4217 codes.
	"₹": "INR",
	"₽": "RUB",
	"₴": "UAH",
	"₩": "KRW",
	"₪": "ILS",
	"₺": "TRY",
	"₦": "NGN",
	"₫": "VND",
};

/**
 * A run of superscript digits and signs: Windows-1252's ¹ ² ³, and ⁰ ⁴–⁹
 * ⁺ ⁻, which it lacks.
 */
const SUPERSCRIPT_RUN = /[\u00b9\u00b2\u00b3\u2070\u2074-\u207b]+/g;
const OUTSIDE_WIN_ANSI_SUPERSCRIPT = /[\u2070\u2074-\u207b]/;

/**
 * A superscript run holding a character Windows-1252 lacks, after a caret
 * (Fizzy #2589 follow-up): flattened, `10⁶` would read `106`, a different
 * figure. `10⁶` → `10^6`, `10⁻³` → `10^-3`, and `10¹⁵` → `10^15`, since
 * ¹ belongs to the run. A run of ¹ ² ³ alone is drawn as it is. The
 * compatibility form of `⁻` is the minus sign, which `toWinAnsiChar`
 * writes as `-`.
 */
function caretSuperscripts(text: string): string {
	return text.replace(SUPERSCRIPT_RUN, (run) =>
		OUTSIDE_WIN_ANSI_SUPERSCRIPT.test(run)
			? `^${run.normalize("NFKC")}`
			: run,
	);
}

const COMBINING_MARK = /\p{M}/gu;
const LONE_MARK = /^\p{M}$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The soft hyphen: Latin-1, but invisible in text, and jsPDF draws it. */
const SOFT_HYPHEN = 0xad;

function isWinAnsi(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return (
		code === 0x09 ||
		code === 0x0a ||
		code === 0x0d ||
		(code >= 0x20 && code <= 0x7e) ||
		(code >= 0xa0 && code <= 0xff && code !== SOFT_HYPHEN) ||
		WIN_ANSI_EXTRAS.has(char)
	);
}

/**
 * The character's compatibility form, with any letter outside
 * Windows-1252 reduced to its base letter: `ﬁ` → `fi`, `Ａ` → `A`,
 * `₂` → `2`, `ř` → `r`, while `ǅ` keeps the `ž` Windows-1252 has. Null
 * when that form still holds a character Windows-1252 lacks, or is only
 * blank, as a spacing accent's space-and-mark is.
 */
function plainForm(char: string): string | null {
	// Most characters with no form of their own (CJK, emoji) stop here.
	if (char.normalize("NFKD") === char) {
		return null;
	}
	let out = "";
	for (const part of char.normalize("NFKC")) {
		if (isWinAnsi(part)) {
			out += part;
			continue;
		}
		const fallback = WIN_ANSI_FALLBACKS[part];
		if (fallback !== undefined) {
			out += fallback;
			continue;
		}
		const base = part.normalize("NFD").replace(COMBINING_MARK, "");
		for (const piece of base) {
			if (!isWinAnsi(piece)) {
				return null;
			}
		}
		out += base;
	}
	return out !== "" && out.trim() === "" ? null : out;
}

function toWinAnsiChar(char: string): string {
	if (isWinAnsi(char)) {
		return char;
	}
	const fallback = WIN_ANSI_FALLBACKS[char];
	if (fallback !== undefined) {
		return fallback;
	}
	const code = char.codePointAt(0) ?? 0;
	// Hyphen and minus variants.
	if ((code >= 0x2010 && code <= 0x2012) || code === 0x2212) {
		return "-";
	}
	// Space variants, from the en quad to the ideographic space.
	if (
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000
	) {
		return " ";
	}
	// Zero-width characters, variation selectors, and the soft hyphen.
	if (
		(code >= 0x200b && code <= 0x200d) ||
		code === 0x2060 ||
		code === 0xfeff ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code === SOFT_HYPHEN
	) {
		return "";
	}
	// A mark that composition left without a letter to join is dropped,
	// as a letter's own diacritic is.
	if (LONE_MARK.test(char)) {
		return "";
	}
	return plainForm(char) ?? "?";
}

/**
 * Text a PDF can draw: the Glossy edition's and the regular download's
 * (Fizzy #2589 follow-up, shared since #2801). jsPDF's built-in
 * fonts draw only Windows-1252: any other character came out as two wrong
 * glyphs (`≥` as `"e`), letter-spaced the whole string, and threw off
 * `splitTextToSize`, so the line ran past the margin. Common symbols become
 * their ASCII forms or a word (`↑` → `up`, `₹` → `INR`), superscript
 * runs Windows-1252 cannot draw a caret form (`10⁶` → `10^6`), hyphen and
 * space variants plain ones, invisible characters are dropped, ligatures,
 * full-width and other compatibility forms take their plain form, other
 * Latin letters lose their diacritic, and anything else, one code point at
 * a time, becomes `?`. Its output maps to itself. The DOCX keeps the
 * original text.
 */
export function toWinAnsiText(text: string): string {
	let out = "";
	// The last character written, and whether it ended a word stand-in.
	let last = "";
	let afterWord = false;
	for (const char of caretSuperscripts(text.normalize("NFC"))) {
		const word = WIN_ANSI_WORDS[char];
		const mapped = word ?? toWinAnsiChar(char);
		if (mapped === "") {
			continue;
		}
		if (
			(word !== undefined || afterWord) &&
			LETTER_OR_DIGIT.test(last) &&
			LETTER_OR_DIGIT.test(mapped[0])
		) {
			out += " ";
		}
		out += mapped;
		last = mapped[mapped.length - 1];
		afterWord = word !== undefined;
	}
	return out;
}
