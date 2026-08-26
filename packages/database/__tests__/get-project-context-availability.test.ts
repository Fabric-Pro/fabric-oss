/**
 * Tests for getProjectContextAvailability — focused on the new
 * `websiteSources` count surfaced for URL Context Sources.
 *
 * Mocks the Prisma client to avoid DATABASE_URL requirement.
 * Run with: pnpm --filter @repo/database test __tests__/get-project-context-availability.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` is required because vi.mock factories below are themselves
// hoisted above module-level `const` declarations.
const { groupByMock, countMock } = vi.hoisted(() => ({
	groupByMock: vi.fn(),
	countMock: vi.fn(),
}));

// The query uses `Promise.all` slots:
//   [0] groupBy    → contextTypeCounts
//   [1] count      → teamsCount
//   [2] count      → slackCount
//   [3] findMany   → repo integrations (codebase state)
//   [4] findMany   → per-repo code index rows (codebase state)
//   [5] findUnique → rag settings (codebase state)
// `countMock` now backs only the teams + slack counts (the legacy
// CODE_ANALYSIS count was removed; codebase availability is derived from the
// integration/index/toggle signals instead).

vi.mock("../prisma/client", () => ({
	db: {
		projectContext: {
			groupBy: groupByMock,
			count: countMock,
		},
		// Codebase-signal tables — default to "nothing connected" so the
		// existing websiteSources tests still see hasCodebase: false.
		projectRepositoryIntegration: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		projectCodeIndex: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		projectRagSettings: {
			findUnique: vi.fn().mockResolvedValue(null),
		},
	},
	Prisma: { sql: vi.fn() },
}));

import { getProjectContextAvailability } from "../prisma/queries/projects/contexts";

const PROJECT_ID = "proj-website-sources";

describe("getProjectContextAvailability — websiteSources", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default zero counts for the three secondary `.count` calls; each test
		// overrides as needed.
		countMock.mockResolvedValue(0);
	});

	it("returns websiteSources count matching seeded LINK rows", async () => {
		groupByMock.mockResolvedValueOnce([
			{ type: "LINK", _count: 4 },
			{ type: "FILE", _count: 1 },
		]);

		const result = await getProjectContextAvailability(`${PROJECT_ID}-1`);

		expect(result.websiteSources).toBe(4);
		expect(result.fileCount).toBe(1);
	});

	it("returns websiteSources = 0 when no LINK rows exist", async () => {
		groupByMock.mockResolvedValueOnce([
			{ type: "FILE", _count: 2 },
			{ type: "MEETING_TRANSCRIPT", _count: 3 },
		]);

		const result = await getProjectContextAvailability(`${PROJECT_ID}-2`);

		expect(result.websiteSources).toBe(0);
	});

	it("derives websiteSources from contextTypeCounts without an extra query", async () => {
		groupByMock.mockResolvedValueOnce([{ type: "LINK", _count: 7 }]);

		await getProjectContextAvailability(`${PROJECT_ID}-3`);

		// Only the 2 secondary counts (teams, slack) — NOT one for LINK rows
		// (groupBy already gives that) and NOT the removed CODE_ANALYSIS count.
		expect(countMock).toHaveBeenCalledTimes(2);
	});

	it("includes websiteSources in the returned ContextAvailabilityResult shape", async () => {
		groupByMock.mockResolvedValueOnce([{ type: "LINK", _count: 2 }]);

		const result = await getProjectContextAvailability(`${PROJECT_ID}-4`);

		// Sanity-check the full result shape so downstream type changes
		// (e.g. removing websiteSources by accident) are caught.
		expect(result).toMatchObject({
			hasCodebase: false,
			transcriptCount: 0,
			fileCount: 0,
			integrationCount: 0,
			teamsCount: 0,
			slackCount: 0,
			websiteSources: 2,
		});
	});
});
