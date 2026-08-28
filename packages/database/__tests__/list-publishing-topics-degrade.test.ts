import { beforeEach, describe, expect, it, vi } from "vitest";

// AC6: `listPublishingTopics` must degrade to untagged/unranked topics — never
// throw — when contributor-handle resolution fails. Unit-level (mocked `db`),
// not gated on RUN_DB_INTEGRATION: this exercises the in-process try/catch
// around `db.user.findMany`, not real Postgres semantics, so it runs in the
// regular no-Postgres suite (and is NOT part of the db-integration real-PG
// count guard).
const {
	findMany: publishingTopicFindMany,
	userFindMany,
	viewerTagFindUnique,
	storyFindMany,
	docFindMany,
	meetingFindMany,
} = vi.hoisted(() => ({
	findMany: vi.fn(),
	userFindMany: vi.fn(),
	viewerTagFindUnique: vi.fn(),
	storyFindMany: vi.fn(),
	docFindMany: vi.fn(),
	meetingFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopic: { findMany: publishingTopicFindMany },
		user: { findMany: userFindMany },
		projectUserFunctionTag: { findUnique: viewerTagFindUnique },
		userStory: { findMany: storyFindMany },
		projectDocument: { findMany: docFindMany },
		projectMeetingTranscript: { findMany: meetingFindMany },
	},
	Prisma: {},
}));

// The viewer-tag read is gated behind the Role/Function Tags flag (#1767,
// Copilot review) — default the mock to `true` so every EXISTING 3-tier /
// viewer-tag-failure / discriminating case below keeps exercising the read
// exactly as before the gate was added. A dedicated flag-off case below
// overrides this per-test.
const { isFunctionTagsEnabled } = vi.hoisted(() => ({
	isFunctionTagsEnabled: vi.fn(() => true),
}));
vi.mock("@repo/utils/feature-flag", async (importActual) => ({
	...(await importActual<typeof import("@repo/utils/feature-flag")>()),
	isFunctionTagsEnabled,
}));

// Author recommendations (FR4-8): the roster read is mocked so the computation
// is exercised deterministically without a DB. Default resolves to an empty
// roster (no candidates) — individual tests override per case.
const { getProjectMemberFunctionTags } = vi.hoisted(() => ({
	getProjectMemberFunctionTags: vi.fn(),
}));
vi.mock("../prisma/queries/projects/function-tags", () => ({
	getProjectMemberFunctionTags,
}));

import { listPublishingTopics } from "../prisma/queries/projects/publishing-suite";

