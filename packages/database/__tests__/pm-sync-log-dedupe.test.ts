/**
 * `hasPmSyncConflictWithDedupeKey` — the status-sync CONFLICT dedupe lookup
 * (Fizzy #2304, spec §4.4 "CONFLICT rows"). Mocks the Prisma client; the
 * real-Postgres behaviour is covered by the db-integration suite.
 *
 * Run with: corepack pnpm --filter @repo/database exec vitest run __tests__/pm-sync-log-dedupe.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { pmSyncLog: { findFirst } },
}));

import { hasPmSyncConflictWithDedupeKey } from "../prisma/queries/pm-sync-log";

const ARGS = {
	projectId: "proj_1",
	entityId: "story_1",
	dedupeKey:
		"status-sync:ambiguous:story_1:workflow::in-progress|workflow::in-review:2026-09-02T10:00:00.000Z",
};

const EXPECTED_QUERY = {
	where: {
		projectId: "proj_1",
		entityId: "story_1",
		direction: "pull",
		status: "CONFLICT",
		errorPayload: { path: ["dedupeKey"], equals: ARGS.dedupeKey },
	},
	orderBy: { createdAt: "desc" },
	select: { id: true },
};

beforeEach(() => findFirst.mockReset());

describe("hasPmSyncConflictWithDedupeKey", () => {
	it("finds an existing CONFLICT pull row carrying the dedupe key", async () => {
		findFirst.mockResolvedValue({ id: "log_1" });

		await expect(hasPmSyncConflictWithDedupeKey(ARGS)).resolves.toBe(true);
		expect(findFirst.mock.calls).toEqual([[EXPECTED_QUERY]]);
	});

	it("returns false when no row carries the key", async () => {
		findFirst.mockResolvedValue(null);

		await expect(hasPmSyncConflictWithDedupeKey(ARGS)).resolves.toBe(false);
		expect(findFirst.mock.calls).toEqual([[EXPECTED_QUERY]]);
	});
});
