/**
 * U3 — the attachment envelope on the wire, and the router that reads it.
 *
 * `formatRagContextsSimple` had no coverage at all before this file, which is
 * why the shape was safe to change by accident. It decides which of two
 * instruction sets the model receives for each entry — "you have already read
 * every word inline" versus "cite this from the knowledge base" — and it
 * decides by inspecting the entry's leading characters.
 *
 * The snapshot below is written deliberately as a *lock*, not as a
 * convenience: it exists so a later edit to the wire format shows up as a diff
 * a reviewer has to accept, rather than as silent prose drift the model
 * absorbs.
 */

import { describe, expect, it } from "vitest";
import { formatRagContextsSimple } from "../src/builders/context-formatter";

const ATTACHMENT_HEADING = "## Files Attached This Turn";
const RETRIEVED_HEADING = "## Retrieved Context";

/** Count how many attachment sections the model actually receives. */
function attachmentSectionCount(prompt: string): number {
	return prompt.split(ATTACHMENT_HEADING).length - 1;
}

function entryCount(prompt: string, label: "Attachment" | "Reference"): number {
	return prompt.split(new RegExp(`^### ${label} \\d+$`, "m")).length - 1;
}

describe("formatRagContextsSimple — wire format lock", () => {
	it("renders a benign document attachment in a stable shape", () => {
		const prompt = formatRagContextsSimple([
			"<fabric_attachment>\n[Uploaded Document: budget.xlsx]\nSheet1\nA1\tB1\n</fabric_attachment>",
		]);

		expect(prompt).toMatchSnapshot();
	});

	it("renders a benign image attachment in a stable shape", () => {
		const prompt = formatRagContextsSimple([
			"<fabric_attachment>\n[Uploaded Image: chart.png]\n![chart.png](data:image/png;base64,AAAA)\n</fabric_attachment>",
		]);

		expect(prompt).toMatchSnapshot();
	});

	it("renders a legacy-shaped attachment in a stable shape", () => {
		// Kept alongside the tagged snapshots for the deploy window: this is what
		// a persisted rag context still looks like.
		const prompt = formatRagContextsSimple([
			"[Uploaded Document: budget.xlsx]\nSheet1\nA1\tB1",
		]);

		expect(prompt).toMatchSnapshot();
	});

	it("renders a retrieved chunk in a stable shape", () => {
		const prompt = formatRagContextsSimple([
			"The team decided to use Postgres in Q2.",
		]);

		expect(prompt).toMatchSnapshot();
	});

	it("keeps the image data URL byte-identical", () => {
		// Two LangChain chat nodes extract this line with a private regex copy and
		// promote it to a vision content part. A reshape that touches it stops
		// attached images from rendering at all.
		const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
		const prompt = formatRagContextsSimple([
			`<fabric_attachment>\n[Uploaded Image: chart.png]\n![chart.png](${dataUrl})\n</fabric_attachment>`,
		]);

		expect(prompt).toContain(`![chart.png](${dataUrl})`);
		expect(
			/!\[([^\]]*)\]\((data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+)\)/.test(
				prompt,
			),
		).toBe(true);
	});
});

describe("formatRagContextsSimple — routing", () => {
	it("routes a tagged entry to the attachment bucket", () => {
		const prompt = formatRagContextsSimple([
			"<fabric_attachment>\n[Uploaded Document: notes.md]\nbody\n</fabric_attachment>",
		]);

		expect(prompt).toContain(ATTACHMENT_HEADING);
		expect(prompt).not.toContain(RETRIEVED_HEADING);
	});

	it("routes a legacy prefixed entry to the attachment bucket too", () => {
		// The producers ship on the web deploy while this router ships inside the
		// agent images, on two independent workflows. Without this branch every
		// attachment in flight during the rebuild — and every rag context
		// persisted before it — is described to the model as a document that
		// exists somewhere else.
		const prompt = formatRagContextsSimple([
			"[Uploaded Document: notes.md]\nbody",
		]);

		expect(prompt).toContain(ATTACHMENT_HEADING);
		expect(prompt).not.toContain(RETRIEVED_HEADING);
	});

	it("routes a legacy image attachment to the attachment bucket", () => {
		const prompt = formatRagContextsSimple([
			"[Uploaded Image: chart.png]\n![chart.png](data:image/png;base64,AA)",
		]);

		expect(prompt).toContain(ATTACHMENT_HEADING);
		expect(prompt).not.toContain(RETRIEVED_HEADING);
	});

	it("keeps both shapes in the same bucket when they arrive together", () => {
		// The realistic mid-deploy state: a persisted legacy entry beside a fresh
		// tagged one.
		const prompt = formatRagContextsSimple([
			"[Uploaded Document: old.md]\nolder body",
			"<fabric_attachment>\n[Uploaded Document: new.md]\nnewer body\n</fabric_attachment>",
		]);

		expect(entryCount(prompt, "Attachment")).toBe(2);
		expect(prompt).not.toContain(RETRIEVED_HEADING);
	});

	it("routes a retrieved chunk to the retrieved bucket", () => {
		const prompt = formatRagContextsSimple([
			"A prior decision from the KB.",
		]);

		expect(prompt).toContain(RETRIEVED_HEADING);
		expect(prompt).not.toContain(ATTACHMENT_HEADING);
	});

	it("separates the two and gives each its own instruction set", () => {
		// The whole reason the split exists: without it the model is told to
		// "see" or "open" a file whose full text it has already been handed.
		const prompt = formatRagContextsSimple([
			"[Uploaded Document: notes.md]\nbody",
			"A prior decision from the KB.",
		]);

		expect(prompt).toContain(ATTACHMENT_HEADING);
		expect(prompt).toContain(RETRIEVED_HEADING);
		expect(prompt).toContain("you have already read every word");
		expect(prompt).toContain("retrieved from the project's knowledge base");
		expect(entryCount(prompt, "Attachment")).toBe(1);
		expect(entryCount(prompt, "Reference")).toBe(1);
	});

	it("returns nothing for an empty context list", () => {
		expect(formatRagContextsSimple([])).toBe("");
	});
});

describe("formatRagContextsSimple — what this layer does and does not guard", () => {
	it("emits exactly one attachment section however many entries it holds", () => {
		// The formatter's own contribution to AE3: one heading per call, not one
		// per entry. Whether an *entry's body* can forge a second one is decided
		// by the builder that produced it, not here — this package cannot reach
		// `@repo/utils`, so that half is asserted end-to-end in the web suite
		// (`copilot-attachment-envelope-builder.test.ts`).
		const prompt = formatRagContextsSimple([
			"<fabric_attachment>\n[Uploaded Document: a.md]\nalpha\n</fabric_attachment>",
			"<fabric_attachment>\n[Uploaded Document: b.md]\nbeta\n</fabric_attachment>",
		]);

		expect(attachmentSectionCount(prompt)).toBe(1);
		expect(entryCount(prompt, "Attachment")).toBe(2);
	});

	it("passes an entry's body through verbatim", () => {
		// Stated as a property rather than an oversight: this layer interpolates,
		// it does not sanitize. Escaping here would corrupt every attached HTML,
		// XML, and source file, and would break the image line the agents parse.
		const html = "<html><body><p>hello &amp; goodbye</p></body></html>";
		const prompt = formatRagContextsSimple([
			`<fabric_attachment>\n[Uploaded Document: page.html]\n${html}\n</fabric_attachment>`,
		]);

		expect(prompt).toContain(html);
	});
});