beforeEach(() => {
	publishingTopicFindMany.mockReset();
	userFindMany.mockReset();
	viewerTagFindUnique.mockReset();
	viewerTagFindUnique.mockResolvedValue(null);
	isFunctionTagsEnabled.mockReset();
	isFunctionTagsEnabled.mockReturnValue(true);
	getProjectMemberFunctionTags.mockReset();
	getProjectMemberFunctionTags.mockResolvedValue([]);
	storyFindMany.mockReset().mockResolvedValue([]);
	docFindMany.mockReset().mockResolvedValue([]);
	meetingFindMany.mockReset().mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("listPublishingTopics — AC6 degrade-safe on handle-lookup failure", () => {
	it("returns untagged topics in createdAt desc order when db.user.findMany rejects", async () => {
		const rows = [
			{
				id: "topic-3",
				title: "Newest",
				pitch: "pitch-3",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-16T00:00:00Z"),
				suggestedPostTypes: [],
				contributorUserIds: ["user-a"],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
			},
			{
				id: "topic-2",
				title: "Middle",
				pitch: "pitch-2",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-15T00:00:00Z"),
				suggestedPostTypes: [],
				contributorUserIds: ["user-b"],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
			},
			{
				id: "topic-1",
				title: "Oldest",
				pitch: "pitch-1",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-14T00:00:00Z"),
				suggestedPostTypes: [],
				contributorUserIds: ["user-a", "user-c"],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
			},
		];
		publishingTopicFindMany.mockResolvedValue(rows);
		userFindMany.mockRejectedValue(new Error("connection reset"));

		// Viewer contributed to none of these topics, so the (unrelated) two-tier
		// ranking partition places everything in the "rest" tier — isolating this
		// assertion to the degrade behavior rather than the ranking behavior.
		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-not-a-contributor",
		});

		// Degraded, not thrown: every topic renders untagged.
		expect(items.every((i) => i.contributors.length === 0)).toBe(true);
		// Still recency order (createdAt desc) — the two-tier partition is a
		// no-throw array operation and runs unconditionally on the degraded byId.
		expect(items.map((i) => i.id)).toEqual([
			"topic-3",
			"topic-2",
			"topic-1",
		]);
	});

	// The row set: viewer "viewer-1" contributed to the OLDEST topic only. A
	// working two-tier ranking would hoist that topic to the front; plain
	// recency keeps it last. This distinguishes "unranked" from "reranked".
	const rowsViewerOwnsOldest = () => [
		{
			id: "topic-3",
			title: "Newest",
			pitch: "pitch-3",
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			createdById: null,
			createdAt: new Date("2026-07-16T00:00:00Z"),
			suggestedPostTypes: [],
			contributorUserIds: ["user-a"],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		},
		{
			id: "topic-2",
			title: "Middle",
			pitch: "pitch-2",
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			createdById: null,
			createdAt: new Date("2026-07-15T00:00:00Z"),
			suggestedPostTypes: [],
			contributorUserIds: ["user-b"],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		},
		{
			id: "topic-1",
			title: "Oldest",
			pitch: "pitch-1",
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			createdById: null,
			createdAt: new Date("2026-07-14T00:00:00Z"),
			suggestedPostTypes: [],
			contributorUserIds: ["viewer-1", "user-c"],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		},
	];

	it("returns UNRANKED (plain recency) order when the lookup fails even though the viewer contributed to a topic (AC6)", async () => {
		publishingTopicFindMany.mockResolvedValue(rowsViewerOwnsOldest());
		userFindMany.mockRejectedValue(new Error("connection reset"));

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// Untagged (lookup failed) AND unranked: the viewer's own oldest topic is
		// NOT hoisted — the list stays in createdAt desc order. A reranked list
		// would be ["topic-1", "topic-3", "topic-2"].
		expect(items.every((i) => i.contributors.length === 0)).toBe(true);
		expect(items.map((i) => i.id)).toEqual([
			"topic-3",
			"topic-2",
			"topic-1",
		]);
	});

	it("hoists the viewer's contributed topic to the first tier when the lookup SUCCEEDS (ranking still works)", async () => {
		publishingTopicFindMany.mockResolvedValue(rowsViewerOwnsOldest());
		// Lookup succeeds — resolve viewer-1 + user-a handles (user-b/user-c drop).
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
			{ id: "user-a", name: "User A", image: null, username: "ua" },
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// Viewer's own topic (the oldest) leads; the rest keep recency order.
		// This is the positive control: it proves the failure-path test above is
		// meaningful (ranking is not simply always-off).
		expect(items.map((i) => i.id)).toEqual([
			"topic-1",
			"topic-3",
			"topic-2",
		]);
	});

	it("keeps handles and 2-tier contribution order when the VIEWER-TAG read fails (decoupled degrade)", async () => {
		publishingTopicFindMany.mockResolvedValue(rowsViewerOwnsOldest()); // viewer-1 contributed to topic-1
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
			{ id: "user-a", name: "User A", image: null, username: "ua" },
		]);
		viewerTagFindUnique.mockRejectedValue(new Error("tag read down"));

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// Viewer-tag failure ≠ AC6 untagged. Handles PRESERVED, and ranking is the
		// 1B 2-tier contribution order (viewer's oldest hoisted), NOT bare recency.
		expect(
			items.find((i) => i.id === "topic-1")?.contributors.length,
		).toBeGreaterThan(0);
		expect(items.map((i) => i.id)).toEqual([
			"topic-1",
			"topic-3",
			"topic-2",
		]);
	});

	it("places a role-matched non-contributed topic in tier 2 (above the rest)", async () => {
		const rows = rowsViewerOwnsOldest().map((r) =>
			r.id === "topic-3"
				? {
						...r,
						contributorUserIds: ["user-x"],
						relevantFunctionTags: ["DEVELOPER"],
					}
				: { ...r, relevantFunctionTags: [] },
		);
		publishingTopicFindMany.mockResolvedValue(rows);
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
		]);
		viewerTagFindUnique.mockResolvedValue({ tags: ["DEVELOPER"] });

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// tier1 = topic-1 (viewer contributed); tier2 = topic-3 (role match, not contributed);
		// tier3 = topic-2. Recency preserved within tiers.
		expect(items.map((i) => i.id)).toEqual([
			"topic-1",
			"topic-3",
			"topic-2",
		]);
	});

	// Discriminating case (review finding): the case above reuses
	// `rowsViewerOwnsOldest`, where the role-matched topic (topic-3) is already
	// the NEWEST non-contributed row — so it already leads the "rest" bucket
	// under the OLD 2-tier (contribution-only) logic too, and BOTH algorithms
	// produce [topic-1, topic-3, topic-2]. That case passes on pre-Task-7 code
	// and proves nothing about the new tier-2 hoist.
	//
	// This fixture makes the role-matched topic (B) OLDER than the non-matched
	// topic (C):
	//   - OLD 2-tier: "rest" sorted by recency desc → [C, B] → full order [A, C, B]
	//   - NEW 3-tier: B (role-matched) hoisted into tier 2 above C → [A, B, C]
	// The two algorithms now disagree, so asserting the 3-tier order below
	// FAILS on 2-tier code and PASSES on 3-tier code.
	it("hoists a role-matched, non-contributed topic ABOVE a non-matched, non-contributed topic even though the role match is OLDER", async () => {
		const rows = [
			{
				id: "A",
				title: "Viewer-contributed",
				pitch: "pitch-a",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-16T00:00:00Z"), // newest
				suggestedPostTypes: [],
				contributorUserIds: ["viewer-1"],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
			},
			{
				id: "C",
				title: "Not contributed, not role-matched",
				pitch: "pitch-c",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-15T00:00:00Z"), // middle recency
				suggestedPostTypes: [],
				contributorUserIds: ["user-x"],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
			},
			{
				id: "B",
				title: "Role-matched, not contributed",
				pitch: "pitch-b",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-14T00:00:00Z"), // oldest
				suggestedPostTypes: [],
				contributorUserIds: ["user-y"],
				relevantFunctionTags: ["DEVELOPER"],
				postTypeRecommendations: [],
			},
		];
		publishingTopicFindMany.mockResolvedValue(rows);
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
		]);
		viewerTagFindUnique.mockResolvedValue({ tags: ["DEVELOPER"] });

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// 2-tier (pre-Task-7) order would be [A, C, B] (recency within "rest").
		// 3-tier (current) order hoists B into tier 2 above C: [A, B, C].
		expect(items.map((i) => i.id)).toEqual(["A", "B", "C"]);
	});

	// Copilot review: the viewer-tag read must not run at all when Function
	// Tags is disabled — not merely degrade to empty tags via a try/catch.
	it("skips the viewer function-tag read entirely when Function Tags is disabled — always 2-tier", async () => {
		isFunctionTagsEnabled.mockReturnValue(false);
		const rows = rowsViewerOwnsOldest().map((r) =>
			r.id === "topic-3"
				? { ...r, relevantFunctionTags: ["DEVELOPER"] }
				: r,
		);
		publishingTopicFindMany.mockResolvedValue(rows);
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
			{ id: "user-a", name: "User A", image: null, username: "ua" },
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// Flag off ⇒ no query at all, regardless of tag data on the rows.
		expect(viewerTagFindUnique).not.toHaveBeenCalled();
		// 2-tier order: viewer's contributed topic (oldest) hoisted first, the
		// rest by recency — topic-3's relevantFunctionTags is ignored because
		// the role tier never runs.
		expect(items.map((i) => i.id)).toEqual([
			"topic-1",
			"topic-3",
			"topic-2",
		]);
	});

	// ── FR14: per-viewer "why ranked" reason ────────────────────────────────
	// Fixture: viewer-1 contributed to topic-1 AND topic-1 is role-matched
	// (DEVELOPER) — so it exercises PRECEDENCE (contributed wins over role_match);
	// topic-3 is role-matched (DEVELOPER) but NOT contributed; topic-2 is neither.
	const rowsThreeTiers = () =>
		rowsViewerOwnsOldest().map((r) =>
			r.id === "topic-3"
				? {
						...r,
						contributorUserIds: ["user-x"],
						relevantFunctionTags: ["DEVELOPER"],
					}
				: r.id === "topic-1"
					? { ...r, relevantFunctionTags: ["DEVELOPER"] }
					: r,
		);

	it("stamps rankReason per tier and applies precedence: contributed(+role-matched)=contributed / role_match(+matchedTags) / null", async () => {
		publishingTopicFindMany.mockResolvedValue(rowsThreeTiers());
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
		]);
		viewerTagFindUnique.mockResolvedValue({ tags: ["DEVELOPER"] });

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});
		const byId = new Map(items.map((i) => [i.id, i]));

		// PRECEDENCE: topic-1 is BOTH contributed and role-matched → reads
		// contributed (tier 1 is tested before tier 2 in the partition), NOT
		// role_match — the reason always names the tier the topic occupies.
		expect(byId.get("topic-1")?.rankReason).toEqual({
			kind: "contributed",
		});
		expect(byId.get("topic-3")?.rankReason).toEqual({
			kind: "role_match",
			matchedTags: ["DEVELOPER"],
		});
		expect(byId.get("topic-2")?.rankReason).toBeNull();
	});

	it("returns intersection (not the viewer's full tag set) in matchedTags", async () => {
		const rows = rowsViewerOwnsOldest().map((r) =>
			r.id === "topic-3"
				? {
						...r,
						contributorUserIds: ["user-x"],
						relevantFunctionTags: ["DEVELOPER", "ARCHITECT"],
					}
				: r,
		);
		publishingTopicFindMany.mockResolvedValue(rows);
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
		]);
		// Viewer has DEVELOPER + SDET_QA; topic-3 has DEVELOPER + ARCHITECT →
		// intersection is DEVELOPER only.
		viewerTagFindUnique.mockResolvedValue({
			tags: ["DEVELOPER", "SDET_QA"],
		});

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});
		expect(items.find((i) => i.id === "topic-3")?.rankReason).toEqual({
			kind: "role_match",
			matchedTags: ["DEVELOPER"],
		});
	});

	it("every rankReason is null when handle resolution fails (degrade)", async () => {
		publishingTopicFindMany.mockResolvedValue(rowsThreeTiers());
		userFindMany.mockRejectedValue(new Error("connection reset"));

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});
		expect(items.every((i) => i.rankReason === null)).toBe(true);
	});

	it("has no role_match reasons when Function Tags is disabled (contributed still stamped)", async () => {
		isFunctionTagsEnabled.mockReturnValue(false);
		publishingTopicFindMany.mockResolvedValue(rowsThreeTiers());
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});
		expect(items.some((i) => i.rankReason?.kind === "role_match")).toBe(
			false,
		);
		// tier-1 contribution reason is independent of the flag.
		expect(items.find((i) => i.id === "topic-1")?.rankReason).toEqual({
			kind: "contributed",
		});
	});

	it("returns all-null reasons in recency order when the GRAFT throws after tier-1 is built — proves atomicity, not just null-on-early-throw", async () => {
		// DISCRIMINATING fault injection: the throw must land DURING the tier-2
		// graft — AFTER tier-1 reasons have been built — so an in-place-mutation
		// regression (which would have already mutated tier-1 items before
		// throwing) is CAUGHT. A tier-2 row whose `relevantFunctionTags.filter()`
		// throws fires ONLY at the graft's `matchedTags` step: the item map spreads
		// the array (no `.filter`), and the `roleMatched` filter uses `.some` — so
		// nothing touches this array's `.filter` until the tier-2 graft.
		const throwingTags = ["DEVELOPER"] as unknown as string[];
		(throwingTags as { filter: unknown }).filter = () => {
			throw new Error("forced graft failure");
		};
		const rows = [
			{
				id: "A-contributed",
				title: "Contributed (tier 1)",
				pitch: "a",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-16T00:00:00Z"), // newest
				suggestedPostTypes: [],
				contributorUserIds: ["viewer-1"],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
				provenance: { storyIds: ["s1"] },
			},
			{
				id: "B-rolematched",
				title: "Role-matched (tier 2)",
				pitch: "b",
				status: "SUGGESTION",
				origin: "AI",
				declineReason: null,
				createdById: null,
				createdAt: new Date("2026-07-15T00:00:00Z"),
				suggestedPostTypes: [],
				contributorUserIds: ["user-x"],
				// `.some()` (roleMatched) works normally → B lands in tier 2; the
				// overridden `.filter()` throws when the tier-2 graft computes
				// matchedTags — after tier-1 (A) has already been grafted.
				relevantFunctionTags: throwingTags,
				postTypeRecommendations: [],
				provenance: { docIds: ["d1"] },
			},
		];
		publishingTopicFindMany.mockResolvedValue(rows);
		userFindMany.mockResolvedValue([
			{ id: "viewer-1", name: "Viewer One", image: null, username: "v1" },
		]);
		viewerTagFindUnique.mockResolvedValue({ tags: ["DEVELOPER"] });
		storyFindMany.mockResolvedValue([{ id: "s1", title: "SA" }]);
		docFindMany.mockResolvedValue([{ id: "d1", title: "DB" }]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// Atomic impl: the graft built A's reason on a FRESH object, so the throw
		// leaves the original items untouched → catch returns them in recency
		// order, all null. An in-place impl would have mutated A's reason before
		// the throw and would FAIL the `every null` assertion below.
		expect(items.map((i) => i.id)).toEqual([
			"A-contributed",
			"B-rolematched",
		]);
		expect(items.every((i) => i.rankReason === null)).toBe(true);

		// The ranking catch returns the BASE items, which already carry the
		// resolution-time whySuggested (resolution runs before ranking) — so a
		// catch-path regression that dropped whySuggested would fail here.
		expect(
			items.find((i) => i.id === "A-contributed")?.whySuggested,
		).toEqual({
			named: [{ type: "story", label: "SA" }],
			prCount: 0,
			overflowCount: 0,
		});
		expect(
			items.find((i) => i.id === "B-rolematched")?.whySuggested,
		).toEqual({
			named: [{ type: "document", label: "DB" }],
			prCount: 0,
			overflowCount: 0,
		});
	});
});

