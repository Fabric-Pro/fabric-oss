/**
 * Unit tests for `copyStoryAssetsToStory` — the merge-time asset carry-over
 * (Fizzy #2048).
 *
 * The copy port is injected, so no storage provider is constructed and every
 * decision under test (source-key validation, key remapping, per-asset failure
 * isolation) runs for real. Only the logger is mocked, because "the skipped key
 * is logged" is itself a required behaviour: an asset that did not survive a
 * merge is only recoverable if the operator can see which object was left
 * behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { log } = vi.hoisted(() => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/logs", () => ({ logger: log }));

import { copyStoryAssetsToStory } from "../copy-story-assets-to-story";

const PROJECT = "proj-1";
const SURVIVOR = "s1";
const DUPLICATE = "s2";

const dupMediaKey = `story-media/${PROJECT}/${DUPLICATE}/1700000000_ab12cd.png`;
const dupAttachmentKey = `story-attachments/${PROJECT}/${DUPLICATE}/aaaa-bbbb.pdf`;

/** Every argument the copy port saw, flattened for assertion. */
function copySpy() {
	const calls: Array<{ from: string; to: string }> = [];
	const fn = vi.fn(async (from: string, to: string) => {
		calls.push({ from, to });
	});
	return { fn, calls };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("copyStoryAssetsToStory — inline images", () => {
	it("copies the duplicate's own media into the survivor's keyspace", async () => {
		const { fn, calls } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `Repro steps.\n\n![shot](${dupMediaKey})`,
			copyObject: fn,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].from).toBe(dupMediaKey);
		expect(result.media).toHaveLength(1);
		expect(result.media[0].sourceKey).toBe(dupMediaKey);
		expect(result.media[0].targetKey).toBe(calls[0].to);
		expect(result.skipped).toEqual([]);
	});

	it("remaps every copied key under the survivor's own prefix", async () => {
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![shot](${dupMediaKey})`,
			copyObject: fn,
		});
		expect(
			result.media[0].targetKey.startsWith(
				`story-media/${PROJECT}/${SURVIVOR}/`,
			),
		).toBe(true);
	});

	it("produces a key that cannot collide with the survivor's own", async () => {
		// The survivor's generators emit `{timestamp}_{rand}.ext` / `{uuid}.ext`
		// segments; a carried key is always `merged-{duplicateId}-…`, so both
		// items' images coexist even when their source filenames are identical.
		const sameFilename = "1700000000_ab12cd.png";
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![shot](story-media/${PROJECT}/${DUPLICATE}/${sameFilename})`,
			copyObject: fn,
		});
		const survivorOwnKey = `story-media/${PROJECT}/${SURVIVOR}/${sameFilename}`;
		expect(result.media[0].targetKey).not.toBe(survivorOwnKey);
		expect(result.media[0].targetKey).toContain(`merged-${DUPLICATE}-`);
	});

	it("is deterministic — a replayed merge names the same destination key", async () => {
		const { fn } = copySpy();
		const params = {
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![shot](${dupMediaKey})`,
			copyObject: fn,
		};
		const first = await copyStoryAssetsToStory(params);
		const second = await copyStoryAssetsToStory(params);
		expect(second.media[0].targetKey).toBe(first.media[0].targetKey);
	});

	it("preserves the body's key order", async () => {
		const a = `story-media/${PROJECT}/${DUPLICATE}/aaa.png`;
		const b = `story-media/${PROJECT}/${DUPLICATE}/bbb.png`;
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![a](${a})\n\n![b](${b})`,
			copyObject: fn,
		});
		expect(result.media.map((m) => m.sourceKey)).toEqual([a, b]);
	});

	it("copies nothing when the description has no media", async () => {
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: "Just prose, no images.",
			copyObject: fn,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(result).toEqual({ media: [], attachments: [], skipped: [] });
	});

	it("skips the media keyspace entirely when no description is supplied", async () => {
		// The plain-merge shape: no survivor body is written, so there is nowhere
		// for the duplicate's image markdown to land.
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceAttachments: [{ id: "att-1", storageKey: dupAttachmentKey }],
			copyObject: fn,
		});
		expect(result.media).toEqual([]);
		expect(result.attachments).toHaveLength(1);
	});
});

