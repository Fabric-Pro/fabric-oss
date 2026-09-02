import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Draft reads for the Topic Item Page's generation tabs (Fizzy #1853, 2B-1).
 *
 * Unit-level with a mocked `db`, matching `publishing-planning-analysis.test.ts`:
 * this exercises the read's SHAPE — what it is scoped by, how many rows it asks
 * for, and how `isExpired` is derived — not real Postgres semantics. It
 * therefore runs in the regular no-Postgres suite and is NOT part of the
 * `db-integration` count guards. The constraints, the cascades and the RLS
 * policy are proved against a real server in
 * `publishing-suite-constraints.test.ts` and `rls-isolation.test.ts`.
 */

const { draftFindFirst, draftFindMany, workingFindMany } = vi.hoisted(() => ({
	draftFindFirst: vi.fn(),
	draftFindMany: vi.fn(),
	workingFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopicDraft: {
			findFirst: draftFindFirst,
			findMany: draftFindMany,
		},
		publishingTopicWorkingDraft: { findMany: workingFindMany },
	},
	Prisma: {},
}));

import { listTopicDrafts } from "../prisma/queries/projects/publishing-drafts";

const SCOPE = { topicId: "topic-1", projectId: "project-1" };

function row(over: Record<string, unknown> = {}) {
	return {
		id: "draft-1",
		content: null,
		postType: "TWEET",
		version: 1,
		status: "READY",
		guidance: null,
		model: null,
		promptSource: null,
		promptId: null,
		promptVersion: null,
		error: null,
		requestedById: null,
		executionTimeoutAt: null,
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T10:00:00Z"),
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	draftFindMany.mockResolvedValue([]);
	workingFindMany.mockResolvedValue([]);
});

describe("listTopicDrafts — scoping", () => {
	it("filters by BOTH topicId and projectId on every read", async () => {
		await listTopicDrafts(SCOPE);

		// DV16: a valid topic id from another project must yield the same empty
		// answer a topic with no drafts yields — never a distinguishable error.
		// Scoping by topicId alone would make this endpoint a probe for the
		// existence of topics in projects the caller cannot see.
		for (const call of draftFindMany.mock.calls) {
			expect(call[0].where).toMatchObject({
				topicId: "topic-1",
				projectId: "project-1",
			});
		}
		for (const call of workingFindMany.mock.calls) {
			expect(call[0].where).toMatchObject({
				topicId: "topic-1",
				projectId: "project-1",
			});
		}
		expect(draftFindMany).toHaveBeenCalled();
		expect(workingFindMany).toHaveBeenCalled();
	});

	it("selects the draft content, now that a panel renders it", async () => {
		await listTopicDrafts(SCOPE);

		// INVERTED IN 2B-2, deliberately. The 2B-1 version of this case asserted
		// `content` was NOT selected, on the stated grounds that shipping a blob
		// to a page which cannot display it is bytes over the wire for nothing —
		// and it named the condition for changing it: "the field 2B-2 will add
		// deliberately when a reader for it exists". That reader is
		// `ShortPostPanel`, which renders the three options out of this column.
		//
		// Rewritten rather than deleted, and asserted in the positive direction,
		// because deleting it would leave nothing pinning either answer.
		for (const call of draftFindMany.mock.calls) {
			expect(call[0].select?.content).toBe(true);
		}
	});

	it("selects the working-draft body, now that a panel renders it", async () => {
		await listTopicDrafts(SCOPE);

		// Also inverted in 2B-2. The 2B-1 comment framed this partly as a
		// privacy hedge — the weakest publishing permission plus `user_owned`
		// RLS meaning every org member can read it — and left "org-visible or
		// author-private" open. It is settled: a working draft is SHARED project
		// content (see `PublishingTopicWorkingDraft`), one per topic and content
		// type with no owner column, so every project member is entitled to it.
		// Withholding it was never about who may read it, only about nothing
		// rendering it yet.
		for (const call of workingFindMany.mock.calls) {
			expect(call[0].select?.body).toBe(true);
		}
	});
});