describe("listPublishingTopics — author recommendations (FR4-8, UC2/UC3)", () => {
	// Two contributors on ONE topic; a roster tags each with a discipline. The
	// topic's relevantFunctionTags decide who is a candidate.
	const authorRow = (
		relevantFunctionTags: string[],
		contributorUserIds: string[],
	) => [
		{
			id: "topic-1",
			title: "Only topic",
			pitch: "p",
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			publishedUrl: null,
			createdById: null,
			createdAt: new Date("2026-07-16T00:00:00Z"),
			suggestedPostTypes: [],
			contributorUserIds,
			relevantFunctionTags,
			postTypeRecommendations: [],
		},
	];
	const handles = (...ids: string[]) =>
		ids.map((id) => ({
			id,
			name: id.toUpperCase(),
			image: null,
			username: id,
		}));

	it("recommends a SINGLE author when exactly one contributor's roster tags match the topic's relevantFunctionTags", async () => {
		publishingTopicFindMany.mockResolvedValue(
			authorRow(["DEVELOPER"], ["alice", "bob"]),
		);
		userFindMany.mockResolvedValue(handles("alice", "bob"));
		getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "alice", tags: ["DEVELOPER"] },
			{ userId: "bob", tags: ["DESIGNER"] },
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer",
		});

		expect(items[0].authorRecommendation).toEqual({
			model: "single",
			authors: [
				{
					id: "alice",
					name: "ALICE",
					image: null,
					username: "alice",
					matchedTags: ["DEVELOPER"],
				},
			],
		});
	});

	it("recommends CO-AUTHORS ordered by matched-tag count desc, stable on ties, capped at 3", async () => {
		publishingTopicFindMany.mockResolvedValue(
			authorRow(
				["DEVELOPER", "ARCHITECT"],
				["alice", "bob", "carol", "dave"],
			),
		);
		userFindMany.mockResolvedValue(
			handles("alice", "bob", "carol", "dave"),
		);
		getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "alice", tags: ["DEVELOPER"] }, // 1 match
			{ userId: "bob", tags: ["DEVELOPER", "ARCHITECT"] }, // 2 matches → first
			{ userId: "carol", tags: ["ARCHITECT"] }, // 1 match
			{ userId: "dave", tags: ["DEVELOPER"] }, // 1 match → dropped by cap
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer",
		});

		expect(items[0].authorRecommendation?.model).toBe("co_author");
		expect(items[0].authorRecommendation?.authors.map((a) => a.id)).toEqual(
			["bob", "alice", "carol"],
		); // bob (2) first; alice/carol tie keep input order; dave capped out
	});

	it("returns null when NO contributor holds a relevant discipline (fit-only)", async () => {
		publishingTopicFindMany.mockResolvedValue(
			authorRow(["DEVELOPER"], ["alice"]),
		);
		userFindMany.mockResolvedValue(handles("alice"));
		getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "alice", tags: ["DESIGNER"] },
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer",
		});
		expect(items[0].authorRecommendation).toBeNull();
	});

	it("returns null AND skips the roster read when Function Tags is disabled", async () => {
		isFunctionTagsEnabled.mockReturnValue(false);
		publishingTopicFindMany.mockResolvedValue(
			authorRow(["DEVELOPER"], ["alice"]),
		);
		userFindMany.mockResolvedValue(handles("alice"));

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer",
		});
		expect(items[0].authorRecommendation).toBeNull();
		expect(getProjectMemberFunctionTags).not.toHaveBeenCalled();
	});

	it("excludes a contributor who is not a current roster member (roster-scoped)", async () => {
		publishingTopicFindMany.mockResolvedValue(
			authorRow(["DEVELOPER"], ["ex-member"]),
		);
		userFindMany.mockResolvedValue(handles("ex-member")); // handle resolves (user still exists)
		getProjectMemberFunctionTags.mockResolvedValue([]); // but NOT in the roster

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer",
		});
		expect(items[0].authorRecommendation).toBeNull();
	});

	it("drops a candidate whose handle did not resolve (deleted user)", async () => {
		publishingTopicFindMany.mockResolvedValue(
			authorRow(["DEVELOPER"], ["alice", "ghost"]),
		);
		userFindMany.mockResolvedValue(handles("alice")); // ghost deleted → no handle
		getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "alice", tags: ["DEVELOPER"] },
			{ userId: "ghost", tags: ["DEVELOPER"] },
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer",
		});
		expect(items[0].authorRecommendation?.authors.map((a) => a.id)).toEqual(
			["alice"],
		);
	});

	// AC-AR6 — the load-bearing degrade test on a DISCRIMINATING three-tier
	// fixture: a roster-read failure must null the recommendations while leaving
	// the active three-tier ranked order AND rankReason byte-identical to the
	// successful baseline — NOT collapse to recency.
	//
	// Fixture (mirrors the FR3 discriminating case): viewer-1 contributed to A
	// (newest); B is role-matched (DEVELOPER) but OLDER than the non-matched C.
	// Three-tier order = [A, B, C] (B hoisted above C); recency order = [A, C, B].
	const threeTierRows = () => [
		{
			id: "A",
			title: "Viewer-contributed",
			pitch: "a",
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			publishedUrl: null,
			createdById: null,
			createdAt: new Date("2026-07-16T00:00:00Z"), // newest
			suggestedPostTypes: [],
			contributorUserIds: ["viewer-1"],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		},
		{
			id: "C",
			title: "Neither",
			pitch: "c",
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			publishedUrl: null,
			createdById: null,
			createdAt: new Date("2026-07-15T00:00:00Z"), // middle
			suggestedPostTypes: [],
			contributorUserIds: ["user-x"],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
		},
		{
			id: "B",
			title: "Role-matched, not contributed",
			pitch: "b",
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			publishedUrl: null,
			createdById: null,
			createdAt: new Date("2026-07-14T00:00:00Z"), // oldest
			suggestedPostTypes: [],
			contributorUserIds: ["user-y"],
			relevantFunctionTags: ["DEVELOPER"],
			postTypeRecommendations: [],
		},
	];

	it("AC-AR6: a roster-read failure yields null recommendations while PRESERVING contributors, the three-tier ranked order, and rankReason (not recency)", async () => {
		// Baseline: roster read SUCCEEDS. Establish the exact contributors,
		// ranked order + rankReason the failure path must reproduce. Resolve
		// EVERY fixture contributor's handle so the `contributors` projection is
		// non-trivial and the failure path's preservation of it is actually
		// verifiable (Codex plan-review).
		publishingTopicFindMany.mockResolvedValue(threeTierRows());
		const allHandles = [
			{ id: "viewer-1", name: "V", image: null, username: "v1" },
			{ id: "user-x", name: "X", image: null, username: "ux" },
			{ id: "user-y", name: "Y", image: null, username: "uy" },
		];
		userFindMany.mockResolvedValue(allHandles);
		viewerTagFindUnique.mockResolvedValue({ tags: ["DEVELOPER"] });
		getProjectMemberFunctionTags.mockResolvedValue([]); // no author recs either way

		const baseline = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});
		expect(baseline.items.map((i) => i.id)).toEqual(["A", "B", "C"]); // three-tier, NOT recency [A, C, B]

		// Now force ONLY the roster read to throw; viewer-tag read + handles still succeed.
		getProjectMemberFunctionTags.mockRejectedValue(
			new Error("roster read down"),
		);
		const degraded = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer-1",
		});

		// Recommendations gone…
		expect(
			degraded.items.every((i) => i.authorRecommendation === null),
		).toBe(true);
		// …but contributors, order, AND rankReason are IDENTICAL to the
		// successful baseline (three-tier preserved, NOT collapsed to recency).
		expect(degraded.items.map((i) => i.id)).toEqual(["A", "B", "C"]);
		expect(degraded.items.map((i) => i.contributors)).toEqual(
			baseline.items.map((i) => i.contributors),
		);
		expect(degraded.items.map((i) => i.rankReason)).toEqual(
			baseline.items.map((i) => i.rankReason),
		);
	});

	it("dedupes duplicated topic disciplines and duplicated contributor ids (no inflated matches, no doubled author)", async () => {
		// Both arrays carry defensive duplicates (Postgres arrays, no uniqueness
		// constraint). The recommendation must list the contributor ONCE with a
		// deduped matchedTags, not twice / inflated (Codex plan-review).
		publishingTopicFindMany.mockResolvedValue(
			authorRow(["DEVELOPER", "DEVELOPER"], ["alice", "alice"]),
		);
		userFindMany.mockResolvedValue(handles("alice"));
		getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "alice", tags: ["DEVELOPER", "DEVELOPER"] },
		]);

		const { items } = await listPublishingTopics({
			projectId: "proj-1",
			viewerUserId: "viewer",
		});
		expect(items[0].authorRecommendation).toEqual({
			model: "single",
			authors: [
				{
					id: "alice",
					name: "ALICE",
					image: null,
					username: "alice",
					matchedTags: ["DEVELOPER"],
				},
			],
		});
	});
});

