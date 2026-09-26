/**
 * The frame PDF export renders tenant-authored HTML in a real Chromium, so
 * the page is treated as hostile: JavaScript off, offline, every request
 * aborted before it leaves the browser, and active markup stripped from the
 * joined blocks beforehand. These pin all four. CSS is not sanitised; what
 * it fetches is stopped by the aborted requests, not by the filter.
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

	describe("sanitises the joined blocks, not each block alone", () => {
		async function rendered(blocks: string[]) {
			await generatePDFActivity({
				content: frame(
					blocks.map((content) => ({ type: "html", content })),
				),
				orientation: "portrait",
			});
			return (setContentMock.mock.calls.at(-1) as [string])[0];
		}

		it("removes a handler whose tag opens in the block before", async () => {
			// Joined, the second block's text is an attribute of the first
			// block's `<img`; alone, it starts no attribute.
			const html = await rendered(["<img src=x", 'onerror="alert(1)">']);
			expect(html).not.toMatch(/onerror/i);
			expect(html).toContain("<img src=x>");
		});

		it("removes a URL whose scheme is split across two blocks", async () => {
			// The newline the join adds is dropped from a URL's scheme.
			const html = await rendered([
				'<a href="java',
				'script:alert(1)">x</a>',
			]);
			expect(html).not.toMatch(/href/i);
			expect(html).toContain("<a>x</a>");
		});

		it("removes a dangerous tag closed by the next block", async () => {
			const html = await rendered([
				'<p>before</p><iframe src="http://10.0.0.1/"',
				"></iframe><p>after</p>",
			]);
			expect(html).not.toMatch(/<iframe|10\.0\.0\.1/i);
			expect(html).toContain("<p>before</p><p>after</p>");
		});

		it("removes a dangerous tag left open by the last block", async () => {
			const html = await rendered([
				"<p>ok</p>",
				"<link rel=stylesheet href=http://10.0.0.1/a.css",
			]);
			expect(html).not.toMatch(/<link|10\.0\.0\.1/i);
		});

		it("leaves escaped blocks' text as written", async () => {
			await generatePDFActivity({
				content: frame([
					{ type: "html", content: "<p>ok</p>" },
					{
						type: "markdown",
						content: "set online = true and href=javascript:x",
					},
				]),
				orientation: "portrait",
			});
			const html = (setContentMock.mock.calls.at(-1) as [string])[0];
			expect(html).toContain(
				'<div class="markdown-content">set online &#61; true and href&#61;javascript:x</div>',
			);
		});
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

	it("removes an inline style that literally names url(, expression( or javascript:, as a best effort", () => {
		expect(
			sanitizeFrameHtml(
				`<div style="background:url(http://10.0.0.1/x.png)">a</div><div style="width:expression(alert(1))">b</div><div style="color:red">c</div>`,
			),
		).toBe('<div>a</div><div>b</div><div style="color:red">c</div>');
	});

	it("reads a literal url( in an unquoted or reference-encoded style, as a best effort", () => {
		expect(
			sanitizeFrameHtml(
				`<div style=background:url(http://10.0.0.1/x)>a</div><div style="background:u&#114;l(http://10.0.0.1/y)">b</div>`,
			),
		).toBe("<div>a</div><div>b</div>");
	});

	it("repeats until a removal no longer reassembles what it removed", () => {
		// One pass removed ` onx="1"`, `<script>` and ` href="javascript:1"`
		// and left the joined text: `onerror=`, a live `<script>` and
		// `href="javascript:…"`.
		expect(
			sanitizeFrameHtml(`<img src="x" o onx="1"nerror="alert(1)">`),
		).toBe('<img src="x">');
		expect(sanitizeFrameHtml("<scr<script>ipt>alert(1)")).toBe("alert(1)");
		expect(
			sanitizeFrameHtml(
				`<a h href="javascript:1"ref="javascript:alert(1)">x</a>`,
			),
		).toBe("<a>x</a>");
	});

	it("drops a block that is still reassembling after the pass limit", () => {
		const nested = `<img${" o".repeat(20)} onx="1"${'nx="1"'.repeat(20)}>`;
		expect(sanitizeFrameHtml(`<p>ok</p>${nested}`)).toBe("");
	});

	it("removes attributes a browser starts without whitespace", () => {
		expect(
			sanitizeFrameHtml(
				`<img src="x"onerror="a()"><img/onerror=b()><a title='t'href="javascript:c()">d</a>`,
			),
		).toBe(`<img src="x"><img/><a title='t'>d</a>`);
	});

	it("reads character references in a URL's scheme the way a browser does", () => {
		expect(
			sanitizeFrameHtml(
				`<a href="javascript&colon;alert(1)">a</a><a href="javascript&#58;alert(1)">b</a><a href="&#106;avascript:alert(1)">c</a><a href="https://example.com/?a=1&amp;b=2">d</a>`,
			),
		).toBe(
			'<a>a</a><a>b</a><a>c</a><a href="https://example.com/?a=1&amp;b=2">d</a>',
		);
	});

	it("keeps raster data: images and removes every other data: URL", () => {
		expect(
			sanitizeFrameHtml(
				`<img src="data:image/png;base64,AAAA"><img src="data:image/jpeg,x"><a href="data:application/xhtml+xml,x">x</a><img src="DATA:image/svg+xml,x"><a href="data:text/plain,x">y</a>`,
			),
		).toBe(
			'<img src="data:image/png;base64,AAAA"><img src="data:image/jpeg,x"><a>x</a><img><a>y</a>',
		);
	});

	it("removes a dangerous tag left unterminated at the end of the block", () => {
		// Left in place, the markup after the block would supply its `>`.
		expect(
			sanitizeFrameHtml('<p>ok</p><iframe src="http://10.0.0.1/"'),
		).toBe("<p>ok</p>");
		expect(sanitizeFrameHtml("<p>ok</p><link rel=stylesheet")).toBe(
			"<p>ok</p>",
		);
	});

	it("sanitises hostile blocks in linear time", () => {
		// Each input took seconds: a leading `\s+` was retried from every
		// position of the run, and a tag scan restarted from every opening tag
		// with no `>` or no close after it.
		for (const html of [
			`<p${"\t".repeat(100_000)}x>`,
			"<script ".repeat(20_000),
			"<script>".repeat(20_000),
			"<link ".repeat(25_000),
		]) {
			const started = performance.now();
			sanitizeFrameHtml(html);
			expect(performance.now() - started).toBeLessThan(1000);
		}
	});
});
