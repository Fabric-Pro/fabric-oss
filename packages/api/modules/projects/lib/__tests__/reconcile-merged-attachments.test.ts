import { describe, expect, it } from "vitest";
import {
	reconcileMergedDescriptionAttachments,
	stripStoryMediaImages,
} from "../reconcile-merged-attachments";

const PROJECT = "proj-1";
const SURVIVOR = "s1";
const DUPLICATE = "s2";
const ownKey = "story-media/proj-1/s1/shot.png";
const foreignKey = "story-media/proj-1/s2/diagram.png";
/**
 * The key the duplicate's image lives at AFTER the merge copied the object into
 * the survivor's keyspace — what `copyStoryAssetsToStory` hands back and what
 * `carriedMediaKeys` receives. Never the duplicate's original key.
 */
const carriedKey = `story-media/${PROJECT}/${SURVIVOR}/merged-${DUPLICATE}-diagram.png`;

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("stripStoryMediaImages", () => {
	it("removes a markdown image referencing story-media", () => {
		const out = stripStoryMediaImages(`Hello ![a](${ownKey}) world`);
		expect(out).not.toContain("story-media/");
		expect(out).toContain("Hello");
		expect(out).toContain("world");
	});

	it("removes an HTML <img> with a data-s3-key", () => {
		const out = stripStoryMediaImages(
			`<p>Text</p><img src="x" data-s3-key="${ownKey}">`,
		);
		expect(out).not.toContain("story-media/");
		expect(out).toContain("Text");
	});

	it("removes a bare story-media URL substring", () => {
		const out = stripStoryMediaImages(`see ${foreignKey} here`);
		expect(out).not.toContain("story-media/");
	});

	it("leaves non-story-media images untouched", () => {
		const out = stripStoryMediaImages(
			"![ext](https://example.com/a.png) keep me",
		);
		expect(out).toContain("example.com/a.png");
		expect(out).toContain("keep me");
	});

	it("returns empty string for null/undefined/empty", () => {
		expect(stripStoryMediaImages(null)).toBe("");
		expect(stripStoryMediaImages(undefined)).toBe("");
		expect(stripStoryMediaImages("")).toBe("");
	});
});

