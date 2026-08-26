import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirstActionItem, isFeatureEnabled, upsertPersonLink } = vi.hoisted(
	() => ({
		findFirstActionItem: vi.fn(),
		isFeatureEnabled: vi.fn(),
		upsertPersonLink: vi.fn(),
	}),
);

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		isFeatureEnabled,
		upsertPersonLink,
		db: {
			...(actual.db as object),
			projectMeetingActionItem: { findFirst: findFirstActionItem },
		},
	};
});

import {
	linkStoryToSourceActionItem,
	readActionItemIdFromMetadata,
} from "@repo/api/modules/projects/lib/action-item-link-provenance";
import { computeActionItemKey } from "@repo/database";

const item = {
	text: "Ship the digest download",
	transcriptId: "tr-cuid",
	transcript: { userId: null, organizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	isFeatureEnabled.mockResolvedValue(true);
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
