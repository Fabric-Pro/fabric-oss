/**
 * The frame PDF export renders tenant-authored HTML in a real Chromium, so
 * the page is treated as hostile: JavaScript off, offline, every request
 * aborted before it leaves the browser, and active content stripped from
 * `html` blocks beforehand. These pin all four.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock, newContextMock, routeMock, setContentMock } = vi.hoisted(
	() => ({
		launchMock: vi.fn(),
		newContextMock: vi.fn(),
		routeMock: vi.fn(),
		setContentMock: vi.fn(),
	}),
);

vi.mock("playwright", () => ({
	chromium: { launch: launchMock },
}));

import {
	generatePDFActivity,
	PDF_EXPORT_CONTEXT_OPTIONS,
	PDF_TEMPLATE_UTILITY_CSS,
} from "../src/activities/frame-export/generate-pdf";
import { sanitizeFrameHtml } from "../src/activities/frame-export/sanitize-frame-html";

function frame(blocks: Array<{ type: string; content: string }>) {
	return {
		title: "Export",
		description: "A frame",
		blocks,
		theme: { mode: "light" },
	} as unknown as Parameters<typeof generatePDFActivity>[0]["content"];
}

beforeEach(() => {
	vi.clearAllMocks();
	const page = {
		setContent: setContentMock.mockResolvedValue(undefined),
		pdf: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
	};
	const context = {
		route: routeMock.mockResolvedValue(undefined),
		newPage: vi.fn(async () => page),
	};
	newContextMock.mockResolvedValue(context);
	launchMock.mockResolvedValue({
		newContext: newContextMock,
		close: vi.fn(async () => undefined),
	});
});

describe("generatePDFActivity", () => {
	it("renders in a context with JavaScript off, offline and service workers blocked", async () => {
		await generatePDFActivity({
			content: frame([{ type: "markdown", content: "hello" }]),
			orientation: "portrait",
		});
		expect(PDF_EXPORT_CONTEXT_OPTIONS).toEqual({
			javaScriptEnabled: false,
			offline: true,
			serviceWorkers: "block",
		});
		expect(newContextMock).toHaveBeenCalledWith(PDF_EXPORT_CONTEXT_OPTIONS);
	});

	it("aborts every request the page makes, before the content is set", async () => {
		const order: string[] = [];
		routeMock.mockImplementation(async () => {
			order.push("route");
		});
		setContentMock.mockImplementation(async () => {
			order.push("setContent");
		});
		await generatePDFActivity({
			content: frame([{ type: "markdown", content: "hello" }]),
			orientation: "portrait",
		});
		expect(order).toEqual(["route", "setContent"]);
		const [pattern, handler] = routeMock.mock.calls[0] as [
			string,
			(route: { abort: (code: string) => Promise<void> }) => unknown,
		];
		expect(pattern).toBe("**/*");
		const route = { abort: vi.fn(async () => undefined) };
		await handler(route);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
	});

	it("strips script and handlers from html blocks and loads no external script of its own", async () => {
		await generatePDFActivity({
			content: frame([
				{
					type: "html",
					content:
						'<div onclick="steal()"><script>fetch("http://169.254.169.254/")</script><a href="javascript:alert(1)">x</a><p>kept</p></div>',
				},
			]),
			orientation: "landscape",
		});
		const [html] = setContentMock.mock.calls[0] as [string];
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/onclick/i);
		expect(html).not.toMatch(/javascript:/i);
		expect(html).not.toContain("cdn.tailwindcss.com");
		expect(html).toContain("<p>kept</p>");
	});
});

