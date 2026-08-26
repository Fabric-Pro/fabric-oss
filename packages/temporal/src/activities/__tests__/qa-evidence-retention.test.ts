/**
 * The QA evidence retention sweep.
 *
 * This is the first thing in the codebase that deletes a customer's stored
 * screenshots, so most of these assert that it does NOT delete something: zero
 * means keep forever, a project on defaults gets 90 days rather than zero, and a
 * row whose object delete failed keeps its ledger entry. Getting any of those
 * backwards destroys evidence with no undo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listEvidencePage = vi.fn();
const resolveRetentionDays = vi.fn();
const deleteEvidenceRows = vi.fn(async (ids: string[]) => ids.length);
const countRunEvidence = vi.fn(async () => 0);
const deleteObjects = vi.fn(
	async (keys: string[], _options: { bucket: string }) => ({
		deleted: keys.length,
		errors: [] as { key: string; message: string }[],
	}),
);

vi.mock("@repo/database", () => ({
	listEvidencePage: (i: unknown) => listEvidencePage(i),
	resolveRetentionDays: (i: unknown) => resolveRetentionDays(i),
	deleteEvidenceRows: (i: string[]) => deleteEvidenceRows(i),
	countRunEvidence: () => countRunEvidence(),
}));
vi.mock("@repo/storage", () => ({
	deleteObjects: (k: string[], o: { bucket: string }) => deleteObjects(k, o),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	hasExpired,
	purgeExpiredRunEvidenceActivity,
} from "../qa-evidence-retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function row(over: Partial<Record<string, unknown>> = {}) {
	return {
		id: "e1",
		bucket: "qa-run-evidence",
		storageKey: "org1/qa-runs/p1/tc1/step-1-123.png",
		projectId: "p1",
		capturedAt: new Date(NOW - 200 * DAY),
		organizationId: "org1",
		...over,
	};
}

/** One page of rows, then an empty page so the loop terminates. */
function pages(...batches: unknown[][]) {
	let i = 0;
	listEvidencePage.mockImplementation(async () => batches[i++] ?? []);
}

describe("hasExpired", () => {
	it("keeps evidence forever at 0", () => {
		// The branch that turns a retention sweep into a data-loss incident if it
		// is ever read as "expire immediately".
		expect(
			hasExpired({
				capturedAt: new Date(NOW - 10_000 * DAY),
				retentionDays: 0,
				now: NOW,
			}),
		).toBe(false);
	});

	it("keeps evidence forever on a nonsense negative window", () => {
		expect(
			hasExpired({
				capturedAt: new Date(NOW - 10_000 * DAY),
				retentionDays: -30,
				now: NOW,
			}),
		).toBe(false);
	});

	it("expires only past the window, not on it", () => {
		const capturedAt = new Date(NOW - 90 * DAY);
		expect(hasExpired({ capturedAt, retentionDays: 90, now: NOW })).toBe(
			false,
		);
		expect(hasExpired({ capturedAt, retentionDays: 89, now: NOW })).toBe(
			true,
		);
	});
});

describe("purgeExpiredRunEvidenceActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("FABRIC_FEATURE_TEST_CASES", "true");
		deleteObjects.mockImplementation(async (keys: string[]) => ({
			deleted: keys.length,
			errors: [] as { key: string; message: string }[],
		}));
		deleteEvidenceRows.mockImplementation(
			async (ids: string[]) => ids.length,
		);
		countRunEvidence.mockResolvedValue(0);
		vi.setSystemTime(new Date(NOW));
	});

	it("examines nothing when the QA feature is off", async () => {
		vi.stubEnv("FABRIC_FEATURE_TEST_CASES", "false");
		const r = await purgeExpiredRunEvidenceActivity();
		expect(r.ran).toBe(false);
		expect(listEvidencePage).not.toHaveBeenCalled();
		expect(deleteObjects).not.toHaveBeenCalled();
	});

	it("deletes the object before dropping its ledger row", async () => {
		pages([row()]);
		resolveRetentionDays.mockResolvedValue(new Map([["p1", 90]]));

		const r = await purgeExpiredRunEvidenceActivity();

		expect(deleteObjects).toHaveBeenCalledWith(
			["org1/qa-runs/p1/tc1/step-1-123.png"],
			{ bucket: "qa-run-evidence" },
		);
		expect(deleteEvidenceRows).toHaveBeenCalledWith(["e1"]);
		expect(r.deletedObjects).toBe(1);
		expect(r.deletedRows).toBe(1);
	});

	it("keeps the ledger row when the object delete failed", async () => {
		// The row is the only record that the object exists. Dropping it on a
		// failed delete strands the object forever, which is the exact orphan this
		// table was added to prevent.
		pages([row({ id: "e1" }), row({ id: "e2", storageKey: "k2" })]);
		resolveRetentionDays.mockResolvedValue(new Map([["p1", 90]]));
		deleteObjects.mockResolvedValue({
			deleted: 1,
			errors: [{ key: "k2", message: "AccessDenied" }],
		});

		const r = await purgeExpiredRunEvidenceActivity();

		expect(deleteEvidenceRows).toHaveBeenCalledWith(["e1"]);
		expect(r.objectErrors).toBe(1);
		expect(r.deletedObjects).toBe(1);
	});

	it("leaves a project set to 0 alone, however old its evidence", async () => {
		pages([row({ capturedAt: new Date(NOW - 5_000 * DAY) })]);
		resolveRetentionDays.mockResolvedValue(new Map([["p1", 0]]));

		const r = await purgeExpiredRunEvidenceActivity();

		expect(deleteObjects).not.toHaveBeenCalled();
		expect(r.deletedObjects).toBe(0);
		expect(r.scanned).toBe(1);
	});

	it("applies the 90-day default to a project that never saved its settings", async () => {
		// Such a project has no ProjectQaSettings row at all, so the window map has
		// no entry for it. Reading that absence as 0 would keep evidence forever
		// for most projects, which is the failure the sweep exists to fix.
		pages([row({ capturedAt: new Date(NOW - 120 * DAY) })]);
		resolveRetentionDays.mockResolvedValue(new Map());

		const r = await purgeExpiredRunEvidenceActivity();

		expect(r.deletedObjects).toBe(1);
	});

	it("groups deletes by bucket so a renamed bucket cannot strand old rows", async () => {
		pages([
			row({ id: "e1", storageKey: "a", bucket: "old-bucket" }),
			row({ id: "e2", storageKey: "b", bucket: "new-bucket" }),
		]);
		resolveRetentionDays.mockResolvedValue(new Map([["p1", 90]]));

		await purgeExpiredRunEvidenceActivity();

		expect(deleteObjects).toHaveBeenCalledTimes(2);
		expect(deleteObjects).toHaveBeenCalledWith(["a"], {
			bucket: "old-bucket",
		});
		expect(deleteObjects).toHaveBeenCalledWith(["b"], {
			bucket: "new-bucket",
		});
	});

	it("advances past a page it deleted nothing from", async () => {
		// Every row still inside its window. The keyset must still move, or the
		// sweep re-reads the same page until MAX_PAGES and never reaches the old
		// evidence behind it.
		pages([row({ id: "keep1" })], [row({ id: "keep2" })]);
		resolveRetentionDays.mockResolvedValue(new Map([["p1", 3650]]));

		const r = await purgeExpiredRunEvidenceActivity();

		expect(listEvidencePage).toHaveBeenNthCalledWith(1, {
			afterId: null,
			limit: 500,
		});
		expect(listEvidencePage).toHaveBeenNthCalledWith(2, {
			afterId: "keep1",
			limit: 500,
		});
		expect(r.pages).toBe(2);
		expect(r.deletedObjects).toBe(0);
	});

	it("stops at the per-run deletion budget instead of deleting unbounded", async () => {
		const big = Array.from({ length: 500 }, (_, n) =>
			row({ id: `e${n}`, storageKey: `k${n}` }),
		);
		// Five full pages of expired rows: 2500 candidates against a 2000 cap.
		pages(big, big, big, big, big);
		resolveRetentionDays.mockResolvedValue(new Map([["p1", 90]]));

		const r = await purgeExpiredRunEvidenceActivity();

		expect(r.hitDeletionCap).toBe(true);
		expect(r.deletedObjects).toBeLessThanOrEqual(2000);
	});
});
