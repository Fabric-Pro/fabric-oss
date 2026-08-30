import { beforeEach, describe, expect, it, vi } from "vitest";

// `getPublishingTopic` is the Topic Item Page's single-topic read (Fizzy #1851,
// Phase 2A-1). It runs the SAME code path as `listPublishingTopics` — narrowed
// to one row by that function's `topicId` filter — so it inherits every one of
// its six degrade contracts (handles, viewer tags, author recommendations,
// why-suggested, read markers, partition) by construction rather than by copy.
// These tests therefore assert the single-topic BEHAVIOUR; the degrade paths
// themselves stay pinned by `list-publishing-topics-degrade.test.ts`.
//
// Unit-level (mocked `db`), matching that sibling suite: this exercises
// in-process projection and try/catch, not real Postgres semantics, so it runs
// in the regular no-Postgres suite and is NOT part of the db-integration
// real-PG count guard.
const {
	publishingTopicFindMany,
	userFindMany,
	viewerTagFindUnique,
	storyFindMany,
	docFindMany,
	meetingFindMany,
	readFindMany,
} = vi.hoisted(() => ({
	publishingTopicFindMany: vi.fn(),
	userFindMany: vi.fn(),
	viewerTagFindUnique: vi.fn(),
	storyFindMany: vi.fn(),
	docFindMany: vi.fn(),
	meetingFindMany: vi.fn(),
	readFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopic: { findMany: publishingTopicFindMany },
		publishingTopicRead: { findMany: readFindMany },
		user: { findMany: userFindMany },
		projectUserFunctionTag: { findUnique: viewerTagFindUnique },
		userStory: { findMany: storyFindMany },
		projectDocument: { findMany: docFindMany },
		projectMeetingTranscript: { findMany: meetingFindMany },
	},
	Prisma: {},
}));

const { isFunctionTagsEnabled } = vi.hoisted(() => ({
	isFunctionTagsEnabled: vi.fn(() => true),
}));
vi.mock("@repo/utils/feature-flag", async (importActual) => ({
	...(await importActual<typeof import("@repo/utils/feature-flag")>()),
	isFunctionTagsEnabled,
}));

const { getProjectMemberFunctionTags } = vi.hoisted(() => ({
	getProjectMemberFunctionTags: vi.fn(),
}));
vi.mock("../prisma/queries/projects/function-tags", () => ({
	getProjectMemberFunctionTags,
}));

import { getPublishingTopic } from "../prisma/queries/projects/publishing-suite";

/** One fully-populated row as Prisma would return it under TOPIC_LIST_SELECT. */
function topicRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "topic-1",
		title: "Shipped the retry budget",
		pitch: "A short AI-written summary.",
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		updatedAt: new Date("2026-08-02T00:00:00Z"),
		snoozedUntil: null,
		snoozeReason: null,
		suggestedPostTypes: [],
		contributorUserIds: ["user-a"],
		relevantFunctionTags: [],
		postTypeRecommendations: [],
		angle: null,
		subject: null,
		provenance: { storyIds: ["story-secret"], repoPrs: [], docIds: [] },
		postTypesOverridden: false,
		userPostTypes: [],
		...overrides,
	};
}

beforeEach(() => {
	publishingTopicFindMany.mockReset();
	userFindMany.mockReset().mockResolvedValue([]);
	viewerTagFindUnique.mockReset().mockResolvedValue(null);
	isFunctionTagsEnabled.mockReset().mockReturnValue(true);
	getProjectMemberFunctionTags.mockReset().mockResolvedValue([]);
	storyFindMany.mockReset().mockResolvedValue([]);
	docFindMany.mockReset().mockResolvedValue([]);
	meetingFindMany.mockReset().mockResolvedValue([]);
	readFindMany.mockReset().mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("getPublishingTopic", () => {
	it("returns the topic with resolved contributor handles", async () => {
		publishingTopicFindMany.mockResolvedValue([topicRow()]);
		userFindMany.mockResolvedValue([
			{
				id: "user-a",
				name: "Dev One",
				image: null,
				username: "devone",
			},
		]);

		const result = await getPublishingTopic({
			id: "topic-1",
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		expect(result?.topic.id).toBe("topic-1");
		expect(result?.topic.title).toBe("Shipped the retry budget");
		expect(result?.topic.contributors).toEqual([
			{
				id: "user-a",
				name: "Dev One",
				image: null,
				username: "devone",
			},
		]);
	});

	it("re-scopes the read to the project, so a foreign topic id is not found", async () => {
		// DV16: the page must never reach a topic outside the current project.
		// The guard is the `projectId` in the WHERE clause, not a post-hoc
		// check — assert the query itself carried it.
		publishingTopicFindMany.mockResolvedValue([]);

		const result = await getPublishingTopic({
			id: "topic-from-another-project",
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		expect(result).toBeNull();
		expect(publishingTopicFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "topic-from-another-project",
					projectId: "proj-1",
				}),
			}),
		);
	});

	it("degrades to an untagged topic when contributor-handle resolution fails", async () => {
		// Inherited from `listPublishingTopics` (AC6): showing a topic without
		// its contributor handles is cosmetic; failing the whole page is not.
		publishingTopicFindMany.mockResolvedValue([topicRow()]);
		userFindMany.mockRejectedValue(new Error("connection reset"));

		const result = await getPublishingTopic({
			id: "topic-1",
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		expect(result?.topic.contributors).toEqual([]);
		expect(result?.topic.title).toBe("Shipped the retry budget");
	});

	it("never returns provenance to the client", async () => {
		// AC-WS13: `provenance` is selected only to drive "why suggested"
		// resolution and must not reach the wire.
		publishingTopicFindMany.mockResolvedValue([topicRow()]);

		const result = await getPublishingTopic({
			id: "topic-1",
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		expect(result?.topic).not.toHaveProperty("provenance");
		expect(result?.topic).not.toHaveProperty("contributorUserIds");
	});

	it("reports this viewer's read marker", async () => {
		publishingTopicFindMany.mockResolvedValue([topicRow()]);
		readFindMany.mockResolvedValue([{ topicId: "topic-1" }]);

		const result = await getPublishingTopic({
			id: "topic-1",
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		expect(result?.topic.isRead).toBe(true);
	});
});
