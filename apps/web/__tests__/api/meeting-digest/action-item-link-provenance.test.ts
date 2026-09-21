import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findFirstActionItem,
	findFirstTranscript,
	isFeatureEnabled,
	loggerWarn,
	upsertPersonLink,
} = vi.hoisted(() => ({
	findFirstActionItem: vi.fn(),
	findFirstTranscript: vi.fn(),
	isFeatureEnabled: vi.fn(),
	loggerWarn: vi.fn(),
	upsertPersonLink: vi.fn(),
}));

// The unresolved path logs — stubbing the whole surface keeps the assertion on
// `warn` honest (a call routed to `info` or `error` would not satisfy it).
vi.mock("@repo/logs", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: loggerWarn,
			error: vi.fn(),
		},
	};
});

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		isFeatureEnabled,
		upsertPersonLink,
		db: {
			...(actual.db as object),
			projectMeetingActionItem: { findFirst: findFirstActionItem },
			projectMeetingTranscript: { findFirst: findFirstTranscript },
		},
	};
});

import {
	linkStoryToSourceActionItem,
	readActionItemIdFromMetadata,
	readActionItemKeyFromMetadata,
} from "@repo/api/modules/projects/lib/action-item-link-provenance";
import { resolveMeetingTranscriptForProposal } from "@repo/api/modules/projects/lib/meeting-provenance";
import {
	TODO_BINDING_VERSION,
	computeActionItemKey,
	computeTodoItemKey,
} from "@repo/database";

const item = {
	text: "Ship the digest download",
	transcriptId: "tr-cuid",
	transcript: { userId: null, organizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	isFeatureEnabled.mockResolvedValue(true);
	findFirstTranscript.mockResolvedValue(null);
});

describe("readActionItemIdFromMetadata", () => {
	it("reads the id a per-item proposal carries", () => {
		expect(readActionItemIdFromMetadata({ actionItemId: "a1" })).toBe("a1");
	});

	it("returns null for a meeting-level proposal", () => {
		expect(readActionItemIdFromMetadata({ transcriptRecordId: "t1" })).toBe(
			null,
		);
	});

	it("tolerates null, undefined, and a non-string id", () => {
		expect(readActionItemIdFromMetadata(null)).toBe(null);
		expect(readActionItemIdFromMetadata(undefined)).toBe(null);
		expect(readActionItemIdFromMetadata({ actionItemId: 42 })).toBe(null);
	});
});

describe("linkStoryToSourceActionItem", () => {
	it("links the new work item to the action item it came from (AC9)", async () => {
		findFirstActionItem.mockResolvedValue(item);
		upsertPersonLink.mockResolvedValue({ id: "link-1" });

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: { actionItemId: "a1" },
			storyId: "s1",
			createdById: "u1",
		});

		expect(result).toEqual({ linkId: "link-1" });
		expect(upsertPersonLink).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptId: "tr-cuid",
				projectId: "p1",
				storyId: "s1",
				origin: "CREATED",
				createdById: "u1",
				itemKey: computeActionItemKey("Ship the digest download"),
				itemTextSnapshot: "Ship the digest download",
				userId: null,
				organizationId: "org-1",
			}),
		);
	});

	it("does nothing for a meeting-level proposal, without querying", async () => {
		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: { transcriptRecordId: "t1" },
			storyId: "s1",
			createdById: "u1",
		});

		expect(result).toBeNull();
		expect(findFirstActionItem).not.toHaveBeenCalled();
		expect(upsertPersonLink).not.toHaveBeenCalled();
	});

	it("does nothing when the feature flag is off", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: { actionItemId: "a1" },
			storyId: "s1",
			createdById: "u1",
		});

		expect(result).toBeNull();
		expect(upsertPersonLink).not.toHaveBeenCalled();
	});

	it("scopes the action item to the project", async () => {
		findFirstActionItem.mockResolvedValue(item);
		upsertPersonLink.mockResolvedValue({ id: "link-1" });

		await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: { actionItemId: "a1" },
			storyId: "s1",
			createdById: "u1",
		});

		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
	});

	it("returns null when the action item no longer exists (re-extracted away)", async () => {
		findFirstActionItem.mockResolvedValue(null);

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: { actionItemId: "a1" },
			storyId: "s1",
			createdById: "u1",
		});

		expect(result).toBeNull();
		expect(upsertPersonLink).not.toHaveBeenCalled();
	});
});

/**
 * Characterization of the resolution order as it stands BEFORE #2340.
 *
 * This path is live and its failure mode is silent, so the fallbacks are pinned
 * here first and only then re-pointed at the stable key. Every assertion in this
 * block describes today's code; the ones that describe the DEFECT rather than
 * the contract say so in their name.
 */
