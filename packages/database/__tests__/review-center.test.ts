/**
 * Unit tests for the `@repo/database` Review Center query layer
 * (`getReviewCenterItems` + `getReviewCenterCount`).
 *
 * Mocks the Prisma client (`../prisma/client`) — no real DB. Mirrors the
 * `pm-sync-log.test.ts` convention.
 *
 * Asserts: grouping + fixed order (Conflicts → Failures → Pull-drift), the
 * bounded ~50 cap, XOR tenant filtering, and — critically — that the Review
 * Center reads ONLY existing per-item fields and never touches `pmSyncLog`
 * (D1 live query, not audit-log reconstruction). Stories are the only
 * work-item rows since the Epic/Feature folder tables were dropped.
 *
 * Run with: pnpm --filter @repo/database test __tests__/review-center.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	storyFindMany,
	storyCount,
	pendingFindMany,
	pendingCount,
	projectFindFirst,
	mcpFindUnique,
	pmSyncLogFindMany,
	pmSyncLogCount,
} = vi.hoisted(() => ({
	storyFindMany: vi.fn(),
	storyCount: vi.fn(),
	pendingFindMany: vi.fn(),
	pendingCount: vi.fn(),
	projectFindFirst: vi.fn(),
	mcpFindUnique: vi.fn(),
	// Tripwires: the Review Center must never read the audit log.
	pmSyncLogFindMany: vi.fn(),
	pmSyncLogCount: vi.fn(),
}));

vi.mock("../prisma/client", async () => {
	const actual =
		await vi.importActual<typeof import("../prisma/client")>(
			"../prisma/client",
		);
	return {
		Prisma: actual.Prisma,
		db: {
			userStory: { findMany: storyFindMany, count: storyCount },
			pendingPmStateChange: {
				findMany: pendingFindMany,
				count: pendingCount,
			},
			project: { findFirst: projectFindFirst },
			mCPServer: { findUnique: mcpFindUnique },
			pmSyncLog: { findMany: pmSyncLogFindMany, count: pmSyncLogCount },
		},
	};
});

import {
	getReviewCenterCount,
	getReviewCenterItems,
} from "../prisma/queries/review-center";

const STORY_LAST_EDITED_AT = new Date("2026-05-21T08:00:00.000Z");

function storyRow(
	id: string,
	error: string | null = null,
	description: string | null = `Description ${id}`,
	kind: "FEATURE" | "BUG" = "FEATURE",
) {
	return {
		id,
		identifier: `ID-${id}`,
		title: `Title ${id}`,
		description,
		lastEditedAt: STORY_LAST_EDITED_AT,
		lastPmSyncError: error,
		kind,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default: no items anywhere, project linked to ADO.
	storyFindMany.mockResolvedValue([]);
	pendingFindMany.mockResolvedValue([]);
	storyCount.mockResolvedValue(0);
	pendingCount.mockResolvedValue(0);
	projectFindFirst.mockResolvedValue({
		projectManagementMcpServerId: "mcp-1",
	});
	mcpFindUnique.mockResolvedValue({ key: "azure-devops" });
});

describe("getReviewCenterItems", () => {
	it("groups items in fixed order Conflicts → Failures → Pull-drift", async () => {
		// CONFLICT story, FAILED story, one pending pull-drift (a STORY).
		// `userStory.findMany` is hit three times: once for the CONFLICT status
		// fetch, once for FAILED, once for the pull-drift id→title lookup —
		// distinguish by the shape of `where`.
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "CONFLICT") {
				return Promise.resolve([storyRow("s1")]);
			}
			if (where?.lastPmSyncStatus === "FAILED") {
				return Promise.resolve([storyRow("f1", "boom")]);
			}
			if (where?.id?.in) {
				return Promise.resolve([
					{ id: "s2", identifier: "US-002", title: "Drifted story" },
				]);
			}
			return Promise.resolve([]);
		});
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-1",
				entityId: "s2",
				previousState: "Active",
				newState: "Closed",
				proposedAction: "HIDE",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({
			type: "conflict",
			entityType: "STORY",
			pmTool: "azure-devops",
		});
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({
			type: "failure",
			summary: "boom",
		});
		expect(result.pullDrift).toHaveLength(1);
		expect(result.pullDrift[0]).toMatchObject({
			type: "pull-drift",
			identifier: "US-002",
			title: "Drifted story",
			summary: "Active → Closed",
			proposedAction: "HIDE",
		});
		// Conflict/failure rows carry no proposed action.
		expect(result.conflicts[0].proposedAction).toBeNull();
		expect(result.failures[0].proposedAction).toBeNull();
		expect(result.total).toBe(3);

		// The Review Center NEVER reads the audit log.
		expect(pmSyncLogFindMany).not.toHaveBeenCalled();
		expect(pmSyncLogCount).not.toHaveBeenCalled();
	});

	it("surfaces itemType 'bug' for a Failures row whose story kind is BUG (RETRY-c regression)", async () => {
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "FAILED") {
				return Promise.resolve([
					storyRow("bug-1", "boom", "Bug body", "BUG"),
				]);
			}
			return Promise.resolve([]);
		});

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].itemType).toBe("bug");
		// The Failures/STORY select must request the `kind` column.
		const failedSelect = storyFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.lastPmSyncStatus === "FAILED",
		)?.[0].select;
		expect(failedSelect).toMatchObject({ kind: true });
	});

	it("surfaces itemType 'story' for a Failures row whose story kind is FEATURE", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "FAILED"
				? Promise.resolve([
						storyRow("feat-1", "boom", "Feature body", "FEATURE"),
					])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].itemType).toBe("story");
	});

	it("surfaces itemType from the underlying story kind on pull-drift rows", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.id?.in
				? Promise.resolve([
						{
							id: "s2",
							identifier: "US-002",
							title: "Drifted bug",
							kind: "BUG",
						},
					])
				: Promise.resolve([]),
		);
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-1",
				entityId: "s2",
				previousState: "Active",
				newState: "Closed",
				proposedAction: "FLAG_MISSING",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.pullDrift).toHaveLength(1);
		expect(result.pullDrift[0].itemType).toBe("bug");
		// The pull-drift story lookup must request `kind`.
		const driftLookupSelect = storyFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.id?.in,
		)?.[0].select;
		expect(driftLookupSelect).toMatchObject({ kind: true });
	});

	it("excludes a pull-drift entity that is also CONFLICT (cross-tab dedup — items, D1)", async () => {
		// Story "dup" is simultaneously a CONFLICT and has a PENDING pull-drift
		// change; it must surface in Conflicts only.
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "CONFLICT") {
				return Promise.resolve([storyRow("dup")]);
			}
			if (where?.id?.in) {
				return Promise.resolve([
					{ id: "dup", identifier: "US-DUP", title: "Dup story" },
					{ id: "clean", identifier: "US-CLN", title: "Clean story" },
				]);
			}
			return Promise.resolve([]);
		});
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-dup",
				entityId: "dup",
				previousState: "A",
				newState: "B",
				proposedAction: "HIDE",
			},
			{
				id: "pend-clean",
				entityId: "clean",
				previousState: "A",
				newState: "B",
				proposedAction: "HIDE",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts.map((c) => c.entityId)).toContain("dup");
		const driftEntityIds = result.pullDrift.map((p) => p.entityId);
		expect(driftEntityIds).not.toContain("dup");
		expect(driftEntityIds).toContain("clean");
	});

	it("excludes a pull-drift entity that is also FAILED (cross-tab dedup — items, D1)", async () => {
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "FAILED") {
				return Promise.resolve([storyRow("dup", "boom")]);
			}
			if (where?.id?.in) {
				return Promise.resolve([
					{ id: "dup", identifier: "US-DUP", title: "Dup story" },
				]);
			}
			return Promise.resolve([]);
		});
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-dup",
				entityId: "dup",
				previousState: "A",
				newState: "B",
				proposedAction: "HIDE",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.failures.map((f) => f.entityId)).toContain("dup");
		expect(result.pullDrift.map((p) => p.entityId)).not.toContain("dup");
	});

	it("filters pull-drift rows to entityType STORY (legacy EPIC/FEATURE rows excluded)", async () => {
		await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		const pendingWhere = pendingFindMany.mock.calls[0][0].where;
		expect(pendingWhere.entityType).toBe("STORY");
	});

	it("carries proposedAction + a content-drift summary for a CONTENT_DRIFT pull-drift row, and selects proposedAction", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.id?.in
				? Promise.resolve([
						{
							id: "s9",
							identifier: "US-009",
							title: "Drifted body",
							description: "Fabric current body",
							lastEditedAt: new Date("2026-05-22T09:30:00.000Z"),
						},
					])
				: Promise.resolve([]),
		);
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-9",
				entityId: "s9",
				previousState: "",
				newState: "",
				proposedAction: "CONTENT_DRIFT",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.pullDrift).toHaveLength(1);
		expect(result.pullDrift[0]).toMatchObject({
			type: "pull-drift",
			entityType: "STORY",
			entityId: "s9",
			identifier: "US-009",
			title: "Drifted body",
			proposedAction: "CONTENT_DRIFT",
			summary: "Content changed in your PM tool",
			// CONTENT_DRIFT rows carry the entity's current Fabric description so
			// the Resolve dialog's Fabric column renders without a round-trip.
			fabricDescription: "Fabric current body",
			// …and the entity's last-updated timestamp for the Fabric column.
			fabricUpdatedAt: "2026-05-22T09:30:00.000Z",
		});

		// The pull-drift entity lookup must request the semantic edit timestamp
		// for the diff, and the pending select must request the discriminator.
		const pendingSelect = pendingFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.status === "PENDING",
		)?.[0].select;
		expect(pendingSelect).toMatchObject({ proposedAction: true });
		const driftLookupSelect = storyFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.id?.in,
		)?.[0].select;
		expect(driftLookupSelect).toMatchObject({
			description: true,
			lastEditedAt: true,
		});
	});

	it("caps the combined list at ~50 in priority order (conflicts first)", async () => {
		// 60 conflict stories → conflicts saturate the cap; failures/pull-drift
		// should be trimmed to zero.
		const manyConflicts = Array.from({ length: 60 }, (_, i) =>
			storyRow(`c${i}`),
		);
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "CONFLICT") {
				return Promise.resolve(manyConflicts);
			}
			if (where?.lastPmSyncStatus === "FAILED") {
				return Promise.resolve([storyRow("failed-1")]);
			}
			if (where?.id?.in) {
				return Promise.resolve([
					{ id: "s1", identifier: "US-001", title: "Story 1" },
				]);
			}
			return Promise.resolve([]);
		});
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-1",
				entityId: "s1",
				previousState: "A",
				newState: "B",
				proposedAction: "HIDE",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts).toHaveLength(50);
		expect(result.failures).toHaveLength(0);
		expect(result.pullDrift).toHaveLength(0);
		expect(result.total).toBe(50);
	});

	it("scopes story queries by projectId only — never org/user columns", async () => {
		// UserStory/PendingPmStateChange have no organizationId or
		// userId columns; passing them to Prisma would throw at runtime. Tenant
		// isolation flows through `projectId` (+ `hasProjectAccess` upstream).
		await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		const storyWhere = storyFindMany.mock.calls[0][0].where;
		expect(storyWhere.projectId).toBe("proj-1");
		expect(storyWhere).not.toHaveProperty("organizationId");
		expect(storyWhere).not.toHaveProperty("userId");
		expect(storyWhere).not.toHaveProperty("OR");

		const pendingWhere = pendingFindMany.mock.calls[0][0].where;
		expect(pendingWhere.projectId).toBe("proj-1");
		expect(pendingWhere).not.toHaveProperty("organizationId");
		expect(pendingWhere).not.toHaveProperty("userId");
	});

	it("applies the organization XOR tenant filter on the project lookup", async () => {
		await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		const projectWhere = projectFindFirst.mock.calls[0][0].where;
		expect(projectWhere.id).toBe("proj-1");
		expect(projectWhere.organizationId).toBe("org-1");
		expect(projectWhere).not.toHaveProperty("userId");
		expect(projectWhere).not.toHaveProperty("OR");
	});

	it("applies the personal XOR tenant filter on the project lookup", async () => {
		await getReviewCenterItems({ userId: "user-1", projectId: "proj-1" });

		const projectWhere = projectFindFirst.mock.calls[0][0].where;
		expect(projectWhere.id).toBe("proj-1");
		expect(projectWhere.organizationId).toBeNull();
		expect(projectWhere.userId).toBe("user-1");
	});

	it("includes the Fabric description on conflict rows (for the Resolve diff)", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "CONFLICT"
				? Promise.resolve([
						storyRow("s1", null, "Fabric-side description"),
					])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts[0].fabricDescription).toBe(
			"Fabric-side description",
		);
		// The select must request the `description` column.
		const conflictSelect = storyFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.lastPmSyncStatus === "CONFLICT",
		)?.[0].select;
		expect(conflictSelect).toMatchObject({ description: true });
	});

	it("normalizes a null description to an empty string", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "CONFLICT"
				? Promise.resolve([storyRow("s1", null, null)])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts[0].fabricDescription).toBe("");
	});

	it("includes the Fabric lastEditedAt (ISO) on conflict rows for the Resolve dialog timestamp", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "CONFLICT"
				? Promise.resolve([storyRow("s1")])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts[0].fabricUpdatedAt).toBe(
			STORY_LAST_EDITED_AT.toISOString(),
		);
		// The select must request the semantic edit timestamp.
		const conflictSelect = storyFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.lastPmSyncStatus === "CONFLICT",
		)?.[0].select;
		expect(conflictSelect).toMatchObject({ lastEditedAt: true });
	});

	it("surfaces fabricAuthor + fabricSource on conflict rows, and selects them", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "CONFLICT"
				? Promise.resolve([
						{
							...storyRow("s1"),
							lastEditedByName: "Ada Lovelace",
							lastEditedSource: "MANUAL",
						},
					])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts[0]).toMatchObject({
			fabricAuthor: "Ada Lovelace",
			fabricSource: "MANUAL",
		});
		// The STORY select must request the provenance columns.
		const conflictSelect = storyFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.lastPmSyncStatus === "CONFLICT",
		)?.[0].select;
		expect(conflictSelect).toMatchObject({
			lastEditedByName: true,
			lastEditedSource: true,
		});
	});

	it("returns null fabricAuthor/fabricSource for a story row that has not been stamped", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "CONFLICT"
				? Promise.resolve([storyRow("s1")])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts[0].fabricAuthor).toBeNull();
		expect(result.conflicts[0].fabricSource).toBeNull();
	});

	it("hides legacy actor/source snapshots when no semantic edit time exists", async () => {
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "CONFLICT"
				? Promise.resolve([
						{
							...storyRow("s1"),
							lastEditedAt: null,
							lastEditedByName: "Stale editor",
							lastEditedSource: "MANUAL",
						},
					])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts[0]).toMatchObject({
			fabricUpdatedAt: null,
			fabricAuthor: null,
			fabricSource: null,
		});
	});

	it("returns null pmTool when no PM tool is linked", async () => {
		projectFindFirst.mockResolvedValue({
			projectManagementMcpServerId: null,
		});
		storyFindMany.mockImplementation(({ where }: any) =>
			where?.lastPmSyncStatus === "FAILED"
				? Promise.resolve([storyRow("s1", "err")])
				: Promise.resolve([]),
		);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.failures[0].pmTool).toBeNull();
		expect(mcpFindUnique).not.toHaveBeenCalled();
	});

	it("surfaces a FAILED story that also has a PENDING FLAG_MISSING change as its pull-drift recovery row, NOT a failure (deleted-card unstick)", async () => {
		// The deleted-card case: a push-not-found stamps BOTH
		// lastPmSyncStatus=FAILED AND a PENDING FLAG_MISSING proposal. The
		// FLAG_MISSING recovery row (Unlink / Re-push / Dismiss) must win over the
		// bare Retry-only failure row — otherwise the recovery actions are hidden.
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "FAILED") {
				return Promise.resolve([storyRow("gone", "not found")]);
			}
			if (where?.id?.in) {
				return Promise.resolve([
					{
						id: "gone",
						identifier: "F-240",
						title: "Deleted-card story",
					},
				]);
			}
			return Promise.resolve([]);
		});
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-gone",
				entityId: "gone",
				previousState: "",
				newState: "MISSING",
				proposedAction: "FLAG_MISSING",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		// Not a Retry-only failure dead-end…
		expect(result.failures.map((f) => f.entityId)).not.toContain("gone");
		// …surfaces as its FLAG_MISSING pull-drift recovery row instead.
		expect(result.pullDrift.map((p) => p.entityId)).toContain("gone");
		expect(result.pullDrift[0].proposedAction).toBe("FLAG_MISSING");
	});

	it("surfaces a CONFLICT story that also has a PENDING FLAG_MISSING change as its pull-drift recovery row, NOT a conflict", async () => {
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "CONFLICT") {
				return Promise.resolve([storyRow("gone")]);
			}
			if (where?.id?.in) {
				return Promise.resolve([
					{
						id: "gone",
						identifier: "F-9",
						title: "Deleted-card conflict",
					},
				]);
			}
			return Promise.resolve([]);
		});
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-gone",
				entityId: "gone",
				previousState: "",
				newState: "MISSING",
				proposedAction: "FLAG_MISSING",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflicts.map((c) => c.entityId)).not.toContain("gone");
		expect(result.pullDrift.map((p) => p.entityId)).toContain("gone");
	});

	it("still dedups a non-FLAG_MISSING (CONTENT_DRIFT) pull-drift row against a FAILED story (failure still wins)", async () => {
		// Only FLAG_MISSING flips the priority — other pending kinds keep the
		// existing behavior (the conflict/failure row wins, pull-drift suppressed).
		storyFindMany.mockImplementation(({ where }: any) => {
			if (where?.lastPmSyncStatus === "FAILED") {
				return Promise.resolve([storyRow("dup", "boom")]);
			}
			if (where?.id?.in) {
				return Promise.resolve([
					{ id: "dup", identifier: "US-DUP", title: "Dup story" },
				]);
			}
			return Promise.resolve([]);
		});
		pendingFindMany.mockResolvedValue([
			{
				id: "pend-dup",
				entityId: "dup",
				previousState: "",
				newState: "",
				proposedAction: "CONTENT_DRIFT",
			},
		]);

		const result = await getReviewCenterItems({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.failures.map((f) => f.entityId)).toContain("dup");
		expect(result.pullDrift.map((p) => p.entityId)).not.toContain("dup");
	});
});

describe("getReviewCenterCount", () => {
	// The count query derives conflict/failure counts from id-only `findMany`
	// results (so the FLAG_MISSING cross-tab arbitration can be applied in
	// memory), then issues ONE pull-drift `count()`. Drive the id lookups by the
	// `lastPmSyncStatus` in their `where`, mirroring the items-query test pattern.
	function mockStoryIds(perStatus: {
		CONFLICT?: string[];
		FAILED?: string[];
	}) {
		storyFindMany.mockImplementation(({ where }: any) => {
			const status = where?.lastPmSyncStatus;
			if (status === "CONFLICT") {
				return Promise.resolve(
					(perStatus.CONFLICT ?? []).map((id) => ({ id })),
				);
			}
			if (status === "FAILED") {
				return Promise.resolve(
					(perStatus.FAILED ?? []).map((id) => ({ id })),
				);
			}
			return Promise.resolve([]);
		});
	}

	it("returns the four-field shape with total = conflicts + failures + pullDrift, and never reads the audit log", async () => {
		mockStoryIds({
			CONFLICT: ["c1", "c2", "c3"],
			FAILED: ["f1", "f2", "f3", "f4", "f5", "f6"],
		});
		pendingCount.mockResolvedValue(7);

		const result = await getReviewCenterCount({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result).toEqual({
			conflictsCount: 3,
			failuresCount: 6,
			pullDriftCount: 7,
			total: 16,
		});
		expect(result.total).toBe(
			result.conflictsCount +
				result.failuresCount +
				result.pullDriftCount,
		);
		expect(pmSyncLogCount).not.toHaveBeenCalled();
		expect(pmSyncLogFindMany).not.toHaveBeenCalled();
	});

	it("splits CONFLICT and FAILED into separate categories with no cross-category leak", async () => {
		// Only CONFLICT rows exist → failuresCount stays 0, and vice-versa.
		mockStoryIds({ CONFLICT: ["c1", "c2"], FAILED: ["f1", "f2", "f3"] });
		pendingCount.mockResolvedValue(0);

		const result = await getReviewCenterCount({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.conflictsCount).toBe(2);
		expect(result.failuresCount).toBe(3);
		expect(result.pullDriftCount).toBe(0);
		expect(result.total).toBe(5);
	});

	it("counts only CONFLICT/FAILED story rows and PENDING STORY pull-drift", async () => {
		await getReviewCenterCount({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		// Conflict/failure counts come from id-only findMany lookups by status.
		const statuses = storyFindMany.mock.calls.map(
			(c: any) => c[0].where.lastPmSyncStatus,
		);
		expect(statuses).toContain("CONFLICT");
		expect(statuses).toContain("FAILED");
		// No combined `IN`-style filter remains.
		expect(statuses).not.toContainEqual({ in: ["CONFLICT", "FAILED"] });

		const pendingWhere = pendingCount.mock.calls[0][0].where;
		expect(pendingWhere.status).toBe("PENDING");
		// Legacy EPIC/FEATURE pending rows are excluded from the badge count.
		expect(pendingWhere.entityType).toBe("STORY");
	});

	it("pullDriftCount counts only PENDING pending-state-changes", async () => {
		pendingCount.mockResolvedValue(4);

		const result = await getReviewCenterCount({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		expect(result.pullDriftCount).toBe(4);
		expect(pendingCount.mock.calls[0][0].where.status).toBe("PENDING");
	});

	it("excludes CONFLICT/FAILED entities from the pull-drift count (cross-tab dedup — count, D1)", async () => {
		mockStoryIds({ CONFLICT: ["dup-conflict"], FAILED: ["dup-failed"] });
		pendingCount.mockResolvedValue(5);

		const result = await getReviewCenterCount({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		// The pull-drift count keeps FLAG_MISSING rows (OR's first branch) but
		// excludes the visible CONFLICT/FAILED entityIds (OR's second branch).
		const pendingWhere = pendingCount.mock.calls[0][0].where;
		expect(pendingWhere.OR).toEqual(
			expect.arrayContaining([{ proposedAction: "FLAG_MISSING" }]),
		);
		const notInBranch = pendingWhere.OR?.find(
			(c: any) => c.entityId?.notIn,
		);
		expect(notInBranch.entityId.notIn).toEqual(
			expect.arrayContaining(["dup-conflict", "dup-failed"]),
		);
		// The id lookups must select only the id column.
		const idLookup = storyFindMany.mock.calls.find(
			(c: any) => c[0]?.where?.lastPmSyncStatus === "CONFLICT",
		)?.[0];
		expect(idLookup.select).toEqual({ id: true });
		expect(result.pullDriftCount).toBe(5);
		expect(result.conflictsCount).toBe(1);
		expect(result.failuresCount).toBe(1);
	});

	it("returns all-zero fields cleanly when nothing is actionable", async () => {
		const result = await getReviewCenterCount({
			userId: "user-1",
			projectId: "proj-1",
		});
		expect(result).toEqual({
			conflictsCount: 0,
			failuresCount: 0,
			pullDriftCount: 0,
			total: 0,
		});
	});

	it("counts a FAILED story with a PENDING FLAG_MISSING change as pull-drift, not a failure (deleted-card unstick — count parity)", async () => {
		mockStoryIds({ CONFLICT: [], FAILED: ["gone"] });
		// One PENDING FLAG_MISSING change on the FAILED story.
		pendingFindMany.mockImplementation(({ where }: any) =>
			where?.proposedAction === "FLAG_MISSING"
				? Promise.resolve([{ entityId: "gone" }])
				: Promise.resolve([]),
		);
		pendingCount.mockResolvedValue(1);

		const result = await getReviewCenterCount({
			organizationId: "org-1",
			projectId: "proj-1",
		});

		// "gone" is removed from the failure count (it surfaces in pull-drift)…
		expect(result.failuresCount).toBe(0);
		// …and is NOT in the visible-id exclude set, so the pull-drift count keeps
		// it (parity with the items query).
		const pendingWhere = pendingCount.mock.calls[0][0].where;
		const notInBranch = pendingWhere.OR?.find(
			(c: any) => c.entityId?.notIn,
		);
		expect(notInBranch.entityId.notIn).not.toContain("gone");
		expect(result.pullDriftCount).toBe(1);
	});

	it("scopes count queries by projectId only — never org/user columns", async () => {
		// Same reason as the items query: these tables have no tenant columns.
		await getReviewCenterCount({ userId: "user-1", projectId: "proj-1" });

		const storyWhere = storyFindMany.mock.calls[0][0].where;
		expect(storyWhere.projectId).toBe("proj-1");
		expect(storyWhere).not.toHaveProperty("organizationId");
		expect(storyWhere).not.toHaveProperty("userId");
		expect(storyWhere).not.toHaveProperty("OR");
	});
});
