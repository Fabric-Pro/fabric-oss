/**
 * Per-branch scan-checkpoint query-layer tests.
 *
 * The checkpoint reads/writes and the incremental change-count are DB-free: we
 * assert the exact Prisma call args against a mocked client — the composite
 * `projectId_branch` unique, the tenant columns on create, the conditional
 * `branch` clause on `hasActiveScan`, and the incremental count's sentinel + sum
 * behavior. No real database needed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	checkpointFindUnique,
	checkpointFindMany,
	checkpointUpsert,
	scanFindFirst,
} = vi.hoisted(() => ({
	checkpointFindUnique: vi.fn(),
	checkpointFindMany: vi.fn(),
	checkpointUpsert: vi.fn(),
	scanFindFirst: vi.fn(),
}));

// Mock the Prisma client module scan.ts imports (`db` + `Prisma`). Only `db` is
// used at runtime; `Prisma` is a type-only import so an empty object is fine.
// `$transaction` runs the batched count promises just like the real client.
vi.mock("../prisma/client", () => ({
	db: {
		projectScanCheckpoint: {
			findUnique: (...args: unknown[]) => checkpointFindUnique(...args),
			findMany: (...args: unknown[]) => checkpointFindMany(...args),
			upsert: (...args: unknown[]) => checkpointUpsert(...args),
		},
		projectScan: {
			findFirst: (...args: unknown[]) => scanFindFirst(...args),
		},
	},
	Prisma: {},
}));

import {
	getScanCheckpoint,
	hasActiveScan,
	listScanCheckpoints,
	upsertScanCheckpoint,
} from "../prisma/queries/projects/scan";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getScanCheckpoint", () => {
	it("looks up by the composite (projectId, branch) unique", async () => {
		checkpointFindUnique.mockResolvedValue(null);
		await getScanCheckpoint("proj-1", "main");
		expect(checkpointFindUnique.mock.calls[0][0]).toEqual({
			where: {
				projectId_branch: { projectId: "proj-1", branch: "main" },
			},
		});
	});
});

describe("listScanCheckpoints", () => {
	it("lists every checkpoint for the project", async () => {
		checkpointFindMany.mockResolvedValue([]);
		await listScanCheckpoints("proj-1");
		expect(checkpointFindMany.mock.calls[0][0]).toEqual({
			where: { projectId: "proj-1" },
		});
	});
});

describe("upsertScanCheckpoint", () => {
	const base = {
		projectId: "proj-1",
		branch: "main",
		commitSha: "abc123",
		lastScanId: "scan-9",
		lastScannedAt: new Date("2026-01-01T00:00:00Z"),
		changedFileCount: 4,
		changedCommitCount: 2,
		userId: "user-1",
		organizationId: "org-1",
	};

	it("upserts on the composite unique, with tenant columns on create", async () => {
		checkpointUpsert.mockResolvedValue({ id: "cp-1" });
		await upsertScanCheckpoint(base);
		const arg = checkpointUpsert.mock.calls[0][0];
		expect(arg.where).toEqual({
			projectId_branch: { projectId: "proj-1", branch: "main" },
		});
		expect(arg.create).toMatchObject({
			projectId: "proj-1",
			branch: "main",
			commitSha: "abc123",
			lastScanId: "scan-9",
			lastScannedAt: base.lastScannedAt,
			changedFileCount: 4,
			changedCommitCount: 2,
			userId: "user-1",
			organizationId: "org-1",
		});
		// Update advances the scan-scoped fields, never the tenant/identity columns.
		expect(arg.update).toEqual({
			commitSha: "abc123",
			lastScanId: "scan-9",
			lastScannedAt: base.lastScannedAt,
			changedFileCount: 4,
			changedCommitCount: 2,
		});
	});

	it("defaults optional counts / lastScanId / organizationId to null on create", async () => {
		checkpointUpsert.mockResolvedValue({ id: "cp-1" });
		await upsertScanCheckpoint({
			projectId: "proj-1",
			branch: "main",
			commitSha: "abc123",
			lastScannedAt: base.lastScannedAt,
			userId: "user-1",
		});
		expect(checkpointUpsert.mock.calls[0][0].create).toMatchObject({
			lastScanId: null,
			changedFileCount: null,
			changedCommitCount: null,
			organizationId: null,
		});
	});

	it("normalizes (trims) the branch before keying the upsert", async () => {
		checkpointUpsert.mockResolvedValue({ id: "cp-1" });
		await upsertScanCheckpoint({ ...base, branch: "  develop  " });
		expect(checkpointUpsert.mock.calls[0][0].where).toEqual({
			projectId_branch: { projectId: "proj-1", branch: "develop" },
		});
	});

	it("throws on a blank / whitespace-only branch (never a null-branch checkpoint)", async () => {
		await expect(
			upsertScanCheckpoint({ ...base, branch: "   " }),
		).rejects.toThrow();
		expect(checkpointUpsert).not.toHaveBeenCalled();
	});
});

describe("hasActiveScan — per-branch dedupe", () => {
	it("adds a branch clause when a branch is provided", async () => {
		scanFindFirst.mockResolvedValue(null);
		await hasActiveScan("proj-1", { branch: "master" });
		const where = scanFindFirst.mock.calls[0][0].where;
		expect(where).toMatchObject({
			projectId: "proj-1",
			branch: "master",
			status: { in: ["PENDING", "RUNNING"] },
		});
	});

	it("omits the branch clause entirely when no branch is passed", async () => {
		scanFindFirst.mockResolvedValue(null);
		await hasActiveScan("proj-1");
		expect("branch" in scanFindFirst.mock.calls[0][0].where).toBe(false);
	});

	it("filters branch:null when null is passed (no-repo scans)", async () => {
		scanFindFirst.mockResolvedValue(null);
		await hasActiveScan("proj-1", { branch: null });
		expect(scanFindFirst.mock.calls[0][0].where.branch).toBeNull();
	});

	it("keeps the storyId clause alongside the branch clause", async () => {
		scanFindFirst.mockResolvedValue({ id: "scan-1" });
		const active = await hasActiveScan("proj-1", {
			storyId: "story-1",
			branch: "master",
		});
		expect(active).toBe(true);
		expect(scanFindFirst.mock.calls[0][0].where).toMatchObject({
			storyId: "story-1",
			branch: "master",
		});
	});
});