describe("resolution order (characterization)", () => {
	it("C1: a proposal carrying only actionItemId resolves by row id", async () => {
		findFirstActionItem.mockResolvedValue(item);
		upsertPersonLink.mockResolvedValue({ id: "link-c1" });

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: {
				actionItemId: "a1",
				transcriptRecordId: "tr-cuid",
			},
			storyId: "s1",
			createdById: "u1",
		});

		expect(result).toEqual({ linkId: "link-c1" });
		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
	});

	it("C2: a meeting-level proposal (no id, no key) never queries and never links", async () => {
		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: { transcriptRecordId: "tr-cuid" },
			storyId: "s1",
			createdById: "u1",
		});

		expect(result).toBeNull();
		expect(findFirstActionItem).not.toHaveBeenCalled();
		expect(upsertPersonLink).not.toHaveBeenCalled();
	});

	it("C3: a row id that addresses nothing returns null instead of throwing", async () => {
		findFirstActionItem.mockResolvedValue(null);

		await expect(
			linkStoryToSourceActionItem({
				projectId: "p1",
				sourceMetadata: { actionItemId: "gone" },
				storyId: "s1",
				createdById: "u1",
			}),
		).resolves.toBeNull();
		expect(upsertPersonLink).not.toHaveBeenCalled();
	});

	it("C4 (was the defect): a legacy proposal whose row was re-extracted away is now REPORTED, not silently dropped", async () => {
		// Extraction deleted row `a1` and recreated the same commitment under a
		// new id. A proposal filed before #2340 carries no stable key, so there
		// is still nothing to resolve — but the loss is no longer silent, which
		// is the whole point of the change.
		findFirstActionItem.mockResolvedValue(null);

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: {
				actionItemId: "a1",
				transcriptRecordId: "tr-cuid",
			},
			storyId: "s1",
			createdById: "u1",
			proposalId: "prop-1",
		});

		expect(result).toBeNull();
		expect(loggerWarn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				outcome: "unresolved",
				proposalId: "prop-1",
				transcriptId: "tr-cuid",
			}),
		);
	});

	it("C5: the transcript-level back-link still answers for a meeting-level proposal", async () => {
		findFirstTranscript.mockResolvedValue({ id: "tr-cuid" });

		await expect(
			resolveMeetingTranscriptForProposal({
				projectId: "p1",
				proposalId: "prop-1",
				proposalSource: "MONITORED_MEETING",
				sourceMetadata: { transcriptRecordId: "tr-cuid" },
			}),
		).resolves.toEqual({ id: "tr-cuid" });
	});
});

/**
 * #2340: the stable key, and the fallbacks it must not displace.
 *
 * `itemKey` is `computeTodoItemKey` over the item's normalized text, which is
 * what the extraction row builder stores on the row, so a re-extraction that
 * leaves the wording alone leaves the key alone too.
 */
describe("readActionItemKeyFromMetadata", () => {
	it("reads a key stamped under the current binding version", () => {
		expect(
			readActionItemKeyFromMetadata({
				actionItemKey: "abc",
				actionItemKeyVersion: TODO_BINDING_VERSION,
			}),
		).toBe("abc");
	});

	it("refuses a key stamped under a different binding version", () => {
		expect(
			readActionItemKeyFromMetadata({
				actionItemKey: "abc",
				actionItemKeyVersion: TODO_BINDING_VERSION + 1,
			}),
		).toBe(null);
	});

	it("refuses a key with no version at all", () => {
		expect(readActionItemKeyFromMetadata({ actionItemKey: "abc" })).toBe(
			null,
		);
	});

	it("tolerates null, undefined, an empty key, and a non-string key", () => {
		expect(readActionItemKeyFromMetadata(null)).toBe(null);
		expect(readActionItemKeyFromMetadata(undefined)).toBe(null);
		expect(
			readActionItemKeyFromMetadata({
				actionItemKey: "",
				actionItemKeyVersion: TODO_BINDING_VERSION,
			}),
		).toBe(null);
		expect(
			readActionItemKeyFromMetadata({
				actionItemKey: 42,
				actionItemKeyVersion: TODO_BINDING_VERSION,
			}),
		).toBe(null);
	});
});

