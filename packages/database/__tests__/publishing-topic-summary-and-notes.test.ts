import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two write helpers behind a topic's summary and its private notebook
 * (`updatePublishingTopicSummary`, `setPublishingTopicNotes`).
 *
 * Unit-level with a mocked `db`, matching `publishing-drafts.test.ts`: this
 * exercises the write's SHAPE — what it is scoped by, which columns it touches,
 * and what it does with the timestamp — not real Postgres semantics. It
 * therefore runs in the regular no-Postgres suite and is NOT part of the
 * `db-integration` count guards.
 *
 * The behaviour worth pinning here cannot be seen from the procedure layer,
 * because that layer mocks these helpers away:
 *
 *   - `pitchUpdatedAt` moves WITH `pitch`, including when the summary is
 *     cleared. The timestamp records that an edit happened, and deleting a
 *     summary is an edit — it invalidates an analysis built from the old text
 *     exactly as surely as a rewrite does. (Contrast `setPublishingTopicSnooze`,
 *     which clears both its columns together, because there the second column
 *     describes a state the row has left.)
 *   - the notebook write touches `notes` and NOTHING else, so saving notes can
 *     never mark a planning analysis stale.
 *   - both are scoped on `(id, projectId)` and write no tenant column.
 */

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { publishingTopic: { updateMany } },
	Prisma: {},
}));

import {
	setPublishingTopicNotes,
	updatePublishingTopicSummary,
} from "../prisma/queries/projects/publishing-suite";

const SCOPE = { id: "topic-1", projectId: "project-1" };

beforeEach(() => {
	vi.clearAllMocks();
	updateMany.mockResolvedValue({ count: 1 });
});

describe("updatePublishingTopicSummary", () => {
	it("scopes the write to (id, projectId) and writes no tenant column", async () => {
		await updatePublishingTopicSummary({ ...SCOPE, pitch: "New summary" });

		const [args] = updateMany.mock.calls[0];
		expect(args.where).toEqual({ id: "topic-1", projectId: "project-1" });
		expect(args.data).not.toHaveProperty("organizationId");
		expect(args.data).not.toHaveProperty("userId");
	});

	it("writes the summary and stamps pitchUpdatedAt together", async () => {
		const now = new Date("2026-09-17T12:00:00Z");

		await updatePublishingTopicSummary({
			...SCOPE,
			pitch: "New summary",
			now,
		});

		expect(updateMany.mock.calls[0][0].data).toEqual({
			pitch: "New summary",
			pitchUpdatedAt: now,
		});
	});

	it("stamps pitchUpdatedAt when the summary is CLEARED — deleting a summary is an edit", async () => {
		// The case a "clear both columns" reading of the snooze helper would get
		// backwards. An analysis built from the deleted text is just as stale as
		// one built from replaced text, so the timestamp must advance.
		const now = new Date("2026-09-17T12:00:00Z");

		await updatePublishingTopicSummary({ ...SCOPE, pitch: null, now });

		expect(updateMany.mock.calls[0][0].data).toEqual({
			pitch: null,
			pitchUpdatedAt: now,
		});
	});

	it("defaults the stamp to the server clock when no `now` is given", async () => {
		const before = Date.now();

		await updatePublishingTopicSummary({ ...SCOPE, pitch: "New summary" });

		const stamped = updateMany.mock.calls[0][0].data.pitchUpdatedAt;
		expect(stamped).toBeInstanceOf(Date);
		expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
		expect(stamped.getTime()).toBeLessThanOrEqual(Date.now());
	});

	it("never writes the title — dedupeKey is derived from it and is not recomputed here", async () => {
		await updatePublishingTopicSummary({ ...SCOPE, pitch: "New summary" });

		const { data } = updateMany.mock.calls[0][0];
		expect(data).not.toHaveProperty("title");
		expect(data).not.toHaveProperty("dedupeKey");
	});

	it("returns the affected count, so a cross-project id reports 0 rather than reaching across", async () => {
		updateMany.mockResolvedValue({ count: 0 });

		await expect(
			updatePublishingTopicSummary({
				id: "topic-in-another-project",
				projectId: "project-1",
				pitch: "New summary",
			}),
		).resolves.toBe(0);
	});
});

describe("setPublishingTopicNotes", () => {
	it("scopes the write to (id, projectId) and writes no tenant column", async () => {
		await setPublishingTopicNotes({ ...SCOPE, notes: "Some thoughts" });

		const [args] = updateMany.mock.calls[0];
		expect(args.where).toEqual({ id: "topic-1", projectId: "project-1" });
		expect(args.data).not.toHaveProperty("organizationId");
		expect(args.data).not.toHaveProperty("userId");
	});

	it("writes ONLY `notes` — the notebook is not generation input, so it cannot stale an analysis", async () => {
		await setPublishingTopicNotes({ ...SCOPE, notes: "Some thoughts" });

		expect(updateMany.mock.calls[0][0].data).toEqual({
			notes: "Some thoughts",
		});
	});

	it("stores null to clear the column", async () => {
		await setPublishingTopicNotes({ ...SCOPE, notes: null });

		expect(updateMany.mock.calls[0][0].data).toEqual({ notes: null });
	});

	it("returns the affected count, so a cross-project id reports 0", async () => {
		updateMany.mockResolvedValue({ count: 0 });

		await expect(
			setPublishingTopicNotes({
				id: "topic-in-another-project",
				projectId: "project-1",
				notes: "Some thoughts",
			}),
		).resolves.toBe(0);
	});
});
