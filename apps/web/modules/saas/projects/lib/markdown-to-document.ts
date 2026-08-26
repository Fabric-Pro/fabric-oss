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
 * - `renderMermaidToPng`      — mermaid code → `{dataUrl, width, height}`
 * - `renderMarkdownToPdf`     — Markdown → PDF Blob (jsPDF, native text)
 * - `renderMarkdownToDocx`    — Markdown → DOCX Blob (docx + Packer)
 *
 * Everything else in this file is internal to the renderers.
 */

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

/** Drop the backslash from an escaped ordered marker at the start of a line. */
export function normalizeOrderedMarkerEscape(text: string): string {
	return text.replace(/^(\s*)(\d+)\\\.(\s)/, "$1$2.$3");
}

/** Strip inline markdown to plain text for PDF rendering. */
function stripInlineMarkdown(text: string): string {
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
			.replace(/__(.+?)__/g, "$1")
			.replace(/\*(.+?)\*/g, "$1")
			.replace(/_(.+?)_/g, "$1")
			.replace(/`([^`]+)`/g, "$1")
	);
}

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
async function getImageDimensions(
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
async function tryAddPdfImage(
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
 * Render a mermaid diagram to a PNG data URL using beautiful-mermaid + canvas.
 * Uses concrete colors (not CSS variables) suitable for static export.
 * Returns null if rendering fails.
 */
/** Convert an SVG string to a PNG data URL via canvas. */
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
async function svgToPng(
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
 * Render a mermaid diagram to a PNG data URL.
 * Tries beautiful-mermaid first (flowchart, sequence, class, state, ER),
 * falls back to native mermaid.js for ALL other types (C4, mindmap, gantt, pie, etc.)
 */
export async function renderMermaidToPng(
	code: string,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
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
		mermaid.initialize({
			startOnLoad: false,
			theme: "default",
			securityLevel: "loose",
			fontFamily: "Helvetica, sans-serif",
		});
		const id = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const { svg } = await mermaid.render(id, code.trim());
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

	const lines = content.split("\n");
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

/**
 * Try to convert a data URL or fetch an HTTP image to a Uint8Array for DOCX embedding.
 * Reads the real image dimensions and scales to fit within the DOCX page width (~6 inches = 576px).
 * Returns null if it cannot be loaded.
 */
async function tryLoadImageBytes(
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

	const lines = content.split("\n");
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