describe("linkStoryToSourceActionItem — stable-key resolution (#2340)", () => {
	const keyedMetadata = {
		// Stale: extraction deleted this row and recreated the item as `a2`.
		actionItemId: "a1",
		actionItemKey: computeTodoItemKey("Ship the digest download"),
		actionItemKeyVersion: TODO_BINDING_VERSION,
		transcriptRecordId: "tr-cuid",
	};

	it("resolves by the stable key after a re-extraction that preserved the text", async () => {
		findFirstActionItem.mockResolvedValueOnce(item);
		upsertPersonLink.mockResolvedValue({ id: "link-key" });

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: keyedMetadata,
			storyId: "s1",
			createdById: "u1",
			proposalId: "prop-1",
		});

		expect(result).toEqual({ linkId: "link-key" });
		// One query only: the key answered, so the stale row id is never tried.
		expect(findFirstActionItem).toHaveBeenCalledTimes(1);
		expect(loggerWarn).not.toHaveBeenCalled();
		expect(upsertPersonLink).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptId: "tr-cuid",
				storyId: "s1",
				origin: "CREATED",
				// The LINK table keeps its own key — `computeActionItemKey`,
				// versioned independently of the to-do binding key that found
				// the row.
				itemKey: computeActionItemKey("Ship the digest download"),
				itemTextSnapshot: "Ship the digest download",
			}),
		);
	});

	it("scopes the key lookup to the meeting the proposal names", async () => {
		findFirstActionItem.mockResolvedValueOnce(item);
		upsertPersonLink.mockResolvedValue({ id: "link-key" });

		await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: keyedMetadata,
			storyId: "s1",
			createdById: "u1",
			proposalId: "prop-1",
		});

		// Tenancy AND identity: a text digest matches far too readily across
		// meetings, so the lookup is pinned to this proposal's transcript as
		// well as to its project.
		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					itemKey: keyedMetadata.actionItemKey,
					transcript: { projectId: "p1" },
					transcriptId: "tr-cuid",
				},
			}),
		);
	});

	it("warns with the transcript and proposal ids when the item's text changed", async () => {
		// Reworded item: the key addresses nothing, and the row id is stale.
		findFirstActionItem.mockResolvedValue(null);
		findFirstTranscript.mockResolvedValue({ id: "tr-cuid" });

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: keyedMetadata,
			storyId: "s1",
			createdById: "u1",
			proposalId: "prop-1",
		});

		expect(result).toBeNull();
		expect(upsertPersonLink).not.toHaveBeenCalled();
		expect(loggerWarn).toHaveBeenCalledTimes(1);
		expect(loggerWarn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				outcome: "unresolved",
				projectId: "p1",
				proposalId: "prop-1",
				transcriptId: "tr-cuid",
				storyId: "s1",
				hasItemKey: true,
				hasActionItemId: true,
			}),
		);
	});

	it("falls back to the row id when the key misses but the row is still there", async () => {
		findFirstActionItem
			.mockResolvedValueOnce(null) // key lookup
			.mockResolvedValueOnce(item); // row-id lookup
		upsertPersonLink.mockResolvedValue({ id: "link-id" });

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: keyedMetadata,
			storyId: "s1",
			createdById: "u1",
			proposalId: "prop-1",
		});

		expect(result).toEqual({ linkId: "link-id" });
		expect(findFirstActionItem).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
		expect(loggerWarn).not.toHaveBeenCalled();
	});

	it("does not trust a key written under another binding version, and still resolves by row id", async () => {
		findFirstActionItem.mockResolvedValue(item);
		upsertPersonLink.mockResolvedValue({ id: "link-id" });

		const result = await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: {
				...keyedMetadata,
				actionItemKeyVersion: TODO_BINDING_VERSION + 1,
			},
			storyId: "s1",
			createdById: "u1",
			proposalId: "prop-1",
		});

		expect(result).toEqual({ linkId: "link-id" });
		// The unusable key is skipped outright rather than queried.
		expect(findFirstActionItem).toHaveBeenCalledTimes(1);
		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
	});

	it("resolves a keyed proposal even when it names no transcript", async () => {
		findFirstActionItem.mockResolvedValueOnce(item);
		upsertPersonLink.mockResolvedValue({ id: "link-key" });

		const { transcriptRecordId: _omitted, ...withoutTranscript } =
			keyedMetadata;
		await linkStoryToSourceActionItem({
			projectId: "p1",
			sourceMetadata: withoutTranscript,
			storyId: "s1",
			createdById: "u1",
			proposalId: "prop-1",
		});

		// Pre-#1823 proposals carry no transcript id; the lookup widens to the
		// project rather than refusing to run.
		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					itemKey: keyedMetadata.actionItemKey,
					transcript: { projectId: "p1" },
				},
			}),
		);
	});

	it("does not throw, link, or warn for an item that never existed on a meeting-level proposal", async () => {
		await expect(
			linkStoryToSourceActionItem({
				projectId: "p1",
				sourceMetadata: { transcriptRecordId: "tr-cuid" },
				storyId: "s1",
				createdById: "u1",
				proposalId: "prop-1",
			}),
		).resolves.toBeNull();

		// Nothing was ever addressed, so nothing is unresolved: a meeting-level
		// proposal must not produce noise on every approval.
		expect(findFirstActionItem).not.toHaveBeenCalled();
		expect(loggerWarn).not.toHaveBeenCalled();
	});

	it("stays silent when the feature flag is off", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await expect(
			linkStoryToSourceActionItem({
				projectId: "p1",
				sourceMetadata: keyedMetadata,
				storyId: "s1",
				createdById: "u1",
				proposalId: "prop-1",
			}),
		).resolves.toBeNull();

		// A disabled feature is not a failed resolution.
		expect(loggerWarn).not.toHaveBeenCalled();
		expect(findFirstActionItem).not.toHaveBeenCalled();
	});
});