describe("listTopicDrafts — two rows per post type", () => {
	it("reports the latest attempt and the latest READY row separately", async () => {
		const failed = row({ id: "v2", version: 2, status: "FAILED" });
		const ready = row({ id: "v1", version: 1, status: "READY" });
		draftFindMany.mockResolvedValue([failed, ready]);

		const result = await listTopicDrafts(SCOPE);
		const tweet = result.drafts.find((d) => d.postType === "TWEET");

		// A failed regeneration must not blank a good previous draft. Collapsing
		// these to "the newest row" would hide the last good one precisely when
		// a reader most wants it.
		expect(tweet?.latestAttempt?.id).toBe("v2");
		expect(tweet?.latestReady?.id).toBe("v1");
	});

	it("keeps latestReady null when no attempt has ever succeeded", async () => {
		draftFindMany.mockResolvedValue([
			row({ id: "v1", version: 1, status: "FAILED" }),
		]);

		const result = await listTopicDrafts(SCOPE);
		const tweet = result.drafts.find((d) => d.postType === "TWEET");

		expect(tweet?.latestAttempt?.id).toBe("v1");
		expect(tweet?.latestReady).toBeNull();
	});

	it("keeps post types independent of one another", async () => {
		draftFindMany.mockResolvedValue([
			row({ id: "t1", postType: "TWEET", status: "READY" }),
			row({ id: "b1", postType: "BLOG_POST", status: "FAILED" }),
		]);

		const result = await listTopicDrafts(SCOPE);

		expect(
			result.drafts.find((d) => d.postType === "TWEET")?.latestReady?.id,
		).toBe("t1");
		expect(
			result.drafts.find((d) => d.postType === "BLOG_POST")?.latestReady,
		).toBeNull();
		expect(
			result.drafts.find((d) => d.postType === "BLOG_POST")?.latestAttempt
				?.id,
		).toBe("b1");
	});
});

describe("listTopicDrafts — isExpired", () => {
	it("is true only for a GENERATING row past its deadline", async () => {
		const past = new Date(Date.now() - 60_000);
		draftFindMany.mockResolvedValue([
			row({
				id: "stranded",
				status: "GENERATING",
				executionTimeoutAt: past,
			}),
		]);

		const result = await listTopicDrafts(SCOPE);

		// The only code that reclaims a stranded row runs inside the NEXT
		// attempt, so a UI that disables its button on `status === GENERATING`
		// alone would lock the content type with no user action able to free it.
		expect(
			result.drafts.find((d) => d.postType === "TWEET")?.latestAttempt
				?.isExpired,
		).toBe(true);
	});

	it("is false for a GENERATING row still inside its deadline", async () => {
		draftFindMany.mockResolvedValue([
			row({
				id: "live",
				status: "GENERATING",
				executionTimeoutAt: new Date(Date.now() + 600_000),
			}),
		]);

		const result = await listTopicDrafts(SCOPE);

		expect(
			result.drafts.find((d) => d.postType === "TWEET")?.latestAttempt
				?.isExpired,
		).toBe(false);
	});

	it("is false for a terminal row whose deadline has passed", async () => {
		// A terminal row may keep a stale deadline. Deriving expiry from the
		// timestamp alone would report a finished draft as stranded.
		draftFindMany.mockResolvedValue([
			row({
				id: "done",
				status: "READY",
				executionTimeoutAt: new Date(Date.now() - 600_000),
			}),
		]);

		const result = await listTopicDrafts(SCOPE);

		expect(
			result.drafts.find((d) => d.postType === "TWEET")?.latestAttempt
				?.isExpired,
		).toBe(false);
	});
});

describe("listTopicDrafts — working drafts", () => {
	it("reports the body alongside its provenance", async () => {
		workingFindMany.mockResolvedValue([
			{
				postType: "BLOG_POST",
				body: "A saved draft.",
				sourceOptionLabel: null,
				updatedAt: new Date("2026-09-01T11:00:00Z"),
			},
		]);

		const result = await listTopicDrafts(SCOPE);

		expect(result.workingDrafts).toEqual([
			{
				postType: "BLOG_POST",
				hasBody: true,
				body: "A saved draft.",
				sourceOptionLabel: null,
				updatedAt: new Date("2026-09-01T11:00:00Z"),
			},
		]);
	});

	it("reports an EMPTY body as nothing saved", async () => {
		// `hasBody` is derived from the text rather than from the row existing.
		// A row whose body is blank would otherwise read as a saved draft and
		// the panel would render an empty box under a "Working short post"
		// heading — the shape of content, with none in it.
		workingFindMany.mockResolvedValue([
			{
				postType: "BLOG_POST",
				body: "   ",
				sourceOptionLabel: null,
				updatedAt: new Date("2026-09-01T11:00:00Z"),
			},
		]);

		const result = await listTopicDrafts(SCOPE);

		expect(result.workingDrafts[0].hasBody).toBe(false);
	});

	it("returns an empty list when the topic has none", async () => {
		const result = await listTopicDrafts(SCOPE);
		expect(result.workingDrafts).toEqual([]);
	});
});
