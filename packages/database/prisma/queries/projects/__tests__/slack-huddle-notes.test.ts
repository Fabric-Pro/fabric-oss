/**
 * Unit tests for the Slack huddle-note dedup/upsert decision.
 *
 * Mocks the Prisma client (Postgres is not required) and asserts the
 * `didChange` contract that drives the activity's create / no-op / update-in-place
 * branches:
 *   - no prior row              → create, didChange = true
 *   - prior.contentHash same    → no-op,  didChange = false
 *   - prior.contentHash changed → update, didChange = true (incl. empty→populated)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique, mockUpsert } = vi.hoisted(() => ({
	mockFindUnique: vi.fn(),
	mockUpsert: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectSlackHuddleNote: {
			findUnique: mockFindUnique,
			upsert: mockUpsert,
		},
	},
}));

import { upsertSlackHuddleNoteRecord } from "../slack-huddle-notes";

const BASE = {
	projectId: "p1",
	linkedChannelId: "lc1",
	canvasId: "F_CANVAS",
	channelId: "C1",
	slackTeamId: "T1",
	userId: "u1",
	organizationId: undefined as string | undefined,
};

describe("upsertSlackHuddleNoteRecord", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUpsert.mockImplementation(async ({ create, update }) => ({
			id: "row1",
			...create,
			...update,
		}));
	});

	it("create path: no prior row → didChange=true, prior=null", async () => {
		mockFindUnique.mockResolvedValue(null);

		const res = await upsertSlackHuddleNoteRecord({
			...BASE,
			contentHash: "hash-A",
		});

		expect(res.didChange).toBe(true);
		expect(res.prior).toBeNull();
		expect(mockUpsert).toHaveBeenCalledTimes(1);
	});

	it("no-op path: same contentHash → didChange=false", async () => {
		mockFindUnique.mockResolvedValue({
			id: "row1",
			contentHash: "hash-A",
		});

		const res = await upsertSlackHuddleNoteRecord({
			...BASE,
			contentHash: "hash-A",
		});

		expect(res.didChange).toBe(false);
		expect(res.prior).toMatchObject({ contentHash: "hash-A" });
	});

	it("update-in-place path: changed contentHash → didChange=true", async () => {
		mockFindUnique.mockResolvedValue({
			id: "row1",
			contentHash: "hash-A",
		});

		const res = await upsertSlackHuddleNoteRecord({
			...BASE,
			contentHash: "hash-B",
		});

		expect(res.didChange).toBe(true);
		expect(res.prior).toMatchObject({ contentHash: "hash-A" });
	});

	it("empty→populated transition is treated as a change", async () => {
		// A prior row with a sentinel/empty-body hash, then a populated body.
		mockFindUnique.mockResolvedValue({
			id: "row1",
			contentHash: "hash-empty",
		});

		const res = await upsertSlackHuddleNoteRecord({
			...BASE,
			contentHash: "hash-populated",
		});

		expect(res.didChange).toBe(true);
	});

	it("writes tenant fields into create-data (not the unique selector)", async () => {
		mockFindUnique.mockResolvedValue(null);

		await upsertSlackHuddleNoteRecord({
			...BASE,
			organizationId: "org-1",
			contentHash: "hash-A",
		});

		const call = mockUpsert.mock.calls[0][0];
		// unique selector is (projectId, canvasId) ONLY — never tenant columns
		expect(call.where).toEqual({
			projectId_canvasId: { projectId: "p1", canvasId: "F_CANVAS" },
		});
		expect(call.create.organizationId).toBe("org-1");
		expect(call.create.userId).toBe("u1");
	});
});
