/**
 * Per-branch scanning query-layer tests.
 *
 *  - `normalizeScanBranch` is pure (empty/whitespace ⇒ null, undefined passthrough).
 *  - The branch-scoped reads (`getLatestProjectScan`, `getLastCompletedScanAt`,
 *    `carryForwardFindings`) must only add a `branch` clause to the Prisma
 *    where when the caller actually provided one (incl. `null`), so the default
 *    path stays cross-branch (backward compatible). We assert the exact `where`
 *    passed to a mocked Prisma client — no real database needed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, findMany, createMany } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
	createMany: vi.fn(),
}));

// Mock the Prisma client module scan.ts imports (`db` + `Prisma`). Only `db`
// is used at runtime; `Prisma` is a type-only import so an empty object is fine.
vi.mock("../prisma/client", () => ({
	db: {
		projectScan: {
			findFirst: (...args: unknown[]) => findFirst(...args),
		},
		scanFinding: {
			findMany: (...args: unknown[]) => findMany(...args),
			createMany: (...args: unknown[]) => createMany(...args),
		},
	},
	Prisma: {},
}));

import {
	carryForwardFindings,
	getLastCompletedScanAt,
	getLatestProjectScan,
	normalizeScanBranch,
} from "../prisma/queries/projects/scan";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("normalizeScanBranch", () => {
	it("passes undefined through untouched (⇒ leave stored value)", () => {
		expect(normalizeScanBranch(undefined)).toBeUndefined();
	});

	it("keeps an explicit null (⇒ clear the branch)", () => {
		expect(normalizeScanBranch(null)).toBeNull();
	});

	it("collapses empty / whitespace-only strings to null", () => {
		expect(normalizeScanBranch("")).toBeNull();
		expect(normalizeScanBranch("   ")).toBeNull();
		expect(normalizeScanBranch("\t\n ")).toBeNull();
	});

	it("trims surrounding whitespace on a real branch name", () => {
		expect(normalizeScanBranch("  main ")).toBe("main");
		expect(normalizeScanBranch("develop")).toBe("develop");
		expect(normalizeScanBranch("feature/x")).toBe("feature/x");
	});
});

describe("getLatestProjectScan — branch scoping", () => {
	it("adds a branch clause only when a branch is provided", async () => {
		findFirst.mockResolvedValue(null);
		await getLatestProjectScan("proj-1", {
			status: "COMPLETED",
			branch: "master",
		});
		const where = findFirst.mock.calls[0][0].where;
		expect(where).toMatchObject({
			projectId: "proj-1",
			status: "COMPLETED",
			branch: "master",
		});
	});

	it("omits the branch clause entirely when no branch is passed", async () => {
		findFirst.mockResolvedValue(null);
		await getLatestProjectScan("proj-1", { status: "COMPLETED" });
		const where = findFirst.mock.calls[0][0].where;
		expect("branch" in where).toBe(false);
	});

	it("filters branch:null when null is passed (no-repo scans)", async () => {
		findFirst.mockResolvedValue(null);
		await getLatestProjectScan("proj-1", { branch: null });
		expect(findFirst.mock.calls[0][0].where.branch).toBeNull();
	});
});

describe("getLastCompletedScanAt — per-branch incremental window", () => {
	it("scopes the last-completed lookup to the branch when provided", async () => {
		findFirst.mockResolvedValue({ completedAt: new Date() });
		await getLastCompletedScanAt("proj-1", {
			targetType: "PROJECT",
			branch: "develop",
		});
		const where = findFirst.mock.calls[0][0].where;
		expect(where).toMatchObject({
			projectId: "proj-1",
			status: "COMPLETED",
			targetType: "PROJECT",
			branch: "develop",
		});
	});

	it("does not add a branch clause by default", async () => {
		findFirst.mockResolvedValue(null);
		await getLastCompletedScanAt("proj-1", { targetType: "PROJECT" });
		expect("branch" in findFirst.mock.calls[0][0].where).toBe(false);
	});
});

describe("carryForwardFindings — same-branch previous scan", () => {
	it("scopes the previous-completed-scan lookup to the same branch", async () => {
		// No previous scan on that branch ⇒ returns zeros without copying rows.
		findFirst.mockResolvedValue(null);
		const result = await carryForwardFindings("scan-2", "proj-1", {
			targetType: "PROJECT",
			scannedItemKeys: [],
			branch: "master",
		});
		expect(result).toEqual({ security: 0, accessibility: 0, total: 0 });
		const where = findFirst.mock.calls[0][0].where;
		expect(where).toMatchObject({
			projectId: "proj-1",
			status: "COMPLETED",
			branch: "master",
		});
		// The current scan is always excluded from the "previous" lookup.
		expect(where.id).toEqual({ not: "scan-2" });
		// No previous scan ⇒ never reaches the copy step.
		expect(createMany).not.toHaveBeenCalled();
	});

	it("omits the branch clause when no branch is provided (legacy)", async () => {
		findFirst.mockResolvedValue(null);
		await carryForwardFindings("scan-2", "proj-1", {
			targetType: "PROJECT",
			scannedItemKeys: [],
		});
		expect("branch" in findFirst.mock.calls[0][0].where).toBe(false);
	});
});
