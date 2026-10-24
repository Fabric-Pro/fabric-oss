import { describe, expect, it } from "vitest";
import { fromMarkdown, mergeOrphanBulletContinuations } from "../diff-utils";

describe("legacy bullet repair inside fenced code", () => {
	const doc =
		"Intro.\n\n```ts\nconst intro = 1\n2. legacy step\nconst done = 2\n```\n\nDone.";

	it("leaves a numbered-looking code line and the next line apart", () => {
		expect(mergeOrphanBulletContinuations(doc)).toBe(doc);
	});

	it("keeps both code lines on their own lines when loaded", () => {
		const html = fromMarkdown(doc);
		expect(html).toContain("2. legacy step\nconst done = 2");
	});

	it("still merges a wrapped bullet outside code", () => {
		expect(
			mergeOrphanBulletContinuations("- first part of\nthe bullet"),
		).toBe("- first part of the bullet");
	});
});