describe("copyStoryAssetsToStory — source-key validation", () => {
	it("refuses a key from another project/story pasted into the body", async () => {
		// Media keys are harvested from free-text markdown any user can write.
		// Copying an unvalidated key would pull a stranger's object into the
		// caller's keyspace, where it would then resolve.
		const foreign = "story-media/other-project/other-story/secret.png";
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `Look at this ![x](${foreign})`,
			copyObject: fn,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(result.media).toEqual([]);
		expect(result.skipped).toEqual([
			{ key: foreign, reason: "foreign-key" },
		]);
	});

	it("refuses a sibling story's key inside the same project", async () => {
		const sibling = `story-media/${PROJECT}/s9/diagram.png`;
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![x](${sibling})`,
			copyObject: fn,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(result.skipped[0]).toEqual({
			key: sibling,
			reason: "foreign-key",
		});
	});

	it("refuses the survivor's own key (it is already where it belongs)", async () => {
		const survivorKey = `story-media/${PROJECT}/${SURVIVOR}/own.png`;
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![x](${survivorKey})`,
			copyObject: fn,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(result.media).toEqual([]);
	});

	it("refuses a key whose tail is a nested path rather than one segment", async () => {
		const nested = `story-media/${PROJECT}/${DUPLICATE}/nested/deep.png`;
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![x](${nested})`,
			copyObject: fn,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(result.skipped[0]).toEqual({
			key: nested,
			reason: "unsafe-key",
		});
	});

	it("carries the valid keys and drops the foreign ones in the same body", async () => {
		const foreign = "story-media/other-project/other-story/secret.png";
		const { fn, calls } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![ok](${dupMediaKey})\n![bad](${foreign})`,
			copyObject: fn,
		});
		expect(calls.map((c) => c.from)).toEqual([dupMediaKey]);
		expect(result.media).toHaveLength(1);
		expect(result.skipped).toEqual([
			{ key: foreign, reason: "foreign-key" },
		]);
	});

	it("logs every key it refused, with its reason", async () => {
		const foreign = "story-media/other-project/other-story/secret.png";
		await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![bad](${foreign})`,
			copyObject: vi.fn(),
		});
		const warned = log.warn.mock.calls.find((c) =>
			String(c[0]).includes("not carried"),
		);
		expect(warned).toBeDefined();
		expect(JSON.stringify(warned?.[1])).toContain(foreign);
	});
});

describe("copyStoryAssetsToStory — uploaded attachments", () => {
	it("copies each row's object and reports the row id with its new key", async () => {
		const { fn, calls } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceAttachments: [{ id: "att-1", storageKey: dupAttachmentKey }],
			copyObject: fn,
		});
		expect(calls[0].from).toBe(dupAttachmentKey);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0].attachmentId).toBe("att-1");
		expect(
			result.attachments[0].targetKey.startsWith(
				`story-attachments/${PROJECT}/${SURVIVOR}/`,
			),
		).toBe(true);
	});

	it("keeps the attachment keyspace separate from the media keyspace", async () => {
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![shot](${dupMediaKey})`,
			sourceAttachments: [{ id: "att-1", storageKey: dupAttachmentKey }],
			copyObject: fn,
		});
		expect(result.media[0].targetKey).toContain("story-media/");
		expect(result.attachments[0].targetKey).toContain("story-attachments/");
	});

	it("refuses a row whose storage key is not under the duplicate's prefix", async () => {
		const foreign = `story-attachments/${PROJECT}/s9/leak.pdf`;
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceAttachments: [{ id: "att-1", storageKey: foreign }],
			copyObject: fn,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(result.attachments).toEqual([]);
		expect(result.skipped[0]).toEqual({
			key: foreign,
			reason: "foreign-key",
		});
	});
});

describe("copyStoryAssetsToStory — failure handling", () => {
	it("reports a failed copy as skipped and never as copied", async () => {
		const failing = vi.fn(async () => {
			throw new Error("provider unavailable");
		});
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![shot](${dupMediaKey})`,
			copyObject: failing,
		});
		expect(result.media).toEqual([]);
		expect(result.skipped).toEqual([
			{ key: dupMediaKey, reason: "copy-failed" },
		]);
	});

	it("does not throw — the merge must still complete", async () => {
		await expect(
			copyStoryAssetsToStory({
				projectId: PROJECT,
				sourceStoryId: DUPLICATE,
				targetStoryId: SURVIVOR,
				sourceDescription: `![shot](${dupMediaKey})`,
				copyObject: vi.fn(async () => {
					throw new Error("boom");
				}),
			}),
		).resolves.toBeDefined();
	});

	it("isolates one failure — the other assets still carry over", async () => {
		const good = `story-media/${PROJECT}/${DUPLICATE}/good.png`;
		const bad = `story-media/${PROJECT}/${DUPLICATE}/bad.png`;
		const flaky = vi.fn(async (from: string) => {
			if (from === bad) {
				throw new Error("copy failed");
			}
		});
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![g](${good})\n![b](${bad})`,
			copyObject: flaky,
		});
		expect(result.media.map((m) => m.sourceKey)).toEqual([good]);
		expect(result.skipped).toEqual([{ key: bad, reason: "copy-failed" }]);
	});

	it("logs the failed key", async () => {
		await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![shot](${dupMediaKey})`,
			copyObject: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		const logged = JSON.stringify(log.warn.mock.calls);
		expect(logged).toContain(dupMediaKey);
	});

	it("never logs a raw error message (it can embed a presigned URL)", async () => {
		await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: `![shot](${dupMediaKey})`,
			copyObject: vi.fn(async () => {
				throw new Error("https://storage.example.com/x?sig=secret");
			}),
		});
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain("sig=secret");
	});
});

describe("copyStoryAssetsToStory — nothing to do", () => {
	it("returns an empty result when neither item has assets", async () => {
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: DUPLICATE,
			targetStoryId: SURVIVOR,
			sourceDescription: "No media at all.",
			sourceAttachments: [],
			copyObject: fn,
		});
		expect(result).toEqual({ media: [], attachments: [], skipped: [] });
		expect(fn).not.toHaveBeenCalled();
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.info).not.toHaveBeenCalled();
	});

	it("copies nothing when the source and target are the same item", async () => {
		const { fn } = copySpy();
		const result = await copyStoryAssetsToStory({
			projectId: PROJECT,
			sourceStoryId: SURVIVOR,
			targetStoryId: SURVIVOR,
			sourceDescription: `![x](story-media/${PROJECT}/${SURVIVOR}/own.png)`,
			copyObject: fn,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(result.media).toEqual([]);
	});
});
