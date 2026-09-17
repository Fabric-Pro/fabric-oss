import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unified DRAFT version sequence (`listDraftTimeline`).
 *
 * Unit-level with a mocked `db`, matching `publishing-drafts.test.ts`: this
 * exercises the projection, not real Postgres semantics.
 *
 * Two behaviours here differ from the analysis sibling on purpose and are
 * asserted so the difference cannot be mistaken for a bug:
 *
 *   - FAILED generations are excluded, because `TopicDraftState.versions`
 *     always excluded them ("a failed attempt is not a version of anything").
 *     The analysis timeline includes them, because its stored scale already
 *     did.
 *   - as a consequence, `seq` CLOSES the gap that stored versions leave: a
 *     topic whose second run failed has stored READY versions 1, 3, 4 and the
 *     panel showed exactly that, with 2 missing and nothing to explain it.
 */

const { draftFindMany, revisionFindMany } = vi.hoisted(() => ({
	draftFindMany: vi.fn(),
	revisionFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopicDraft: { findMany: draftFindMany },
		publishingTopicDraftRevision: { findMany: revisionFindMany },
	},
	Prisma: {},
}));

import { listDraftTimeline } from "../prisma/queries/projects/publishing-draft-timeline";

const SCOPE = {
	topicId: "topic-1",
	projectId: "project-1",
	postType: "BLOG_POST" as const,
};

function at(minutes: number): Date {
	return new Date(Date.UTC(2026, 8, 1, 0, minutes, 0));
}

function draftRow(version: number, minutes: number) {
	return {
		id: `draft-${version}`,
		version,
		createdAt: at(minutes),
		requestedBy: { id: "u1", name: "Ada" },
	};
}

function revisionRow(
	version: number,
	minutes: number,
	kind: "EDITED" | "RESTORED",
	sourceDraftVersion: number | null,
) {
	return {
		id: `revision-${version}`,
		version,
		kind,
		sourceDraftVersion,
		changeSummary: kind === "RESTORED" ? "Restored from version 1" : null,
		createdAt: at(minutes),
		author: { id: "u2", name: "Grace" },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	draftFindMany.mockResolvedValue([]);
	revisionFindMany.mockResolvedValue([]);
});

