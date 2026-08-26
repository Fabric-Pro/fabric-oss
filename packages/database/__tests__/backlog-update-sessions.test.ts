/**
 * Unit tests for the BacklogUpdateSession queries (the "Session history" store):
 * create (APPLYING), finalize (terminal status + applied/failed derivation), and
 * cursor pagination. The Prisma client is mocked — these assert the query-shaping
 * logic, not the DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
	dbMock: {
		backlogUpdateSession: {
			create: vi.fn(),
			findFirst: vi.fn(),
			update: vi.fn(),
			findMany: vi.fn(),
		},
		auditLog: {
			findMany: vi.fn(),
		},
		userStory: {
			findMany: vi.fn(),
		},
	},
}));

vi.mock("../prisma/client", () => ({ db: dbMock }));

import {
	createBacklogUpdateSession,
	finalizeBacklogUpdateSession,
	getAppliedTicketsForProposal,
	listBacklogUpdateSessions,
} from "../prisma/queries/projects/backlog-update-sessions";

beforeEach(() => {
	dbMock.backlogUpdateSession.create.mockReset();
	dbMock.backlogUpdateSession.findFirst.mockReset();
	dbMock.backlogUpdateSession.update.mockReset();
	dbMock.backlogUpdateSession.findMany.mockReset();
	dbMock.auditLog.findMany.mockReset();
	dbMock.userStory.findMany.mockReset();
	dbMock.backlogUpdateSession.create.mockResolvedValue({ id: "sess-1" });
	dbMock.backlogUpdateSession.update.mockResolvedValue({ id: "sess-1" });
});

describe("createBacklogUpdateSession", () => {
	it("creates an APPLYING session with the proposed counts + tenant", async () => {
		await createBacklogUpdateSession({
			projectId: "p1",
			pendingProposalId: "prop-1",
			conversationId: "conv-1",
			summary: "3 proposed change(s) from AI Update",
			changes: [{ action: "create" }],
			changeCount: 3,
			createCount: 2,
			updateCount: 1,
			userId: "u1",
			organizationId: "o1",
		});
		expect(dbMock.backlogUpdateSession.create).toHaveBeenCalledTimes(1);
		const arg = dbMock.backlogUpdateSession.create.mock.calls[0][0];
		expect(arg.data).toMatchObject({
			projectId: "p1",
			pendingProposalId: "prop-1",
			conversationId: "conv-1",
			source: "AI_UPDATE_SIDEBAR",
			status: "APPLYING",
			changeCount: 3,
			createCount: 2,
			updateCount: 1,
			userId: "u1",
			organizationId: "o1",
		});
	});

	it("defaults nullable correlation/tenant fields to null", async () => {
		await createBacklogUpdateSession({
			projectId: "p1",
			summary: "s",
			changes: [],
			changeCount: 0,
			createCount: 0,
			updateCount: 0,
		});
		const arg = dbMock.backlogUpdateSession.create.mock.calls[0][0];
		expect(arg.data.pendingProposalId).toBeNull();
		expect(arg.data.userId).toBeNull();
		expect(arg.data.organizationId).toBeNull();
	});
});

describe("finalizeBacklogUpdateSession", () => {
	it("is a no-op (returns 0) when no session exists for the proposal", async () => {
		dbMock.backlogUpdateSession.findFirst.mockResolvedValue(null);
		const count = await finalizeBacklogUpdateSession({
			pendingProposalId: "missing",
			status: "APPLIED",
		});
		expect(count).toBe(0);
		expect(dbMock.backlogUpdateSession.update).not.toHaveBeenCalled();
	});

	it("APPLIED with no explicit count → all proposed changes applied", async () => {
		dbMock.backlogUpdateSession.findFirst.mockResolvedValue({
			id: "sess-1",
			changeCount: 4,
		});
		await finalizeBacklogUpdateSession({
			pendingProposalId: "prop-1",
			status: "APPLIED",
		});
		const arg = dbMock.backlogUpdateSession.update.mock.calls[0][0];
		expect(arg.data).toMatchObject({
			status: "APPLIED",
			appliedCount: 4,
			failedCount: 0,
		});
		expect(arg.data.finalizedAt).toBeInstanceOf(Date);
	});

	it("FAILED with no count → zero applied, all failed", async () => {
		dbMock.backlogUpdateSession.findFirst.mockResolvedValue({
			id: "sess-1",
			changeCount: 4,
		});
		await finalizeBacklogUpdateSession({
			pendingProposalId: "prop-1",
			status: "FAILED",
		});
		const arg = dbMock.backlogUpdateSession.update.mock.calls[0][0];
		expect(arg.data).toMatchObject({
			status: "FAILED",
			appliedCount: 0,
			failedCount: 4,
		});
	});

	it("partial: explicit appliedCount splits applied/failed and clamps to changeCount", async () => {
		dbMock.backlogUpdateSession.findFirst.mockResolvedValue({
			id: "sess-1",
			changeCount: 5,
		});
		await finalizeBacklogUpdateSession({
			pendingProposalId: "prop-1",
			status: "PARTIALLY_APPLIED",
			appliedCount: 2,
		});
		const arg = dbMock.backlogUpdateSession.update.mock.calls[0][0];
		expect(arg.data.appliedCount).toBe(2);
		expect(arg.data.failedCount).toBe(3);

		// clamp: an over-count never exceeds changeCount
		dbMock.backlogUpdateSession.update.mockClear();
		dbMock.backlogUpdateSession.findFirst.mockResolvedValue({
			id: "sess-2",
			changeCount: 3,
		});
		await finalizeBacklogUpdateSession({
			pendingProposalId: "prop-2",
			status: "APPLIED",
			appliedCount: 99,
		});
		expect(
			dbMock.backlogUpdateSession.update.mock.calls[0][0].data
				.appliedCount,
		).toBe(3);
	});
});

describe("listBacklogUpdateSessions", () => {
	it("returns items with no nextCursor when fewer than limit+1 rows", async () => {
		dbMock.backlogUpdateSession.findMany.mockResolvedValue([
			{ id: "s1", createdAt: new Date("2026-06-10T00:00:00Z") },
		]);
		const result = await listBacklogUpdateSessions({
			projectId: "p1",
			limit: 25,
		});
		expect(result.items).toHaveLength(1);
		expect(result.nextCursor).toBeNull();
		// fetches limit + 1 to detect more
		expect(dbMock.backlogUpdateSession.findMany.mock.calls[0][0].take).toBe(
			26,
		);
	});

	it("sets nextCursor and truncates when an extra row exists", async () => {
		const rows = Array.from({ length: 3 }, (_, i) => ({
			id: `s${i}`,
			createdAt: new Date(`2026-06-1${i}T00:00:00Z`),
		}));
		dbMock.backlogUpdateSession.findMany.mockResolvedValue(rows);
		const result = await listBacklogUpdateSessions({
			projectId: "p1",
			limit: 2,
		});
		expect(result.items).toHaveLength(2);
		expect(result.nextCursor).toBeTypeOf("string");
	});

	it("scopes the query to the project and orders newest-first", async () => {
		dbMock.backlogUpdateSession.findMany.mockResolvedValue([]);
		await listBacklogUpdateSessions({ projectId: "p-scope", limit: 10 });
		const arg = dbMock.backlogUpdateSession.findMany.mock.calls[0][0];
		expect(arg.where.projectId).toBe("p-scope");
		expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
	});
});

describe("getAppliedTicketsForProposal", () => {
	it("filters audit by project + story actions + metadata.proposalId", async () => {
		dbMock.auditLog.findMany.mockResolvedValue([]);
		await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: "prop-1",
		});
		const arg = dbMock.auditLog.findMany.mock.calls[0][0];
		expect(arg.where.projectId).toBe("p1");
		expect(arg.where.action).toEqual({
			in: ["story.created", "story.updated"],
		});
		expect(arg.where.metadata).toEqual({
			path: ["proposalId"],
			equals: "prop-1",
		});
	});

	it("returns [] without touching userStory when no audit rows match", async () => {
		dbMock.auditLog.findMany.mockResolvedValue([]);
		const out = await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: "prop-1",
		});
		expect(out).toEqual([]);
		expect(dbMock.userStory.findMany).not.toHaveBeenCalled();
	});

	it("resolves identifiers and dedupes a create+update of the same story (headed by create)", async () => {
		dbMock.auditLog.findMany.mockResolvedValue([
			{
				action: "story.created",
				resourceId: "s1",
				resourceName: "New dashboard",
			},
			{
				action: "story.updated",
				resourceId: "s1",
				resourceName: "New dashboard (edited)",
			},
			{
				action: "story.updated",
				resourceId: "s2",
				resourceName: "Login fix",
			},
		]);
		dbMock.userStory.findMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1" },
			{ id: "s2", identifier: "B-2" },
		]);
		const out = await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: "prop-1",
		});
		expect(out).toEqual([
			{
				action: "create",
				storyId: "s1",
				identifier: "F-1",
				title: "New dashboard",
				deleted: false,
			},
			{
				action: "update",
				storyId: "s2",
				identifier: "B-2",
				title: "Login fix",
				deleted: false,
			},
		]);
	});

	it("flags a since-deleted story (null identifier, deleted: true)", async () => {
		dbMock.auditLog.findMany.mockResolvedValue([
			{
				action: "story.created",
				resourceId: "gone",
				resourceName: "Removed item",
			},
		]);
		// Story no longer exists → not returned by the identifier lookup.
		dbMock.userStory.findMany.mockResolvedValue([]);
		const out = await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: "prop-1",
		});
		expect(out).toEqual([
			{
				action: "create",
				storyId: "gone",
				identifier: null,
				title: "Removed item",
				deleted: true,
			},
		]);
	});

	it("skips audit rows with no resourceId", async () => {
		dbMock.auditLog.findMany.mockResolvedValue([
			{ action: "story.created", resourceId: null, resourceName: "x" },
		]);
		const out = await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: "prop-1",
		});
		expect(out).toEqual([]);
		expect(dbMock.userStory.findMany).not.toHaveBeenCalled();
	});

	it("falls back to apply-window + proposed titles when no proposal-id rows match", async () => {
		// 1st (proposal-id) query → nothing; 2nd (window+title) query → the row.
		dbMock.auditLog.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					action: "story.created",
					resourceId: "s9",
					resourceName: "Untagged feature",
				},
			]);
		dbMock.userStory.findMany.mockResolvedValue([
			{ id: "s9", identifier: "F-9" },
		]);
		const out = await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: "prop-x",
			window: {
				from: new Date("2026-06-10T08:56:00Z"),
				to: new Date("2026-06-10T08:56:10Z"),
			},
			proposedTitles: ["Untagged feature"],
		});
		// the fallback query is scoped by snapshot title + the apply window
		const fallbackArg = dbMock.auditLog.findMany.mock.calls[1][0];
		expect(fallbackArg.where.resourceName).toEqual({
			in: ["Untagged feature"],
		});
		expect(fallbackArg.where.createdAt.gte).toEqual(
			new Date("2026-06-10T08:56:00Z"),
		);
		expect(out).toEqual([
			{
				action: "create",
				storyId: "s9",
				identifier: "F-9",
				title: "Untagged feature",
				deleted: false,
			},
		]);
	});

	it("resolves with a null proposal id via the window-only path (no primary query)", async () => {
		dbMock.auditLog.findMany.mockResolvedValueOnce([
			{ action: "story.created", resourceId: "s1", resourceName: "T" },
		]);
		dbMock.userStory.findMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1" },
		]);
		const out = await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: null,
			window: { from: new Date("2026-06-10T08:00:00Z"), to: null },
			proposedTitles: ["T"],
		});
		expect(out[0]?.identifier).toBe("F-1");
		// No primary query is issued when the proposal id is null.
		expect(dbMock.auditLog.findMany).toHaveBeenCalledTimes(1);
	});

	it("does not fall back without a window (returns [] on no proposal-id match)", async () => {
		dbMock.auditLog.findMany.mockResolvedValue([]);
		const out = await getAppliedTicketsForProposal({
			projectId: "p1",
			proposalId: "prop-1",
		});
		expect(out).toEqual([]);
		expect(dbMock.auditLog.findMany).toHaveBeenCalledTimes(1);
	});
});
