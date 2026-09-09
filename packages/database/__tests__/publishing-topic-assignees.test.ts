import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updatePublishingTopicAssignees` — the write behind slice A8 (Fizzy #1851).
 *
 * What is actually under test is the ADDED diff. The caller notifies on ADD
 * only, and it can only know what an add IS from this helper's answer, so a
 * regression here is not a wrong array — it is a person who silently stops
 * being told, or one who is told again every time somebody else edits the list.
 *
 * Unit-level (mocked `db`), matching `get-publishing-topic.test.ts`: the diff
 * and the dedupe are in-process logic, not Postgres semantics, so this runs in
 * the regular no-Postgres suite and is NOT part of the db-integration real-PG
 * count guard.
 */
const { publishingTopicFindFirst, publishingTopicUpdateMany } = vi.hoisted(
	() => ({
		publishingTopicFindFirst: vi.fn(),
		publishingTopicUpdateMany: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopic: {
			findFirst: publishingTopicFindFirst,
			updateMany: publishingTopicUpdateMany,
		},
	},
	Prisma: {},
}));

import { updatePublishingTopicAssignees } from "../prisma/queries/projects/publishing-suite";

const TOPIC = { id: "topic-1", title: "A topic" };

/** The helper reads the prior row, then re-reads the written row. Both go
 *  through `findFirst`, so the mock answers in call order. */
function withPrior(priorAssignees: string[] | null) {
	publishingTopicFindFirst.mockReset();
	if (priorAssignees === null) {
		publishingTopicFindFirst.mockResolvedValueOnce(null);
		return;
	}
	publishingTopicFindFirst
		.mockResolvedValueOnce({ assigneeUserIds: priorAssignees })
		.mockResolvedValueOnce(TOPIC);
}

beforeEach(() => {
	vi.clearAllMocks();
	publishingTopicUpdateMany.mockResolvedValue({ count: 1 });
});

describe("updatePublishingTopicAssignees", () => {
	it("reports only the NEWLY added ids, not the whole submitted list", async () => {
		withPrior(["already-there"]);

		const result = await updatePublishingTopicAssignees({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: ["already-there", "brand-new"],
		});

		expect(result?.addedUserIds).toEqual(["brand-new"]);
	});

	it("reports NOTHING added when the save only removes somebody — the removal path must not notify", async () => {
		withPrior(["stays", "goes"]);

		const result = await updatePublishingTopicAssignees({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: ["stays"],
		});

		expect(result?.addedUserIds).toEqual([]);
		// The write still happens — the removal is real, it just tells nobody.
		expect(publishingTopicUpdateMany).toHaveBeenCalledWith({
			where: { id: "topic-1", projectId: "project-1" },
			data: { assigneeUserIds: ["stays"] },
		});
	});

	it("reports nothing added when the list is re-saved unchanged", async () => {
		withPrior(["a", "b"]);

		const result = await updatePublishingTopicAssignees({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: ["b", "a"],
		});

		expect(result?.addedUserIds).toEqual([]);
	});

	it("clears the list on [] and reports nothing added", async () => {
		withPrior(["a", "b"]);

		const result = await updatePublishingTopicAssignees({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: [],
		});

		expect(result?.addedUserIds).toEqual([]);
		expect(publishingTopicUpdateMany).toHaveBeenCalledWith({
			where: { id: "topic-1", projectId: "project-1" },
			data: { assigneeUserIds: [] },
		});
	});

	it("dedupes the written set and counts a repeated new id once", async () => {
		withPrior([]);

		const result = await updatePublishingTopicAssignees({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: ["dup", "dup", "other"],
		});

		expect(result?.addedUserIds).toEqual(["dup", "other"]);
		expect(publishingTopicUpdateMany).toHaveBeenCalledWith({
			where: { id: "topic-1", projectId: "project-1" },
			data: { assigneeUserIds: ["dup", "other"] },
		});
	});

	it("returns null and writes NOTHING when the topic does not exist", async () => {
		withPrior(null);

		const result = await updatePublishingTopicAssignees({
			id: "missing",
			projectId: "project-1",
			assigneeUserIds: ["someone"],
		});

		expect(result).toBeNull();
		expect(publishingTopicUpdateMany).not.toHaveBeenCalled();
	});

	it("scopes both the prior read and the write to the project (DV16)", async () => {
		withPrior([]);

		await updatePublishingTopicAssignees({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: ["a"],
		});

		expect(publishingTopicFindFirst.mock.calls[0][0]).toMatchObject({
			where: { id: "topic-1", projectId: "project-1" },
		});
		expect(publishingTopicUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "topic-1", projectId: "project-1" },
			}),
		);
	});
});
