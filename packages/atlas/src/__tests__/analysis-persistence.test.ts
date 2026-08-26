/**
 * Per-branch analysis persistence — query-layer contracts.
 *
 * Locks: `findAnalysis` keys on the FULL (projectId, repositoryIntegrationId,
 * branch) triple; `getOrCreateAnalysis` re-finds the winner after a P2002
 * concurrent create; adoption re-points orphaned per-branch rows one by one,
 * preferring the integration's current monitored branch and SKIPPING (null)
 * rows whose (project, integration, branch) slot is already taken.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		atlasAnalysis: {
			findFirst: (...args: unknown[]) => mockFindFirst(...args),
			findMany: (...args: unknown[]) => mockFindMany(...args),
			create: (...args: unknown[]) => mockCreate(...args),
			update: (...args: unknown[]) => mockUpdate(...args),
		},
	},
	Prisma: {},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(),
}));

import {
	adoptAnalysis,
	findAdoptableAnalyses,
	findAnalysis,
	findInFlightAnalysisForIntegration,
	getOrCreateAnalysis,
} from "../queries";

const ctx = { userId: "user-1", organizationId: "org-1" };

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "an-1",
		projectId: "p1",
		repositoryIntegrationId: "int-1",
		repositoryUrl: "https://github.com/acme/widgets",
		branch: "main",
		status: "READY",
		updatedAt: new Date("2026-06-01T00:00:00Z"),
		...overrides,
	};
}

const createInput = {
	projectId: "p1",
	repositoryIntegrationId: "int-1",
	provider: "GITHUB",
	repositoryUrl: "https://github.com/acme/widgets",
	repositoryName: "widgets",
	branch: "develop",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("findAnalysis — triple-key identity", () => {
	it("filters by projectId + repositoryIntegrationId + branch + tenant", async () => {
		mockFindFirst.mockResolvedValue(makeRow());

		await findAnalysis(ctx, "p1", "int-1", "main");

		expect(mockFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				repositoryIntegrationId: "int-1",
				branch: "main",
				organizationId: "org-1",
			},
		});
	});
});

describe("findInFlightAnalysisForIntegration — branch-agnostic run guard", () => {
	it("matches any in-flight row of the integration (served status OR background-run marker), with no branch filter", async () => {
		mockFindFirst.mockResolvedValue(null);

		await findInFlightAnalysisForIntegration(ctx, "p1", "int-1");

		const where = mockFindFirst.mock.calls[0][0].where;
		// R2: a re-analysis of an already-READY snapshot keeps `status` = READY,
		// so the guard must ALSO match via `activeRunStatus` — hence the OR.
		expect(where).toEqual({
			projectId: "p1",
			repositoryIntegrationId: "int-1",
			OR: [
				{ status: { in: ["PENDING", "ANALYZING"] } },
				{ activeRunStatus: { in: ["PENDING", "ANALYZING"] } },
			],
			organizationId: "org-1",
		});
		expect(where).not.toHaveProperty("branch");
	});
});

describe("getOrCreateAnalysis — concurrent-create safety", () => {
	it("returns the existing row for the (project, repo, branch) triple without creating", async () => {
		mockFindFirst.mockResolvedValue(makeRow({ branch: "develop" }));

		const row = await getOrCreateAnalysis(ctx, createInput);

		expect(row.branch).toBe("develop");
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("creates a fresh per-branch row when the triple has none", async () => {
		mockFindFirst.mockResolvedValue(null);
		mockCreate.mockResolvedValue(
			makeRow({
				id: "an-new",
				branch: "develop",
				status: "NOT_ANALYZED",
			}),
		);

		const row = await getOrCreateAnalysis(ctx, createInput);

		expect(mockCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				projectId: "p1",
				repositoryIntegrationId: "int-1",
				branch: "develop",
				status: "NOT_ANALYZED",
			}),
		});
		expect(row.id).toBe("an-new");
	});

	it("re-finds the winner by the same triple after a P2002 concurrent create", async () => {
		const winner = makeRow({ id: "an-winner", branch: "develop" });
		mockFindFirst
			.mockResolvedValueOnce(null) // initial miss
			.mockResolvedValueOnce(winner); // post-P2002 re-find
		mockCreate.mockRejectedValue({ code: "P2002" });

		const row = await getOrCreateAnalysis(ctx, createInput);

		expect(row.id).toBe("an-winner");
		expect(mockFindFirst).toHaveBeenCalledTimes(2);
		expect(mockFindFirst.mock.calls[1][0].where).toEqual(
			expect.objectContaining({
				projectId: "p1",
				repositoryIntegrationId: "int-1",
				branch: "develop",
			}),
		);
	});

	it("rethrows non-P2002 create failures", async () => {
		mockFindFirst.mockResolvedValue(null);
		mockCreate.mockRejectedValue(new Error("db down"));

		await expect(getOrCreateAnalysis(ctx, createInput)).rejects.toThrow(
			"db down",
		);
	});
});

describe("findAdoptableAnalyses — per-branch orphan discovery", () => {
	it("returns every orphaned row for the URL, preferred branch first", async () => {
		mockFindMany.mockResolvedValue([
			// Newest first from the DB; none belong to a live integration.
			makeRow({
				id: "an-main",
				branch: "main",
				repositoryIntegrationId: "int-old",
			}),
			makeRow({
				id: "an-develop",
				branch: "develop",
				repositoryIntegrationId: "int-old",
			}),
			// A live sibling repo's row — must never be stolen.
			makeRow({
				id: "an-live",
				branch: "main",
				repositoryIntegrationId: "int-live",
			}),
			// A different repository entirely.
			makeRow({
				id: "an-other",
				repositoryUrl: "https://github.com/acme/other",
				repositoryIntegrationId: "int-old-2",
			}),
		]);

		const orphans = await findAdoptableAnalyses(
			ctx,
			"p1",
			"https://github.com/acme/widgets",
			["int-live"],
			"develop",
		);

		expect(orphans.map((o) => o.id)).toEqual(["an-develop", "an-main"]);
	});
});

describe("adoptAnalysis — conflict-safe re-point", () => {
	it("returns the updated row on success", async () => {
		const updated = makeRow({ repositoryIntegrationId: "int-new" });
		mockUpdate.mockResolvedValue(updated);

		const result = await adoptAnalysis(ctx, "an-1", "int-new", {
			provider: "GITHUB",
			repositoryUrl: "https://github.com/acme/widgets",
			repositoryName: "widgets",
		});

		expect(result).toEqual(updated);
	});

	it("returns null (skip) when the per-branch slot is already occupied — P2002", async () => {
		mockUpdate.mockRejectedValue({ code: "P2002" });

		const result = await adoptAnalysis(ctx, "an-1", "int-new", {
			provider: "GITHUB",
			repositoryUrl: "https://github.com/acme/widgets",
			repositoryName: "widgets",
		});

		expect(result).toBeNull();
	});

	it("rethrows non-P2002 failures", async () => {
		mockUpdate.mockRejectedValue(new Error("db down"));

		await expect(
			adoptAnalysis(ctx, "an-1", "int-new", {
				provider: "GITHUB",
				repositoryUrl: "https://github.com/acme/widgets",
				repositoryName: "widgets",
			}),
		).rejects.toThrow("db down");
	});
});
