/**
 * Generate PDF Activity
 *
 * Renders frame content to PDF using Playwright.
 */

import type { FrameDocument } from "@repo/database";
import { chromium } from "playwright";

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
					return block.content;
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
	const accentColor = document.theme?.accentColor || "#3b82f6";

	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(document.title)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
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
		const context = await browser.newContext();
		const page = await context.newPage();

		// Render HTML content
		const html = renderFrameToHTML(input.content);
		await page.setContent(html, { waitUntil: "networkidle" });

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
