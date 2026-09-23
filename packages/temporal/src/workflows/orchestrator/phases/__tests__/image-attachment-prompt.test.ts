/**
 * Orchestrator image prompt (Fizzy #2040, F35).
 *
 * The iterative loop told a vision model it MUST search for image tools and
 * must NOT describe an attached image, so it refused to look at pixels it had.
 * The new wording ships behind `orch-image-vision-prompt-v1`; the unpatched
 * wording must stay byte-identical so recorded histories replay as they ran.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	attachedImagesSystemNote,
	attachedImagesUserNote,
} from "../image-attachment-prompt";

const paths = ["org-1/images/a.png", "org-1/images/b.png"];

describe("attached image prompt — unpatched", () => {
	it("keeps the original user note byte for byte", () => {
		expect(attachedImagesUserNote(paths, false)).toBe(
			"\n\n[ATTACHED IMAGES: 2 image(s). Storage paths: org-1/images/a.png, org-1/images/b.png. Use fabric_generate_image with the storage path as inputImage parameter for image editing/modification tasks.]",
		);
	});

	it("keeps the original system note byte for byte", () => {
		expect(attachedImagesSystemNote(false)).toBe(
			`\n\nIMPORTANT: The user has attached image(s). You MUST use the search_tools function to find image generation/editing tools (e.g. search for "image generation") before responding. Do NOT describe images textually — use the discovered tool to process or generate images.`,
		);
	});
});

describe("attached image prompt — patched", () => {
	const system = attachedImagesSystemNote(true);

	it("lets the model analyse what it can see", () => {
		expect(system).toMatch(/describe, read or analyse it directly/);
		expect(system).not.toMatch(/Do NOT describe images/);
		expect(system).not.toMatch(/MUST use the search_tools/);
	});

	it("keeps image tools for creating or modifying an image", () => {
		expect(system).toMatch(
			/only when the user asks you to create a new image or modify/,
		);
	});

	it("falls back to the description when no pixels arrived", () => {
		expect(system).toMatch(
			/If it is not included, work from the attached description/,
		);
	});

	it("still hands over the storage paths, for edits only", () => {
		const note = attachedImagesUserNote(paths, true);
		expect(note).toContain("org-1/images/a.png, org-1/images/b.png");
		expect(note).toMatch(/only for image tools/);
	});
});

describe("iterative loop wiring", () => {
	const source = readFileSync(
		join(
			process.cwd(),
			"src/workflows/orchestrator/phases/iterative-execution.ts",
		),
		"utf-8",
	);

	it("gates the new wording on its own marker", () => {
		expect(source).toMatch(
			/const imageVisionPrompt = input\.attachedImageUrls\?\.length\s*\?\s*patched\("orch-image-vision-prompt-v1"\)\s*:\s*false;/,
		);
		expect(source).toMatch(
			/attachedImagesUserNote\(\s*input\.attachedImageUrls,\s*imageVisionPrompt,?\s*\)/,
		);
		expect(source).toMatch(/attachedImagesSystemNote\(imageVisionPrompt\)/);
	});

	it("no longer inlines either original string", () => {
		expect(source).not.toMatch(/Do NOT describe images textually/);
		expect(source).not.toMatch(
			/Use fabric_generate_image with the storage path as inputImage/,
		);
	});
});
