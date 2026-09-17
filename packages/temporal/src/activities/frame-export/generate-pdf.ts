/**
 * Generate PDF Activity
 *
 * Renders frame content to PDF using Playwright.
 *
 * The content is tenant-authored and `html` blocks are rendered as HTML,
 * so the page is treated as hostile: it is rendered in a context with
 * JavaScript disabled, offline, with every outbound request aborted before
 * it leaves the browser, and after `sanitizeFrameHtml` has stripped script,
 * frames, handlers and script URLs. The export is a static rendering of
 * what the tenant wrote; it is never a way to run code or reach a network
 * from the worker's host.
 */

import type { FrameDocument } from "@repo/database";
import { type BrowserContextOptions, chromium } from "playwright";
import { sanitizeFrameHtml } from "./sanitize-frame-html";

/**
 * The context the export renders in. JavaScript off so nothing in the
 * content executes; offline and service workers blocked so the page has no
 * network path of its own; the catch-all abort route in the activity
 * refuses every request Chromium still tries to make (a stylesheet, an
 * image, a font).
 */
export const PDF_EXPORT_CONTEXT_OPTIONS: BrowserContextOptions = {
	javaScriptEnabled: false,
	offline: true,
	serviceWorkers: "block",
};

export interface GeneratePDFInput {
	content: FrameDocument;
	orientation: "portrait" | "landscape";
}

/**
 * Render frame document to HTML
 */
function renderFrameToHTML(document: FrameDocument): string {
	const blocks = document.blocks
		.map((block) => {
			switch (block.type) {
				case "html":
					return sanitizeFrameHtml(block.content);
				case "markdown":
					// Simple markdown to HTML (in production, use a proper converter)
					return `<div class="markdown-content">${escapeHtml(block.content)}</div>`;
				case "json":
					return `<pre><code>${escapeHtml(JSON.stringify(JSON.parse(block.content), null, 2))}</code></pre>`;
				case "mermaid":
					// Mermaid diagrams would need client-side rendering
					return `<div class="mermaid">${escapeHtml(block.content)}</div>`;
				default:
					return `<div>${escapeHtml(block.content)}</div>`;
			}
		})
		.join("\n");

	const isDark = document.theme?.mode === "dark";
	// The accent colour is written into the style block, so only a hex
	// colour is accepted; anything else falls back to the default.
	const accentColor = safeHexColor(document.theme?.accentColor) ?? "#3b82f6";

	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(document.title)}</title>
  <style>
    @page {
      margin: 20mm;
      size: ${orientationToPageSize(document)};
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: ${isDark ? "#1a1a1a" : "#ffffff"};
      color: ${isDark ? "#ffffff" : "#000000"};
    }
    .frame-container {
      max-width: 100%;
      padding: 2rem;
    }
    h1, h2, h3, h4, h5, h6 {
      color: ${accentColor};
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
    }
    pre {
      background: ${isDark ? "#2d2d2d" : "#f5f5f5"};
      padding: 1rem;
      border-radius: 0.5rem;
      overflow-x: auto;
    }
    code {
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.875rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
    }
    th, td {
      border: 1px solid ${isDark ? "#444" : "#ddd"};
      padding: 0.5rem;
      text-align: left;
    }
    th {
      background: ${isDark ? "#333" : "#f5f5f5"};
    }
${PDF_TEMPLATE_UTILITY_CSS}
  </style>
</head>
<body>
  <div class="frame-container">
    ${document.title ? `<h1>${escapeHtml(document.title)}</h1>` : ""}
    ${document.description ? `<p class="text-gray-600 mb-4">${escapeHtml(document.description)}</p>` : ""}
    ${blocks}
  </div>
</body>
</html>`;
}

/**
 * The Tailwind utility classes this template itself emits, as plain CSS.
 * The export used to load the Tailwind CDN script to style them; the page
 * now renders with JavaScript off and no network, so the few utilities the
 * template uses are inlined with Tailwind's values. Tailwind classes that
 * tenant-authored frame HTML uses are not styled.
 */
export const PDF_TEMPLATE_UTILITY_CSS = `    .text-gray-600 {
      color: rgb(75 85 99);
    }
    .mb-4 {
      margin-bottom: 1rem;
    }`;

function safeHexColor(value: string | undefined): string | undefined {
	return value && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
		? value
		: undefined;
}

function escapeHtml(text: string): string {
	const _div = { toString: () => text };
	// Simple HTML escaping
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#x27;");
}

function orientationToPageSize(_document: FrameDocument): string {
	// Default to A4
	return "A4";
}

export async function generatePDFActivity(
	input: GeneratePDFInput,
): Promise<Buffer> {
	const browser = await chromium.launch({
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	});

	try {
		const context = await browser.newContext(PDF_EXPORT_CONTEXT_OPTIONS);
		// Nothing the content references is fetched: every request is
		// aborted here, before Chromium resolves or connects anywhere.
		await context.route("**/*", (route) => route.abort("blockedbyclient"));
		const page = await context.newPage();

		// Render HTML content
		const html = renderFrameToHTML(input.content);
		await page.setContent(html, { waitUntil: "load" });

		// Generate PDF
		const pdf = await page.pdf({
			format: "A4",
			landscape: input.orientation === "landscape",
			printBackground: true,
			margin: {
				top: "20px",
				right: "20px",
				bottom: "20px",
				left: "20px",
			},
		});

		return Buffer.from(pdf);
	} finally {
		await browser.close();
	}
}