describe("listPublishingTopics — angle passthrough (FR9/10)", () => {
	const baseRow = (over: Record<string, unknown>) => ({
		id: "t1",
		title: "T",
		pitch: "p",
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		createdAt: new Date("2026-07-16T00:00:00Z"),
		suggestedPostTypes: [],
		contributorUserIds: [],
		relevantFunctionTags: [],
		postTypeRecommendations: [],
		angle: null,
		...over,
	});

	it("surfaces angle on list items (present + null)", async () => {
		publishingTopicFindMany.mockResolvedValue([
			baseRow({ id: "a", angle: "Engineering deep-dive" }),
			baseRow({ id: "b", angle: null }),
		]);
		userFindMany.mockResolvedValue([]);
		const { items } = await listPublishingTopics({
			projectId: "p1",
			viewerUserId: "v1",
		});
		expect(items.find((i) => i.id === "a")?.angle).toBe(
			"Engineering deep-dive",
		);
		expect(items.find((i) => i.id === "b")?.angle).toBeNull();
	});

	it("surfaces angle even on the handle-failure degrade path", async () => {
		publishingTopicFindMany.mockResolvedValue([
			baseRow({ id: "a", angle: "Exec summary" }),
		]);
		userFindMany.mockRejectedValue(new Error("connection reset"));
		const { items } = await listPublishingTopics({
			projectId: "p1",
			viewerUserId: "v1",
		});
		expect(items[0].angle).toBe("Exec summary");
	});
});

