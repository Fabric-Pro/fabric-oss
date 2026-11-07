import { describe, expect, it } from "vitest";
import { FrameDocumentSchema } from "../prisma/queries/frame-document";

const document = {
	version: 1,
	kind: "frame",
	title: "Example interface",
	blocks: [{ id: "page", type: "html", content: "<main>Example</main>" }],
	metadata: { runtime: { tools: ["fabric_list_projects"] } },
};

describe("Frame presentation document contract", () => {
	it("preserves absent presentation through legacy JSON round trips", () => {
		const saved = FrameDocumentSchema.parse(document);
		expect(saved).not.toHaveProperty("presentation");
		expect(
			FrameDocumentSchema.parse(JSON.parse(JSON.stringify(saved))),
		).not.toHaveProperty("presentation");
	});
	it.each(["DOCUMENT", "INTERFACE"])(
		"retains %s without modifying runtime tool grants",
		(presentation) => {
			const saved = FrameDocumentSchema.parse({
				...document,
				presentation,
			});
			expect(saved.presentation).toBe(presentation);
			expect(saved.metadata?.runtime).toEqual(document.metadata.runtime);
		},
	);
	it.each(["interface", "EXECUTABLE", null, 1])(
		"rejects invalid presentation %j",
		(presentation) => {
			expect(
				FrameDocumentSchema.safeParse({ ...document, presentation })
					.success,
			).toBe(false);
		},
	);
});
