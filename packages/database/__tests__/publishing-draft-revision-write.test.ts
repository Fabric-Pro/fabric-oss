import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The history append on the two working-draft writers.
 *
 * Unit-level with a mocked `db` and a pass-through `$transaction`, so what is
 * under test is the ORDER of operations rather than Postgres semantics.
 *
 * The property that matters most, and the one a later refactor is most likely
 * to break: THE APPEND RIDES A WON COMPARE-AND-SET. A revision is a consequence
 * of a write that succeeded, never a second chance at one — a losing writer
 * must leave no history entry at all, or the drawer would show versions for
 * text that was never saved.
 *
 * Also pinned here:
 *   - first adoption mints NOTHING (it replaces no body, and the candidate is
 *     already an entry in its own right);
 *   - a restore mints a RESTORED row naming the version it came from;
 *   - the one-shot backstop records a body that predates the history table, so
 *     the first restore after deploy does not discard the very text this
 *     feature exists to protect.
 */

const { lockProjectTenant } = vi.hoisted(() => ({
	lockProjectTenant: vi.fn(),
}));
const m = vi.hoisted(() => ({
	draftFindFirst: vi.fn(),
	workingFindUnique: vi.fn(),
	workingFindFirst: vi.fn(),
	workingUpsert: vi.fn(),
	workingUpdateMany: vi.fn(),
	workingFindUniqueOrThrow: vi.fn(),
	revisionAggregate: vi.fn(),
	revisionCreate: vi.fn(),
	revisionFindFirst: vi.fn(),
}));

const tx = {
	publishingTopicDraft: { findFirst: m.draftFindFirst },
	publishingTopicWorkingDraft: {
		findUnique: m.workingFindUnique,
		findFirst: m.workingFindFirst,
		upsert: m.workingUpsert,
		updateMany: m.workingUpdateMany,
		findUniqueOrThrow: m.workingFindUniqueOrThrow,
	},
	publishingTopicDraftRevision: {
		aggregate: m.revisionAggregate,
		create: m.revisionCreate,
		findFirst: m.revisionFindFirst,
	},
};

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (fn: (t: unknown) => unknown) => fn(tx),
	},
	Prisma: {},
}));
vi.mock("../prisma/queries/projects/publishing-tenant-lock", () => ({
	lockProjectTenant,
	uniqueViolationConstraint: () => null,
}));

import {
	saveWorkingDraft,
	updateWorkingDraftBody,
} from "../prisma/queries/projects/publishing-drafts";

const SCOPE = {
	topicId: "topic-1",
	projectId: "project-1",
	postType: "BLOG_POST" as const,
};
const NOW = new Date("2026-09-17T12:00:00Z");

beforeEach(() => {
	vi.clearAllMocks();
	lockProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: null,
	});
	m.draftFindFirst.mockResolvedValue({ id: "draft-1", version: 2 });
	m.workingUpsert.mockResolvedValue({ updatedAt: NOW });
	m.workingUpdateMany.mockResolvedValue({ count: 1 });
	m.workingFindUniqueOrThrow.mockResolvedValue({ updatedAt: NOW });
	m.revisionAggregate.mockResolvedValue({ _max: { version: 0 } });
	m.revisionCreate.mockResolvedValue({});
	// A revision already exists, so the one-shot backstop stays quiet unless a
	// test says otherwise.
	m.revisionFindFirst.mockResolvedValue({ id: "existing-revision" });
});