describe("listPublishingTopics — whySuggested provenance (composition)", () => {
	function topicRow(over: Record<string, unknown> = {}) {
		return {
			id: "t1",
			title: "T",
			pitch: null,
			status: "SUGGESTION",
			origin: "AI",
			declineReason: null,
			publishedUrl: null,
			createdById: null,
			createdAt: new Date(),
			suggestedPostTypes: [],
			relevantFunctionTags: [],
			postTypeRecommendations: [],
			contributorUserIds: [],
			angle: null,
			provenance: null,
			...over,
		};
	}

	async function listOneTopic(over: Record<string, unknown>) {
		publishingTopicFindMany.mockResolvedValue([topicRow(over)]);
		userFindMany.mockResolvedValue([]);
		viewerTagFindUnique.mockResolvedValue(null);
		const { items } = await listPublishingTopics({
			projectId: "p1",
			viewerUserId: "v1",
		});
		return items[0];
	}

	it("whySuggested: orders stories→docs→meetings, caps at 3, overflow excludes PRs", async () => {
		storyFindMany.mockResolvedValue([
			{ id: "s1", title: "Story One" },
			{ id: "s2", title: "Story Two" },
		]);
		docFindMany.mockResolvedValue([{ id: "d1", title: "Doc One" }]);
		meetingFindMany.mockResolvedValue([
			{ id: "m1", meetingSubject: "Kickoff" },
		]);
		const item = await listOneTopic({
			provenance: {
				storyIds: ["s1", "s2"],
				docIds: ["d1"],
				transcriptIds: ["m1"],
				repoPrs: [
					{ repoFullName: "o/r", prNumber: 1 },
					{ repoFullName: "o/r", prNumber: 2 },
				],
			},
		});
		expect(item?.whySuggested).toEqual({
			named: [
				{ type: "story", label: "Story One" },
				{ type: "story", label: "Story Two" },
				{ type: "document", label: "Doc One" },
			],
			prCount: 2,
			overflowCount: 1, // the meeting overflows the cap; PRs are NOT in overflow
		});
		// AC-WS13: raw provenance never serialized.
		expect("provenance" in (item as object)).toBe(false);
	});

	it("whySuggested: dedupes duplicate story IDs and duplicate PRs (no inflation)", async () => {
		storyFindMany.mockResolvedValue([{ id: "s1", title: "Dupe Story" }]);
		const item = await listOneTopic({
			provenance: {
				storyIds: ["s1", "s1"],
				repoPrs: [
					{ repoFullName: "o/r", prNumber: 5 },
					{ repoFullName: "o/r", prNumber: 5 },
				],
			},
		});
		expect(item?.whySuggested).toEqual({
			named: [{ type: "story", label: "Dupe Story" }],
			prCount: 1,
			overflowCount: 0,
		});
	});

	it('whySuggested: meeting subject null/empty/whitespace-only → bare label ""; PR-only topic is non-null', async () => {
		// AC-WS5: `meetingSubject?.trim() || ""` — a whitespace-only subject must
		// also collapse to "". Dropping `.trim()` would surface "   " meeting, which
		// this loop catches (the plain null case alone would not).
		for (const subject of [null, "", "   "]) {
			meetingFindMany.mockResolvedValue([
				{ id: "m1", meetingSubject: subject },
			]);
			const item = await listOneTopic({
				provenance: { transcriptIds: ["m1"] },
			});
			expect(item?.whySuggested).toEqual({
				named: [{ type: "meeting", label: "" }],
				prCount: 0,
				overflowCount: 0,
			});
		}
		const prOnly = await listOneTopic({
			provenance: { repoPrs: [{ repoFullName: "o/r", prNumber: 9 }] },
		});
		expect(prOnly?.whySuggested).toEqual({
			named: [],
			prCount: 1,
			overflowCount: 0,
		});
	});

	it("whySuggested: drops an unresolved (deleted/foreign) source without nulling the line", async () => {
		storyFindMany.mockResolvedValue([{ id: "s1", title: "Kept" }]); // s2 unresolved
		const item = await listOneTopic({
			provenance: { storyIds: ["s1", "s2"] },
		});
		expect(item?.whySuggested).toEqual({
			named: [{ type: "story", label: "Kept" }],
			prCount: 0,
			overflowCount: 0,
		});
	});

	it("whySuggested: null for null provenance, empty provenance, and nothing-resolved-no-PRs", async () => {
		expect(
			(await listOneTopic({ provenance: null }))?.whySuggested,
		).toBeNull();
		expect(
			(await listOneTopic({ provenance: {} }))?.whySuggested,
		).toBeNull();
		// storyIds present but none resolve, no PRs → null
		expect(
			(await listOneTopic({ provenance: { storyIds: ["gone"] } }))
				?.whySuggested,
		).toBeNull();
	});

	it("whySuggested: chunks the IN reads into bounded 500/1 partitions (no overlap, no lost chunk, tenant-scoped)", async () => {
		const ids = Array.from({ length: 501 }, (_, i) => `s${i}`);
		storyFindMany.mockImplementation(
			async (args: { where: { id: { in: string[] } } }) =>
				args.where.id.in.map((id) => ({ id, title: id })),
		);
		const item = await listOneTopic({ provenance: { storyIds: ids } });

		// Inspect the ACTUAL query arguments — two BOUNDED chunks of exactly 500 + 1,
		// not one unbounded IN and not overlapping reads (a mock returning rows for
		// whatever it is given would otherwise false-green on call count alone).
		const wheres = storyFindMany.mock.calls.map(
			(c) =>
				(c[0] as { where: { id: { in: string[] }; projectId: string } })
					.where,
		);
		expect(wheres).toHaveLength(2); // ceil(501 / 500)
		expect(wheres[0].id.in).toHaveLength(500);
		expect(wheres[1].id.in).toHaveLength(1);
		expect(wheres.every((w) => w.projectId === "p1")).toBe(true); // every chunk tenant-scoped
		// Exact set-equality with the INPUT ids — proves the chunks query THESE
		// provenance ids (not 501 other in-project ids), and (size 501) no overlap.
		expect(new Set([...wheres[0].id.in, ...wheres[1].id.in])).toEqual(
			new Set(ids),
		);
		// All 501 resolved (named capped at 3, so overflow reflects the full total).
		expect(item?.whySuggested?.named).toHaveLength(3);
		expect(item?.whySuggested?.overflowCount).toBe(498);
	});

	it("whySuggested: degrades to null on a resolution failure WITHOUT altering ANY other field (discriminating)", async () => {
		// Discriminating fixture: t1 has a NON-NULL rankReason (viewer contributes)
		// AND a NON-NULL authorRecommendation (roster tag match); t2 is neither.
		// Capture a success baseline, then fail the read and assert ONLY whySuggested
		// flips to null — a handler that also cleared rankReason / recs / contributors
		// / reordered would be caught (the old one-topic test could not).
		const rows = [
			topicRow({
				id: "t1",
				title: "T1",
				pitch: "p1",
				angle: "A1",
				contributorUserIds: ["v1"],
				relevantFunctionTags: ["DEVELOPER"],
				provenance: { storyIds: ["s1"] },
				createdAt: new Date("2026-07-16T00:00:00Z"),
			}),
			topicRow({
				id: "t2",
				title: "T2",
				pitch: "p2",
				contributorUserIds: [],
				provenance: { storyIds: ["s2"] },
				createdAt: new Date("2026-07-15T00:00:00Z"),
			}),
		];
		publishingTopicFindMany.mockResolvedValue(rows);
		userFindMany.mockResolvedValue([
			{ id: "v1", name: "V", image: null, username: "v1" },
		]);
		viewerTagFindUnique.mockResolvedValue(null);
		getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "v1", tags: ["DEVELOPER"] },
		]);

		// Baseline — resolution succeeds.
		storyFindMany.mockResolvedValue([
			{ id: "s1", title: "One" },
			{ id: "s2", title: "Two" },
		]);
		const base = (
			await listPublishingTopics({ projectId: "p1", viewerUserId: "v1" })
		).items;
		const bt1 = base.find((i) => i.id === "t1");
		expect(bt1?.whySuggested).not.toBeNull();
		expect(bt1?.rankReason).toEqual({ kind: "contributed" });
		expect(bt1?.authorRecommendation).not.toBeNull();

		// Failure — a resolution read throws.
		storyFindMany.mockReset().mockRejectedValue(new Error("boom"));
		const after = (
			await listPublishingTopics({ projectId: "p1", viewerUserId: "v1" })
		).items;
		expect(after.map((i) => i.id)).toEqual(base.map((i) => i.id)); // order unchanged
		for (const i of after) {
			expect(i.whySuggested).toBeNull(); // EVERY line degraded (atomic)
		}
		const at1 = after.find((i) => i.id === "t1");
		expect(at1?.rankReason).toEqual({ kind: "contributed" }); // untouched
		expect(at1?.authorRecommendation).toEqual(bt1?.authorRecommendation); // untouched
		expect(at1?.contributors).toEqual(bt1?.contributors); // untouched
		expect(at1?.title).toBe("T1");
		expect(at1?.pitch).toBe("p1");
		expect(at1?.angle).toBe("A1");
	});

	// AC-WS10: whySuggested is grafted onto the BASE items, so it must survive every
	// return path. These two cases assert it concretely on the !handlesResolved early
	// return, the tier-1 graft, and the tier-3 passthrough. (The ranking `catch` is
	// structurally identical to tier-3 — it returns the same base `items` — and pure
	// array partitioning cannot throw, so it is not separately contrived.)
	it("whySuggested survives the handle-resolution-failure early return (independent of handles)", async () => {
		storyFindMany.mockResolvedValue([{ id: "s1", title: "Kept" }]);
		// NOTE: contributorUserIds MUST be non-empty — the live code only calls
		// db.user.findMany when the flattened contributor id set is non-empty
		// (`allIds.length ? findMany : []`), so an empty set would leave the reject
		// mock unused, handlesResolved=true, and this test a false green (Codex).
		publishingTopicFindMany.mockResolvedValue([
			topicRow({
				id: "t1",
				contributorUserIds: ["u1"],
				provenance: { storyIds: ["s1"] },
			}),
		]);
		userFindMany.mockRejectedValue(new Error("handles down")); // → !handlesResolved early return
		viewerTagFindUnique.mockResolvedValue(null);
		const { items } = await listPublishingTopics({
			projectId: "p1",
			viewerUserId: "v1",
		});
		expect(userFindMany).toHaveBeenCalled(); // prove the reject path (early return) was actually hit
		expect(items[0]?.whySuggested).toEqual({
			named: [{ type: "story", label: "Kept" }],
			prCount: 0,
			overflowCount: 0,
		});
		expect(items[0]?.contributors).toEqual([]); // handle degrade still honored
	});

	it("whySuggested survives the ranking graft (tier 1) and the tier-3 passthrough", async () => {
		storyFindMany.mockResolvedValue([
			{ id: "s1", title: "Story A" },
			{ id: "s2", title: "Story B" },
		]);
		publishingTopicFindMany.mockResolvedValue([
			topicRow({
				id: "t1",
				contributorUserIds: ["v1"],
				provenance: { storyIds: ["s1"] },
			}),
			topicRow({
				id: "t2",
				contributorUserIds: [],
				provenance: { storyIds: ["s2"] },
			}),
		]);
		userFindMany.mockResolvedValue([
			{ id: "v1", name: "V", image: null, username: null },
		]);
		viewerTagFindUnique.mockResolvedValue(null);
		const { items } = await listPublishingTopics({
			projectId: "p1",
			viewerUserId: "v1",
		});
		const t1 = items.find((i) => i.id === "t1"); // tier 1 (grafted rankReason)
		const t2 = items.find((i) => i.id === "t2"); // tier 3 (passthrough)
		expect(t1?.rankReason).toEqual({ kind: "contributed" });
		expect(t1?.whySuggested).toEqual({
			named: [{ type: "story", label: "Story A" }],
			prCount: 0,
			overflowCount: 0,
		});
		expect(t2?.rankReason).toBeNull();
		expect(t2?.whySuggested).toEqual({
			named: [{ type: "story", label: "Story B" }],
			prCount: 0,
			overflowCount: 0,
		});
	});
});

