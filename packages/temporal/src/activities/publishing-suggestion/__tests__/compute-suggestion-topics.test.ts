import {
	computeDedupeKey,
	computeSubjectKey,
	PublishingTopicPostType,
} from "@repo/database";
import { log } from "@temporalio/activity";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeSuggestionTopics } from "../compute-suggestion-topics";

vi.mock("@temporalio/activity", () => ({ log: { warn: vi.fn() } }));

const t = (
	over: Partial<{ title: string; subject: string; angle: string }>,
) => ({
	title: over.title ?? "T",
	pitch: "p",
	provenance: {},
	suggestedPostTypes: [],
	relevantFunctionTags: [],
	postTypeRecommendations: [],
	angle: over.angle,
	subject: over.subject,
});

describe("computeSuggestionTopics", () => {
	beforeEach(() => vi.clearAllMocks());

	it("stamps the canonical project-scoped dedupeKey on each topic and preserves fields", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "proj-1",
			topics: [
				{
					title: "Ship the widget",
					pitch: "P1",
					provenance: { storyIds: ["s1"] },
					suggestedPostTypes: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
				{
					title: "Second topic",
					pitch: "P2",
					provenance: {},
					suggestedPostTypes: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
		});

		expect(topics).toHaveLength(2);
		expect(topics[0]).toEqual({
			title: "Ship the widget",
			pitch: "P1",
			provenance: { storyIds: ["s1"] },
			dedupeKey: computeDedupeKey("proj-1", "Ship the widget"),
			suggestedPostTypes: [],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
			contributorUserIds: [],
			subject: null,
			subjectKey: null,
		});
		// Project-scoped: the same title under a different project hashes differently.
		expect(computeDedupeKey("proj-2", "Ship the widget")).not.toBe(
			topics[0]?.dedupeKey,
		);
	});

	it("maps post-type labels to enum and seeds empty contributors", async () => {
		const out = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				{
					title: "Ship X",
					pitch: "we shipped X",
					provenance: { storyIds: ["s1"] },
					suggestedPostTypes: ["Blog Post", "Tweet"],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
		});
		expect(out.topics[0].suggestedPostTypes).toEqual([
			PublishingTopicPostType.BLOG_POST,
			PublishingTopicPostType.TWEET,
		]);
		expect(out.topics[0].contributorUserIds).toEqual([]);
		expect(out.topics[0].dedupeKey).toBeTruthy();
	});

	it("dedupes repeated post-type labels (D6)", async () => {
		const out = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				{
					title: "Ship Y",
					pitch: "we shipped Y",
					provenance: { storyIds: ["s1"] },
					suggestedPostTypes: ["Tweet", "Tweet", "Blog Post"],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
				},
			],
		});
		expect(out.topics[0].suggestedPostTypes).toEqual([
			PublishingTopicPostType.TWEET,
			PublishingTopicPostType.BLOG_POST,
		]);
	});

	it("carries angle through to the persist-input topic (FR9/10)", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "proj-1",
			topics: [
				{
					title: "Ship the widget",
					pitch: "P",
					provenance: {},
					suggestedPostTypes: [],
					relevantFunctionTags: [],
					postTypeRecommendations: [],
					angle: "Engineering deep-dive",
				},
			],
		});
		expect(topics[0].angle).toBe("Engineering deep-dive");
		expect(topics[0].dedupeKey).toBe(
			computeDedupeKey("proj-1", "Ship the widget"),
		);
	});

	it("emits both records of a 2-distinct-angle subject with shared subjectKey", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				t({ title: "A", subject: "S", angle: "eng" }),
				t({ title: "B", subject: "S", angle: "customer" }),
			],
		});
		expect(topics).toHaveLength(2);
		expect(topics.every((r) => r.subject === "S")).toBe(true);
		expect(topics[0].subjectKey).toBe(computeSubjectKey("p1", "S"));
		expect(topics[0].subjectKey).toBe(topics[1].subjectKey);
		expect(new Set(topics.map((r) => r.dedupeKey)).size).toBe(2);
	});

	it("caps a subject at 2 records, dropping a 3rd distinct angle with a warn", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				t({ title: "A", subject: "S", angle: "eng" }),
				t({ title: "B", subject: "S", angle: "customer" }),
				t({ title: "C", subject: "S", angle: "exec" }),
			],
		});
		expect(topics).toHaveLength(2);
		expect(log.warn).toHaveBeenCalled();
	});

	it("demotes a same-subject pair without 2 distinct angles to a single record", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				t({ title: "A", subject: "S", angle: "eng" }),
				t({ title: "B", subject: "S", angle: "eng" }), // duplicate angle
			],
		});
		expect(topics).toHaveLength(1);
		expect(topics[0].subject).toBeNull();
		expect(topics[0].subjectKey).toBeNull();
	});

	it("demotes to the SELECTED valid-angle record when a blank-angle record sorts first", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				t({ title: "Blank first", subject: "S", angle: undefined }), // group[0], blank angle
				t({ title: "Valid second", subject: "S", angle: "eng" }), // the selected valid record
			],
		});
		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("Valid second"); // keeps selected[0], NOT group[0]
		expect(topics[0].subject).toBeNull();
		expect(topics[0].subjectKey).toBeNull();
		expect(log.warn).toHaveBeenCalled(); // the blank-angle record was dropped
	});

	it("falls back to the first record when NO record in the group has a non-blank angle", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				t({ title: "First blank", subject: "S", angle: undefined }),
				t({ title: "Second blank", subject: "S", angle: undefined }),
			],
		});
		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("First blank"); // zero-valid-angle policy → group[0]
		expect(topics[0].subject).toBeNull();
	});

	it("keeps a lone topic (with or without an angle) as a singleton with null subject", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [t({ title: "A", angle: "eng" })],
		});
		expect(topics).toHaveLength(1);
		expect(topics[0].subject).toBeNull();
		expect(topics[0].subjectKey).toBeNull();
		expect(topics[0].dedupeKey).toBe(computeDedupeKey("p1", "A"));
	});

	it("de-collides two identical titles (same dedupeKey), dropping one with a warn", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				t({ title: "Same", subject: "S", angle: "eng" }),
				t({ title: "Same", subject: "S", angle: "customer" }),
			],
		});
		expect(topics).toHaveLength(1);
		expect(log.warn).toHaveBeenCalled();
	});

	it("keeps a standalone topic whose title equals an explicit subject as a singleton (P2)", async () => {
		const { topics } = await computeSuggestionTopics({
			projectId: "p1",
			topics: [
				t({ title: "Shipped RLS", angle: "overview" }), // NO subject — standalone
				t({ title: "Deep dive", subject: "Shipped RLS", angle: "eng" }),
				t({
					title: "Customer win",
					subject: "Shipped RLS",
					angle: "customer",
				}),
			],
		});
		expect(topics).toHaveLength(3); // standalone singleton + the 2-angle pair
		const standalone = topics.find((r) => r.title === "Shipped RLS");
		expect(standalone?.subject).toBeNull();
		expect(standalone?.subjectKey).toBeNull();
		const grouped = topics.filter((r) => r.subject === "Shipped RLS");
		expect(grouped).toHaveLength(2);
		expect(grouped.every((r) => r.title !== "Shipped RLS")).toBe(true);
	});
});