describe("reconcileMergedDescriptionAttachments", () => {
	it("re-appends a survivor-own attachment the AI dropped", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: "Combined description text.",
			survivorPriorDescription: `Old text.\n\n![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
		});
		expect(out).toContain(ownKey);
		expect(out).toContain("Combined description text.");
		expect(out).toContain("## Attachments");
	});

	it("strips a cross-story (duplicate) attachment that would 404 on the survivor", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: `Combined.\n\n![d](${foreignKey})`,
			survivorPriorDescription: null,
			projectId: PROJECT,
			survivorId: SURVIVOR,
		});
		expect(out).not.toContain(foreignKey);
		expect(out).toContain("Combined.");
	});

	it("does not duplicate a survivor-own key already present (idempotent set)", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: `Combined ![s](${ownKey}) inline.`,
			survivorPriorDescription: `![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
		});
		expect(occurrences(out, ownKey)).toBe(1);
	});

	it("leaves clean text unchanged when the survivor has no attachments", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: "Just requirements, no media.",
			survivorPriorDescription: "Also no media.",
			projectId: PROJECT,
			survivorId: SURVIVOR,
		});
		expect(out).toBe("Just requirements, no media.");
	});

	it("keeps the survivor's image even when the merged text is only-media", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: `![s](${ownKey})`,
			survivorPriorDescription: `![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
		});
		expect(out).toContain(ownKey);
		expect(occurrences(out, ownKey)).toBe(1);
	});

	it("is idempotent across repeated runs (no key growth)", () => {
		const first = reconcileMergedDescriptionAttachments({
			mergedDescription: "Combined.",
			survivorPriorDescription: `Old ![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
		});
		const second = reconcileMergedDescriptionAttachments({
			mergedDescription: first,
			survivorPriorDescription: `Old ![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
		});
		expect(occurrences(second, ownKey)).toBe(1);
	});
});

/**
 * Fizzy #2048 — the duplicate's inline images now survive the merge. The merge
 * copies each of the duplicate's objects into the survivor's keyspace first and
 * passes the NEW keys here; this function's job is to write both items' keys and
 * still emit nothing outside the survivor's prefix.
 *
 * The duplicate's ORIGINAL keys are still stripped (covered above) — they are
 * unreadable on the survivor. What changed is that a carried key now takes their
 * place instead of the image being dropped.
 */
describe("reconcileMergedDescriptionAttachments — carried duplicate media", () => {
	it("keeps the survivor's images when only it has any", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: "Combined description text.",
			survivorPriorDescription: `Old ![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: [],
		});
		expect(occurrences(out, ownKey)).toBe(1);
		expect(out).toContain("Combined description text.");
	});

	it("references the copied key when only the duplicate has images", () => {
		const out = reconcileMergedDescriptionAttachments({
			// The AI text still carries the duplicate's ORIGINAL key — unreadable
			// on the survivor, so it must be replaced by the copied one.
			mergedDescription: `Combined.\n\n![d](${foreignKey})`,
			survivorPriorDescription: "Survivor had no media.",
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: [carriedKey],
		});
		expect(out).toContain(carriedKey);
		expect(out).not.toContain(foreignKey);
		expect(out).toContain("## Attachments");
	});

	it("keeps both items' images, each exactly once", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: `Combined ![s](${ownKey}) and ![d](${foreignKey}).`,
			survivorPriorDescription: `Old ![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: [carriedKey],
		});
		expect(occurrences(out, ownKey)).toBe(1);
		expect(occurrences(out, carriedKey)).toBe(1);
		expect(out).not.toContain(foreignKey);
	});

	it("does not collide the survivor's key with the carried one", () => {
		// Same source filename on both sides — the `merged-{duplicateId}-` marker
		// is what keeps the two objects (and the two references) distinct.
		const sameName = `story-media/${PROJECT}/${SURVIVOR}/shot.png`;
		const carriedSameName = `story-media/${PROJECT}/${SURVIVOR}/merged-${DUPLICATE}-shot.png`;
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: "Combined.",
			survivorPriorDescription: `![s](${sameName})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: [carriedSameName],
		});
		expect(out).toContain(carriedSameName);
		expect(out).toContain(`](${sameName})`);
	});

	it("writes nothing for a carried key outside the survivor's prefix", () => {
		// Defence in depth: the copy helper only ever returns survivor-scoped
		// keys, but this function is the single guarantee that the persisted body
		// references nothing else.
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: "Combined.",
			survivorPriorDescription: null,
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: ["story-media/other-proj/other-story/leak.png"],
		});
		expect(out).toBe("Combined.");
		expect(out).not.toContain("leak.png");
	});

	it("writes a carried key that repeats an own key only once", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: "Combined.",
			survivorPriorDescription: `![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: [ownKey],
		});
		expect(occurrences(out, ownKey)).toBe(1);
	});

	it("stays idempotent with carried keys (no key growth)", () => {
		const params = {
			survivorPriorDescription: `Old ![s](${ownKey})`,
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: [carriedKey],
		};
		const first = reconcileMergedDescriptionAttachments({
			mergedDescription: "Combined.",
			...params,
		});
		const second = reconcileMergedDescriptionAttachments({
			mergedDescription: first,
			...params,
		});
		expect(occurrences(second, ownKey)).toBe(1);
		expect(occurrences(second, carriedKey)).toBe(1);
	});

	it("behaves exactly as before when neither item has media", () => {
		const out = reconcileMergedDescriptionAttachments({
			mergedDescription: "Just requirements, no media.",
			survivorPriorDescription: "Also no media.",
			projectId: PROJECT,
			survivorId: SURVIVOR,
			carriedMediaKeys: [],
		});
		expect(out).toBe("Just requirements, no media.");
	});
});
