/**
 * Procedure-level tests for the per-branch incremental-scan status query
 * (`scan.branches`). Exercises the pure status-derivation table directly, plus
 * the handler's orchestration (tenant gate → AtlasService.listBranches → the
 * checkpoint + latest-scan join) with `@repo/database` and `@repo/atlas` mocked
 * — no Prisma, no repo I/O.
 *
 * Harness mirrors `scan-procedures.test.ts`: the `../../../../orpc/procedures`
 * chainable is stubbed so `.handler(fn)` hands back `{ _handler: fn }`, invoked
 * directly.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BranchScanStatusValue,
	deriveBranchScanStatus,
} from "../branch-status";

// --- @repo/database mock (hoisted spies) -------------------------------------
const {
	mockHasProjectAccess,
	mockListScanCheckpoints,
	mockGetLatestProjectScan,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockListScanCheckpoints: vi.fn(),
	mockGetLatestProjectScan: vi.fn(),
}));

// Spread the REAL @repo/database exports (so transitively-eager consumers find
// every symbol they expect at module-eval), then override the handful of query
// functions this procedure calls + `db` so no Prisma connection is opened.
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {},
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		listScanCheckpoints: (...a: unknown[]) => mockListScanCheckpoints(...a),
		getLatestProjectScan: (...a: unknown[]) =>
			mockGetLatestProjectScan(...a),
	};
});

// --- @repo/atlas mock: new AtlasService(...).listBranches(...) ----------------
const { mockListBranches } = vi.hoisted(() => ({
	mockListBranches: vi.fn(),
}));
vi.mock("@repo/atlas", () => ({
	AtlasService: class {
		listBranches = (...a: unknown[]) => mockListBranches(...a);
	},
}));

// --- procedures chainable: `.handler(fn)` -> `{ _handler: fn }` --------------
// The procedure file imports `../../../../orpc/procedures`; from this test file
// (one directory deeper, in `scan/__tests__/`) the same module is
// `../../../../../orpc/procedures`. Mock both specifiers.
const { proceduresMockFactory } = vi.hoisted(() => ({
	proceduresMockFactory: () => {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: unknown) => ({ _handler: fn }),
		});
		return {
			tenantProtectedProcedure: chainable,
			Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
			requireProjectPermission: () => (c: unknown) => c,
		};
	},
}));
vi.mock("../../../../../orpc/procedures", proceduresMockFactory);
vi.mock("../../../../orpc/procedures", proceduresMockFactory);

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

const ctx = { user: { id: "user-1" } };

async function loadHandler(): Promise<Handler> {
	const mod = (await import("../branch-status")) as Record<
		string,
		{ _handler: Handler }
	>;
	return mod.listBranchScanStatusProcedure._handler;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockHasProjectAccess.mockResolvedValue(true);
	mockListScanCheckpoints.mockResolvedValue([]);
	mockGetLatestProjectScan.mockResolvedValue(null);
});

// =============================================================================
// deriveBranchScanStatus — the status-derivation table
// =============================================================================
describe("deriveBranchScanStatus", () => {
	const cases: Array<{
		name: string;
		scanInFlight: boolean;
		headSha: string | null;
		checkpointSha: string | null;
		expected: BranchScanStatusValue;
	}> = [
		{
			name: "checkpoint == HEAD → SCANNED",
			scanInFlight: false,
			headSha: "abc",
			checkpointSha: "abc",
			expected: "SCANNED",
		},
		{
			name: "checkpoint != HEAD → STALE",
			scanInFlight: false,
			headSha: "def",
			checkpointSha: "abc",
			expected: "STALE",
		},
		{
			name: "no checkpoint → NOT_SCANNED",
			scanInFlight: false,
			headSha: "abc",
			checkpointSha: null,
			expected: "NOT_SCANNED",
		},
		{
			name: "in-flight scan → SCANNING (wins over everything)",
			scanInFlight: true,
			headSha: "def",
			checkpointSha: "abc",
			expected: "SCANNING",
		},
		{
			name: "null HEAD with a checkpoint → SCANNED (never false-stale)",
			scanInFlight: false,
			headSha: null,
			checkpointSha: "abc",
			expected: "SCANNED",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(
				deriveBranchScanStatus({
					scanInFlight: c.scanInFlight,
					headSha: c.headSha,
					checkpointSha: c.checkpointSha,
				}),
			).toBe(c.expected);
		});
	}
});

// =============================================================================
// listBranchScanStatusProcedure — orchestration
// =============================================================================
describe("listBranchScanStatusProcedure", () => {
	it("returns an empty list without a checkpoint/scan lookup when no repo is connected", async () => {
		mockListBranches.mockResolvedValue([]);
		const handler = await loadHandler();

		const result = await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(result).toEqual({ branches: [] });
		// No branches ⇒ no downstream joins.
		expect(mockListScanCheckpoints).not.toHaveBeenCalled();
		expect(mockGetLatestProjectScan).not.toHaveBeenCalled();
	});

	it("joins branches to their checkpoint + latest scan and derives each status", async () => {
		const scannedAt = new Date("2026-07-01T00:00:00.000Z");
		const staleScannedAt = new Date("2026-06-01T00:00:00.000Z");
		const nullHeadScannedAt = new Date("2026-06-15T00:00:00.000Z");
		const completedAt = new Date("2026-07-01T00:05:00.000Z");

		mockListBranches.mockResolvedValue([
			{
				name: "main",
				isDefault: true,
				isPinned: false,
				commitSha: "sha-main",
			},
			{
				name: "develop",
				isDefault: false,
				isPinned: true,
				commitSha: "sha-develop-new",
			},
			{
				name: "feature",
				isDefault: false,
				isPinned: false,
				commitSha: "sha-feature",
			},
			{
				name: "hotfix",
				isDefault: false,
				isPinned: false,
				commitSha: "sha-hotfix",
			},
			{
				name: "offline",
				isDefault: false,
				isPinned: false,
				commitSha: null,
			},
		]);
		mockListScanCheckpoints.mockResolvedValue([
			// main: checkpoint == HEAD → SCANNED
			{
				branch: "main",
				commitSha: "sha-main",
				lastScanId: "scan-main",
				changedFileCount: 12,
				changedCommitCount: 3,
				lastScannedAt: scannedAt,
			},
			// develop: checkpoint != HEAD → STALE
			{
				branch: "develop",
				commitSha: "sha-develop-old",
				lastScanId: "scan-develop",
				changedFileCount: 4,
				changedCommitCount: 1,
				lastScannedAt: staleScannedAt,
			},
			// offline: has a checkpoint but HEAD is null → SCANNED (no false stale)
			{
				branch: "offline",
				commitSha: "sha-offline",
				lastScanId: "scan-offline",
				lastScannedAt: nullHeadScannedAt,
			},
			// (feature has no checkpoint → NOT_SCANNED; hotfix is mid-scan)
		]);
		mockGetLatestProjectScan.mockImplementation(
			async (_projectId: string, opts: { branch: string }) => {
				switch (opts.branch) {
					case "main":
						return {
							id: "scan-main",
							status: "COMPLETED",
							completedAt,
							securityFindingCount: 2,
							accessibilityFindingCount: 1,
						};
					case "hotfix":
						// Mid-scan ⇒ SCANNING regardless of any checkpoint.
						return {
							id: "scan-hotfix",
							status: "RUNNING",
							completedAt: null,
							securityFindingCount: 0,
							accessibilityFindingCount: 0,
						};
					default:
						return null;
				}
			},
		);

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				repositoryIntegrationId: "repo-1",
			},
			context: ctx,
		})) as { branches: Array<{ name: string; status: string }> };

		// listBranches is asked for the requested repo integration.
		expect(mockListBranches).toHaveBeenCalledWith({
			projectId: "proj-1",
			repositoryIntegrationId: "repo-1",
		});

		expect(result.branches).toEqual([
			{
				name: "main",
				isDefault: true,
				isPinned: false,
				headSha: "sha-main",
				changedFileCount: 12,
				changedCommitCount: 3,
				status: "SCANNED",
				lastScan: {
					id: "scan-main",
					status: "COMPLETED",
					completedAt,
					securityFindingCount: 2,
					accessibilityFindingCount: 1,
				},
				checkpointSha: "sha-main",
				lastScannedAt: scannedAt,
			},
			{
				name: "develop",
				isDefault: false,
				isPinned: true,
				headSha: "sha-develop-new",
				changedFileCount: 4,
				changedCommitCount: 1,
				status: "STALE",
				lastScan: null,
				checkpointSha: "sha-develop-old",
				lastScannedAt: staleScannedAt,
			},
			{
				name: "feature",
				isDefault: false,
				isPinned: false,
				headSha: "sha-feature",
				changedFileCount: null,
				changedCommitCount: null,
				status: "NOT_SCANNED",
				lastScan: null,
				checkpointSha: null,
				lastScannedAt: null,
			},
			{
				name: "hotfix",
				isDefault: false,
				isPinned: false,
				headSha: "sha-hotfix",
				changedFileCount: null,
				changedCommitCount: null,
				status: "SCANNING",
				lastScan: {
					id: "scan-hotfix",
					status: "RUNNING",
					completedAt: null,
					securityFindingCount: 0,
					accessibilityFindingCount: 0,
				},
				checkpointSha: null,
				lastScannedAt: null,
			},
			{
				name: "offline",
				isDefault: false,
				isPinned: false,
				headSha: null,
				status: "SCANNED",
				lastScan: null,
				changedFileCount: null,
				changedCommitCount: null,
				checkpointSha: "sha-offline",
				lastScannedAt: nullHeadScannedAt,
			},
		]);
	});

	it("throws FORBIDDEN and touches nothing when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { projectId: "proj-x", organizationId: null },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockListBranches).not.toHaveBeenCalled();
		expect(mockListScanCheckpoints).not.toHaveBeenCalled();
		expect(mockGetLatestProjectScan).not.toHaveBeenCalled();
	});
});
