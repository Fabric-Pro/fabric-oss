import { beforeEach, describe, expect, it, vi } from "vitest";

const updateManyMock = vi.hoisted(() => vi.fn());

vi.mock("../../client", () => ({
	db: { userStory: { updateMany: updateManyMock } },
	Prisma: {},
}));

import {
	setLastContextUpdateAt,
	setLastQuestionScanHash,
	setLastSummaryHash,
	setSummaryDigest,
	setWorkingNotes,
} from "../feature-maturation";

const userStoryId = "story-1";
const projectId = "project-1";

/** The three columns that together describe one semantic ticket edit. */
const EDIT_EVENT_FIELDS = [
	"lastEditedAt",
	"lastEditedByName",
	"lastEditedSource",
];

/**
 * Opening a feature seeds its Logic Summary and scan hashes. Those writes move
 * Prisma's `@updatedAt` row clock — which is exactly why the row clock can never
 * be the "Updated" time a human reads. They must leave the edit event alone.
 */
const DERIVED_WRITES: [string, () => Promise<number>][] = [
	[
		"setSummaryDigest",
		() => setSummaryDigest({ userStoryId, projectId, summaryDigest: "d" }),
	],
	[
		"setLastSummaryHash",
		() => setLastSummaryHash({ userStoryId, projectId, hash: "h" }),
	],
	[
		"setLastQuestionScanHash",
		() => setLastQuestionScanHash({ userStoryId, projectId, hash: "h" }),
	],
	[
		"setLastContextUpdateAt",
		() => setLastContextUpdateAt({ userStoryId, projectId }),
	],
	[
		"setWorkingNotes",
		() =>
			setWorkingNotes({
				userStoryId,
				projectId,
				workingNotesContent: "notes",
			}),
	],
];

describe("derived maturation writes never stamp a semantic edit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateManyMock.mockResolvedValue({ count: 1 });
	});

	it.each(DERIVED_WRITES)("%s writes no edit event", async (_name, write) => {
		await write();

		const data = updateManyMock.mock.calls[0]?.[0]?.data ?? {};
		for (const field of EDIT_EVENT_FIELDS) {
			expect(data).not.toHaveProperty(field);
		}
	});
});
