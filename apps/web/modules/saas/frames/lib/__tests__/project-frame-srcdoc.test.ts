import { describe, expect, it } from "vitest";
import {
	buildProjectFrameSrcdoc,
	isProjectFrameHeightMessage,
	PROJECT_FRAME_CSP,
	PROJECT_FRAME_HEIGHT_MESSAGE,
	PROJECT_FRAME_SANDBOX,
} from "../project-frame-srcdoc";

const CSP_META_PATTERN =
	/<head><meta http-equiv="Content-Security-Policy" content="([^"]+)">/;

describe("buildProjectFrameSrcdoc", () => {
	it("injects the CSP meta as the first child of head", () => {
		const out = buildProjectFrameSrcdoc("<p>hello</p>");
		const match = out.match(CSP_META_PATTERN);
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe(PROJECT_FRAME_CSP);
		expect(out.startsWith("<!doctype html><html><head>")).toBe(true);
	});

	it("never grants same-origin in the sandbox constant", () => {
		expect(PROJECT_FRAME_SANDBOX.split(/\s+/)).not.toContain(
			"allow-same-origin",
		);
		expect(PROJECT_FRAME_CSP).toContain("default-src 'none'");
	});

	it("removes nested iframes and other browsing contexts", () => {
		const out = buildProjectFrameSrcdoc(
			[
				"<div>before</div>",
				'<iframe src="https://evil.example" sandbox="allow-same-origin"></iframe>',
				'<object data="https://evil.example/x.swf"></object>',
				'<embed src="https://evil.example/x.svg">',
				'<base href="https://evil.example/">',
				"<div>after</div>",
			].join(""),
		);
		expect(out).not.toMatch(/<iframe/i);
		expect(out).not.toMatch(/<object/i);
		expect(out).not.toMatch(/<embed/i);
		expect(out).not.toMatch(/<base/i);
		expect(out).toContain("<div>before</div>");
		expect(out).toContain("<div>after</div>");
	});

	it("keeps author scripts and inline styles (scripts are allowed by the CSP)", () => {
		const out = buildProjectFrameSrcdoc(
			'<style>body{color:red}</style><script>window.__demo = 1;</script><p id="a">x</p>',
		);
		expect(out).toContain("<style>body{color:red}</style>");
		expect(out).toContain("<script>window.__demo = 1;</script>");
		expect(out).toContain('<p id="a">x</p>');
	});

	it("preserves head styles from a full document", () => {
		const out = buildProjectFrameSrcdoc(
			"<!doctype html><html><head><title>Demo</title><style>h1{margin:0}</style></head><body><h1>Demo</h1></body></html>",
		);
		const headEnd = out.indexOf("</head>");
		const styleAt = out.indexOf("<style>h1{margin:0}</style>");
		expect(styleAt).toBeGreaterThan(-1);
		expect(styleAt).toBeLessThan(headEnd);
		expect(out).toContain("<h1>Demo</h1>");
	});

	it("neutralises look-alike </script> breakouts", () => {
		const out = buildProjectFrameSrcdoc(
			[
				"<script>var s = 'ok';</script >",
				'<img src="x" onerror="alert(1)">',
				'<script>var t = "</scr" + "ipt>";</script>',
				"<script><!--<script>x=1;</script>alert(2)--></script>",
				"<p>tail</p>",
			].join(""),
		);
		// Event handler attributes never survive.
		expect(out).not.toMatch(/onerror/i);
		// Every remaining `</script` is a real closing tag: count openings and
		// closings and make sure no script *text* contains a closing sequence.
		const opens = out.match(/<script\b/gi) ?? [];
		const closes = out.match(/<\/script/gi) ?? [];
		expect(closes.length).toBe(opens.length);
		const scriptBodies = Array.from(
			out.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
		).map((m) => m[1]);
		for (const body of scriptBodies) {
			expect(body).not.toMatch(/<\/\s*script/i);
		}
		expect(out).toContain("<p>tail</p>");
	});

	it("strips meta and link tags that could rewrite the document", () => {
		const out = buildProjectFrameSrcdoc(
			'<meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/a.css"><p>x</p>',
		);
		expect(out).not.toMatch(/refresh/i);
		expect(out).not.toMatch(/<link/i);
		// Exactly two metas: the injected CSP and the charset.
		expect(out.match(/<meta\b/gi)?.length).toBe(2);
	});

	it("appends the resize reporter that posts the height message", () => {
		const out = buildProjectFrameSrcdoc("<p>x</p>");
		expect(out).toContain(PROJECT_FRAME_HEIGHT_MESSAGE);
		expect(out).toContain("window.parent.postMessage");
		expect(out.trimEnd().endsWith("</script></body></html>")).toBe(true);
	});

	it("tolerates empty input", () => {
		const out = buildProjectFrameSrcdoc("");
		expect(out).toMatch(CSP_META_PATTERN);
		expect(out).toContain("<body>");
	});
});

describe("isProjectFrameHeightMessage", () => {
	it("accepts only well-formed height messages", () => {
		expect(
			isProjectFrameHeightMessage({
				type: PROJECT_FRAME_HEIGHT_MESSAGE,
				height: 640,
			}),
		).toBe(true);
		expect(
			isProjectFrameHeightMessage({
				type: PROJECT_FRAME_HEIGHT_MESSAGE,
				height: "640",
			}),
		).toBe(false);
		expect(
			isProjectFrameHeightMessage({
				type: PROJECT_FRAME_HEIGHT_MESSAGE,
				height: Number.NaN,
			}),
		).toBe(false);
		expect(isProjectFrameHeightMessage({ type: "other" })).toBe(false);
		expect(isProjectFrameHeightMessage(null)).toBe(false);
	});
});