describe("saveWorkingDraft — adoption and restore", () => {
	it("mints NOTHING on first adoption, when there is no working draft yet", async () => {
		m.workingFindUnique.mockResolvedValue(null);

		const result = await saveWorkingDraft({
			...SCOPE,
			sourceDraftId: "draft-1",
			sourceOptionLabel: null,
			body: "Generated body",
			updatedById: "actor-1",
			expectedUpdatedAt: null,
		});

		expect(result).toMatchObject({ status: "saved" });
		expect(m.revisionCreate).not.toHaveBeenCalled();
	});

	it("mints NOTHING when the adopted body is identical to what is already saved", async () => {
		m.workingFindUnique.mockResolvedValue({
			updatedAt: NOW,
			body: "Same body",
			updatedById: "actor-0",
		});

		await saveWorkingDraft({
			...SCOPE,
			sourceDraftId: "draft-1",
			sourceOptionLabel: null,
			body: "Same body",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(m.revisionCreate).not.toHaveBeenCalled();
	});

	it("mints a RESTORED revision naming the version it came from", async () => {
		m.workingFindUnique.mockResolvedValue({
			updatedAt: NOW,
			body: "The body being replaced",
			updatedById: "actor-0",
		});

		await saveWorkingDraft({
			...SCOPE,
			sourceDraftId: "draft-1",
			sourceOptionLabel: null,
			body: "An older body, brought back",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(m.revisionCreate).toHaveBeenCalledTimes(1);
		expect(m.revisionCreate.mock.calls[0][0].data).toMatchObject({
			topicId: "topic-1",
			projectId: "project-1",
			postType: "BLOG_POST",
			version: 1,
			kind: "RESTORED",
			body: "An older body, brought back",
			// Read from the candidate row, not taken from the caller.
			sourceDraftVersion: 2,
			changeSummary: "Restored from version 2",
			authorUserId: "actor-1",
			// Tenancy from the LOCKED project row.
			organizationId: "org-1",
			userId: null,
		});
	});

	it("writes NO revision when the compare-and-set loses", async () => {
		m.workingFindUnique.mockResolvedValue({
			updatedAt: new Date("2026-09-17T13:00:00Z"),
			body: "Someone else's newer body",
			updatedById: "actor-0",
		});

		const result = await saveWorkingDraft({
			...SCOPE,
			sourceDraftId: "draft-1",
			sourceOptionLabel: null,
			body: "Anything",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(result).toEqual({ status: "stale" });
		expect(m.revisionCreate).not.toHaveBeenCalled();
		expect(m.workingUpsert).not.toHaveBeenCalled();
	});

	it("writes NO revision when the named candidate does not resolve", async () => {
		m.draftFindFirst.mockResolvedValue(null);

		const result = await saveWorkingDraft({
			...SCOPE,
			sourceDraftId: "draft-from-another-topic",
			sourceOptionLabel: null,
			body: "Anything",
			updatedById: "actor-1",
			expectedUpdatedAt: null,
		});

		expect(result).toEqual({ status: "source_not_found" });
		expect(m.revisionCreate).not.toHaveBeenCalled();
	});
});

describe("updateWorkingDraftBody — the editor", () => {
	beforeEach(() => {
		m.workingFindFirst.mockResolvedValue({
			id: "working-1",
			body: "Previous body",
			updatedById: "actor-0",
			sourceDraftId: "draft-1",
		});
	});

	it("mints an EDITED revision when the save wins", async () => {
		await updateWorkingDraftBody({
			...SCOPE,
			body: "My edited body",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(m.revisionCreate).toHaveBeenCalledTimes(1);
		expect(m.revisionCreate.mock.calls[0][0].data).toMatchObject({
			kind: "EDITED",
			body: "My edited body",
			// Descends from whatever seeded the draft, never the newest run.
			sourceDraftVersion: 2,
			authorUserId: "actor-1",
			changeSummary: null,
		});
	});

	it("writes NO revision when the compare-and-set loses — the property to protect", async () => {
		// The CAS is the WHERE of the updateMany, so a lost write is count 0.
		m.workingUpdateMany.mockResolvedValue({ count: 0 });

		const result = await updateWorkingDraftBody({
			...SCOPE,
			body: "My edited body",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(result).toEqual({ status: "stale" });
		expect(m.revisionCreate).not.toHaveBeenCalled();
	});

	it("writes NO revision when there is no working draft to edit", async () => {
		m.workingFindFirst.mockResolvedValue(null);

		const result = await updateWorkingDraftBody({
			...SCOPE,
			body: "My edited body",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(result).toEqual({ status: "not_found" });
		expect(m.revisionCreate).not.toHaveBeenCalled();
	});

	it("allocates the next version per (topic, postType)", async () => {
		m.revisionAggregate.mockResolvedValue({ _max: { version: 6 } });

		await updateWorkingDraftBody({
			...SCOPE,
			body: "My edited body",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(m.revisionAggregate.mock.calls[0][0].where).toEqual({
			topicId: "topic-1",
			projectId: "project-1",
			postType: "BLOG_POST",
		});
		expect(m.revisionCreate.mock.calls[0][0].data.version).toBe(7);
	});
});

describe("the one-shot backstop for bodies that predate the history table", () => {
	beforeEach(() => {
		// Nothing has ever been recorded for this content type.
		m.revisionFindFirst.mockResolvedValue(null);
		m.workingFindFirst.mockResolvedValue({
			id: "working-1",
			body: "A hand edit made before this feature shipped",
			updatedById: "author-from-before",
			sourceDraftId: null,
		});
	});

	it("records the OUTGOING body first, then the new one", async () => {
		let version = 0;
		m.revisionAggregate.mockImplementation(() =>
			Promise.resolve({ _max: { version } }),
		);
		m.revisionCreate.mockImplementation(
			(args: { data: { version: number } }) => {
				version = args.data.version;
				return Promise.resolve({});
			},
		);

		await updateWorkingDraftBody({
			...SCOPE,
			body: "The new text",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(m.revisionCreate).toHaveBeenCalledTimes(2);
		// v1 is the text that was about to be lost, attributed to whoever last
		// wrote it, and labelled so nobody reads its timestamp as authoritative.
		expect(m.revisionCreate.mock.calls[0][0].data).toMatchObject({
			version: 1,
			body: "A hand edit made before this feature shipped",
			authorUserId: "author-from-before",
			changeSummary: "Saved before version history was kept",
		});
		// v2 is the save the user actually made.
		expect(m.revisionCreate.mock.calls[1][0].data).toMatchObject({
			version: 2,
			body: "The new text",
			authorUserId: "actor-1",
		});
	});

	it("does not fire when the outgoing body is empty — there is nothing to lose", async () => {
		m.workingFindFirst.mockResolvedValue({
			id: "working-1",
			body: "",
			updatedById: "actor-0",
			sourceDraftId: null,
		});

		await updateWorkingDraftBody({
			...SCOPE,
			body: "The new text",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(m.revisionCreate).toHaveBeenCalledTimes(1);
		expect(m.revisionCreate.mock.calls[0][0].data.body).toBe(
			"The new text",
		);
	});

	it("does not fire a second time once any revision exists", async () => {
		m.revisionFindFirst.mockResolvedValue({ id: "already-there" });

		await updateWorkingDraftBody({
			...SCOPE,
			body: "The new text",
			updatedById: "actor-1",
			expectedUpdatedAt: NOW,
		});

		expect(m.revisionCreate).toHaveBeenCalledTimes(1);
	});
});