describe("PDF template styling", () => {
	async function renderedHtml(theme: Record<string, unknown> = {}) {
		await generatePDFActivity({
			content: {
				...frame([{ type: "markdown", content: "hello" }]),
				theme: { mode: "light", ...theme },
			} as unknown as Parameters<
				typeof generatePDFActivity
			>[0]["content"],
			orientation: "portrait",
		});
		return (setContentMock.mock.calls.at(-1) as [string])[0];
	}

	it("inlines CSS for every utility class the template emits, so it renders styled offline", async () => {
		const html = await renderedHtml();
		expect(html).toContain(PDF_TEMPLATE_UTILITY_CSS);

		const style = html.slice(
			html.indexOf("<style>"),
			html.indexOf("</style>"),
		);
		const templateClasses = new Set(
			[...html.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
				m[1].split(/\s+/),
			),
		);
		// Classes the stylesheet defines itself or that carry no styling.
		const unstyledByDesign = new Set(["markdown-content", "mermaid"]);
		for (const name of templateClasses) {
			if (unstyledByDesign.has(name)) {
				continue;
			}
			expect(style, `no CSS for .${name}`).toContain(`.${name} {`);
		}
		expect(templateClasses).toContain("text-gray-600");
		expect(templateClasses).toContain("mb-4");
	});

	it("emits no external stylesheet, script or import", async () => {
		const html = await renderedHtml();
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<link/i);
		expect(html).not.toMatch(/@import/i);
		expect(html).not.toMatch(/https?:\/\//i);
	});

	it("accepts a hex accent colour and replaces anything else with the default", async () => {
		expect(await renderedHtml({ accentColor: "#B91C1C" })).toContain(
			"color: #B91C1C;",
		);
		const injected = await renderedHtml({
			accentColor: "red; } @import url(http://10.0.0.1/x.css); h1 {",
		});
		expect(injected).not.toContain("@import");
		expect(injected).toContain("color: #3b82f6;");
	});
});

describe("sanitizeFrameHtml", () => {
	it("removes script elements, closed, unclosed and mixed-case", () => {
		expect(
			sanitizeFrameHtml(
				'<p>a</p><SCRIPT type="module">evil()</SCRIPT><p>b</p><script src="//x.example.com/e.js">',
			),
		).toBe("<p>a</p><p>b</p>");
	});

	it("removes frames, objects, embeds and svg with their content", () => {
		expect(
			sanitizeFrameHtml(
				'<iframe src="http://10.0.0.1/"></iframe><object data="x"></object><embed src="y"><svg onload="e()"><a/></svg><p>ok</p>',
			),
		).toBe("<p>ok</p>");
	});

	it("removes link, meta, base and form elements that load or redirect", () => {
		expect(
			sanitizeFrameHtml(
				'<link rel="stylesheet" href="http://10.0.0.1/a.css"><meta http-equiv="refresh" content="0;url=http://10.0.0.1/"><base href="http://10.0.0.1/"><form action="http://10.0.0.1/"><input name="a"></form><p>ok</p>',
			),
		).toBe("<p>ok</p>");
	});

	it("removes inline event handlers in every quoting style", () => {
		expect(
			sanitizeFrameHtml(
				`<div onclick="a()" onMouseOver='b()' onload=c()>x</div>`,
			),
		).toBe("<div>x</div>");
	});

	it("removes javascript:, vbscript: and html data: URLs, including obfuscated ones, and keeps ordinary ones", () => {
		expect(
			sanitizeFrameHtml(
				`<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a><a href="java&#x09;script:alert(1)">c</a><img src="vbscript:x"><a href="data:text/html,<script>1</script>">d</a><a href="https://example.com/">e</a>`,
			),
		).toBe(
			'<a>a</a><a>b</a><a>c</a><img><a>d</a><a href="https://example.com/">e</a>',
		);
	});

	it("removes styles that carry expressions or fetches", () => {
		expect(
			sanitizeFrameHtml(
				`<div style="background:url(http://10.0.0.1/x.png)">a</div><div style="width:expression(alert(1))">b</div><div style="color:red">c</div>`,
			),
		).toBe('<div>a</div><div>b</div><div style="color:red">c</div>');
	});
});