describe("listPublishingTopics — deterministic list order", () => {
	// `createdAt` alone is NOT a total order here. A generation cycle writes
	// its topics in one batch, so every topic from that cycle carries the SAME
	// `createdAt` down to the millisecond — ties are the rule, not the edge
	// case. Postgres may return tied rows in any order, and an UPDATE to one
	// of them (a snooze, a status change) can move it, so the Inbox silently
	// reshuffles after an unrelated write. Observed on a staging project whose
	// four topics formed two exactly-tied pairs.
	//
	// This asserts the QUERY rather than the returned array on purpose: the
	// ordering is Postgres' to perform, and a mocked `findMany` returns
	// whatever the test handed it. The one thing this layer owns — and the one
	// thing that was wrong — is whether it ASKS for a total order.
	//
	// The tiebreaker must be a unique column; `id` is the same key the cycle
	// history query in this module already breaks ties on.
	it("asks Postgres for a total order, so tied createdAt values cannot reshuffle", async () => {
		publishingTopicFindMany.mockResolvedValue([]);
		userFindMany.mockResolvedValue([]);
		viewerTagFindUnique.mockResolvedValue(null);

		await listPublishingTopics({ projectId: "p1", viewerUserId: "v1" });

		const { orderBy } = publishingTopicFindMany.mock.calls[0][0];
		expect(orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
	});
});
