import { describe, expect, it } from "vitest";
import {
	injectOrgIdIntoExcalidrawEmbeds,
	injectOrgIdIntoToolArgs,
} from "../utils/excalidraw-embed-org-id";

const ORG = "cmk2vodzs00067nm6b4f9kf6o";

describe("injectOrgIdIntoExcalidrawEmbeds", () => {
	it("adds data-organization-id when the tag has none (the real bug)", () => {
		// Exact shape the agent emitted on staging (missing org id).
		const input =
			'<excalidraw-embed data-resource-uri="ui://excalidraw/mcp-app.html" data-config-id="cmolzp6dx000004jrdkhtl5mh" data-checkpoint-id="b9017210629d4f9c9a"></excalidraw-embed>';
		const out = injectOrgIdIntoExcalidrawEmbeds(input, ORG);
		expect(out).toContain(`data-organization-id="${ORG}"`);
		// preserves the attrs the model emitted
		expect(out).toContain('data-config-id="cmolzp6dx000004jrdkhtl5mh"');
		expect(out).toContain('data-checkpoint-id="b9017210629d4f9c9a"');
		expect(out).toContain(
			'data-resource-uri="ui://excalidraw/mcp-app.html"',
		);
	});

	it("fills an empty data-organization-id", () => {
		const input =
			'<excalidraw-embed data-config-id="c1" data-checkpoint-id="k1" data-organization-id=""></excalidraw-embed>';
		const out = injectOrgIdIntoExcalidrawEmbeds(input, ORG);
		expect(out).toContain(`data-organization-id="${ORG}"`);
		expect(out).not.toContain('data-organization-id=""');
	});

	it("leaves an existing non-empty org id untouched (idempotent)", () => {
		const input =
			'<excalidraw-embed data-config-id="c1" data-checkpoint-id="k1" data-organization-id="existing-org"></excalidraw-embed>';
		const out = injectOrgIdIntoExcalidrawEmbeds(input, ORG);
		expect(out).toContain('data-organization-id="existing-org"');
		expect(out).not.toContain(ORG);
		// running twice is stable
		expect(injectOrgIdIntoExcalidrawEmbeds(out, ORG)).toBe(out);
	});

	it("stamps every embed when there are multiple", () => {
		const input = `<p>one</p><excalidraw-embed data-config-id="a" data-checkpoint-id="x"></excalidraw-embed><p>two</p><excalidraw-embed data-config-id="b" data-checkpoint-id="y"></excalidraw-embed>`;
		const out = injectOrgIdIntoExcalidrawEmbeds(input, ORG);
		expect(
			out.match(new RegExp(`data-organization-id="${ORG}"`, "g")),
		).toHaveLength(2);
	});

	it("is a no-op when there is no embed, no org id, or empty text", () => {
		const noEmbed = "<p>just text, no diagram</p>";
		expect(injectOrgIdIntoExcalidrawEmbeds(noEmbed, ORG)).toBe(noEmbed);
		const withEmbed =
			'<excalidraw-embed data-config-id="c1" data-checkpoint-id="k1"></excalidraw-embed>';
		expect(injectOrgIdIntoExcalidrawEmbeds(withEmbed, "")).toBe(withEmbed);
		expect(injectOrgIdIntoExcalidrawEmbeds("", ORG)).toBe("");
	});

	it("running twice on a missing-org tag is stable (idempotent)", () => {
		const input =
			'<excalidraw-embed data-config-id="c1" data-checkpoint-id="k1"></excalidraw-embed>';
		const once = injectOrgIdIntoExcalidrawEmbeds(input, ORG);
		const twice = injectOrgIdIntoExcalidrawEmbeds(once, ORG);
		expect(twice).toBe(once);
		expect(once.match(/data-organization-id/g)).toHaveLength(1);
	});
});

describe("injectOrgIdIntoToolArgs", () => {
	it("stamps the embed in a write_document_local { content } arg", () => {
		const args = {
			content:
				'# Title\n\n<excalidraw-embed data-config-id="c1" data-checkpoint-id="k1"></excalidraw-embed>',
		};
		const out = injectOrgIdIntoToolArgs(args, ORG);
		expect(out.content).toContain(`data-organization-id="${ORG}"`);
	});

	it("stamps embeds in an apply_document_patches { patches: [...] } arg", () => {
		const args = {
			patches: [
				{ op: "replace", anchor: "Flows", content: "intro" },
				{
					op: "insert",
					content:
						'<excalidraw-embed data-config-id="c2" data-checkpoint-id="k2"></excalidraw-embed>',
				},
			],
		};
		const out = injectOrgIdIntoToolArgs(args, ORG);
		expect(JSON.stringify(out)).toContain(
			`data-organization-id=\\"${ORG}\\"`,
		);
		// non-embed strings are left intact
		expect(out.patches[0].content).toBe("intro");
	});

	it("returns args unchanged when org id is empty", () => {
		const args = {
			content:
				'<excalidraw-embed data-config-id="c1" data-checkpoint-id="k1"></excalidraw-embed>',
		};
		expect(injectOrgIdIntoToolArgs(args, "")).toBe(args);
	});

	it("handles nested objects/arrays and non-string leaves safely", () => {
		const args = {
			content:
				'<excalidraw-embed data-config-id="c" data-checkpoint-id="k"></excalidraw-embed>',
			meta: { count: 3, flag: true, nested: { note: null } },
		};
		const out = injectOrgIdIntoToolArgs(args, ORG);
		expect(out.content).toContain(`data-organization-id="${ORG}"`);
		expect(out.meta).toEqual({
			count: 3,
			flag: true,
			nested: { note: null },
		});
	});
});