describe("listDraftTimeline", () => {
	it("scopes both reads to topic, project AND postType", async () => {
		await listDraftTimeline(SCOPE);

		expect(draftFindMany.mock.calls[0][0].where).toEqual({
			...SCOPE,
			status: "READY",
		});
		expect(revisionFindMany.mock.calls[0][0].where).toEqual(SCOPE);
	});

	it("asks for READY generations only — a failed run is not a version", async () => {
		await listDraftTimeline(SCOPE);

		expect(draftFindMany.mock.calls[0][0].where.status).toBe("READY");
	});

	it("never selects the large columns — no body, no content", async () => {
		await listDraftTimeline(SCOPE);

		expect(draftFindMany.mock.calls[0][0].select).not.toHaveProperty(
			"content",
		);
		expect(revisionFindMany.mock.calls[0][0].select).not.toHaveProperty(
			"body",
		);
	});

	it("numbers a restore as the NEXT version — the case this change exists for", async () => {
		// Two generations, then the user restores v1. The restore must read as
		// v3, not leave the list unchanged.
		draftFindMany.mockResolvedValue([draftRow(1, 1), draftRow(2, 2)]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 3, "RESTORED", 1)]);

		const { entries } = await listDraftTimeline(SCOPE);

		expect(entries.map((e) => e.seq)).toEqual([3, 2, 1]);
		expect(entries[0]).toMatchObject({
			kind: "restored",
			seq: 3,
			revisionVersion: 1,
			sourceDraftVersion: 1,
			sourceSeq: 1,
		});
	});

	it("gives a hand edit its own entry — the loss this change repairs", async () => {
		draftFindMany.mockResolvedValue([draftRow(1, 1)]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 2, "EDITED", 1)]);

		const { entries } = await listDraftTimeline(SCOPE);

		expect(entries[0]).toMatchObject({
			kind: "edited",
			seq: 2,
			revisionVersion: 1,
		});
	});

	it("closes the gap that a failed run leaves in the stored numbering", async () => {
		// Stored READY versions 1, 3, 4 — run 2 failed and took a number. The
		// panel used to render "1, 3, 4" with nothing explaining the hole.
		draftFindMany.mockResolvedValue([
			draftRow(1, 1),
			draftRow(3, 3),
			draftRow(4, 4),
		]);

		const { entries } = await listDraftTimeline(SCOPE);

		expect(entries.map((e) => e.seq)).toEqual([3, 2, 1]);
		expect(
			entries.map((e) => (e as { draftVersion: number }).draftVersion),
		).toEqual([4, 3, 1]);
	});

	it("remaps sourceDraftVersion onto the unified scale", async () => {
		// Stored draft 3 sits at seq 3 here only because nothing interleaved
		// before it; the revision at seq 4 cites stored 3 and must show seq 3.
		draftFindMany.mockResolvedValue([
			draftRow(1, 1),
			draftRow(2, 2),
			draftRow(3, 3),
		]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 4, "EDITED", 3)]);

		const { entries } = await listDraftTimeline(SCOPE);

		expect(entries[0]).toMatchObject({
			seq: 4,
			sourceDraftVersion: 3,
			sourceSeq: 3,
		});
	});

	it("gives sourceSeq null rather than a wrong number when the generation is absent", async () => {
		// Cites a version that failed, so it is not in the READY set.
		draftFindMany.mockResolvedValue([draftRow(1, 1)]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 2, "EDITED", 99)]);

		const { entries } = await listDraftTimeline(SCOPE);

		expect(entries[0]).toMatchObject({
			sourceDraftVersion: 99,
			sourceSeq: null,
		});
	});

	it("carries null sourceDraftVersion through as null", async () => {
		revisionFindMany.mockResolvedValue([revisionRow(1, 1, "EDITED", null)]);

		const { entries } = await listDraftTimeline(SCOPE);

		expect(entries[0]).toMatchObject({
			sourceDraftVersion: null,
			sourceSeq: null,
		});
	});

	it("breaks a shared timestamp generation-first, deterministically", async () => {
		draftFindMany.mockResolvedValue([draftRow(1, 5)]);
		revisionFindMany.mockResolvedValue([revisionRow(1, 5, "RESTORED", 1)]);

		const { entries } = await listDraftTimeline(SCOPE);

		expect(entries.map((e) => ({ kind: e.kind, seq: e.seq }))).toEqual([
			{ kind: "restored", seq: 2 },
			{ kind: "generated", seq: 1 },
		]);
	});

	it("pages newest-first with a strictly-below cursor", async () => {
		draftFindMany.mockResolvedValue([
			draftRow(1, 1),
			draftRow(2, 2),
			draftRow(3, 3),
			draftRow(4, 4),
		]);

		const first = await listDraftTimeline({ ...SCOPE, limit: 2 });
		expect(first.entries.map((e) => e.seq)).toEqual([4, 3]);
		expect(first.nextCursor).toBe(3);

		const second = await listDraftTimeline({
			...SCOPE,
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.entries.map((e) => e.seq)).toEqual([2, 1]);
		expect(second.nextCursor).toBeNull();
	});

	it("clamps an oversized limit rather than trusting the caller", async () => {
		draftFindMany.mockResolvedValue(
			Array.from({ length: 120 }, (_, i) => draftRow(i + 1, i + 1)),
		);

		const { entries } = await listDraftTimeline({ ...SCOPE, limit: 5000 });

		expect(entries).toHaveLength(100);
	});

	it("returns nothing for a content type with no drafts and no revisions", async () => {
		const { entries, nextCursor } = await listDraftTimeline(SCOPE);

		expect(entries).toEqual([]);
		expect(nextCursor).toBeNull();
	});
});
