/**
 * `extractionStatus` was being written by two different steps with two
 * different meanings.
 *
 * Extraction fills `content`. Embedding then indexes that content for search —
 * and when only the indexing failed, `context-embedding.ts` stamped the same
 * `FAILED` onto the row. A staging sweep on 18 Aug 2026 found all 49 meeting
 * transcripts in one project flagged red, every one of them stored in full and
 * perfectly readable, because a single embedding deployment was misconfigured.
 *
 * PR #2893 narrowed the BADGE ("Not searchable" instead of "Failed"), but the
 * stored status still said FAILED, so every other reader of the field — health
 * counters, filters, exports, the public API — kept seeing a broken row that
 * was not broken.
 *
 * The rule this pins: an indexing failure must never downgrade a row whose
 * extraction already COMPLETED. It records the reason and leaves the status
 * alone. A row that never completed extraction still goes FAILED, because
 * leaving THAT one alone would strand it at "Pending" forever — the bug the
 * FAILED stamp was originally added to prevent.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/context-indexing-failure.test.ts
 */

import { describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
	findUnique: vi.fn(),
	update: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectContext: {
			findUnique: client.findUnique,
			update: client.update,
		},
	},
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));

import {
	buildIndexingFailureUpdate,
	recordContextIndexingFailure,
} from "../prisma/queries/projects/contexts";

const MESSAGE = "Search indexing failed: the embedding deployment is missing";

describe("buildIndexingFailureUpdate", () => {
	it("leaves a completed extraction's status alone", () => {
		const update = buildIndexingFailureUpdate("COMPLETED", MESSAGE);

		expect(update.extractionStatus).toBeUndefined();
		expect(update.extractionError).toBe(MESSAGE);
	});

	it("still fails a row whose extraction never completed", () => {
		const update = buildIndexingFailureUpdate("PENDING", MESSAGE);

		expect(update.extractionStatus).toBe("FAILED");
		expect(update.extractionError).toBe(MESSAGE);
	});

	it("still fails a row mid-extraction", () => {
		const update = buildIndexingFailureUpdate("EXTRACTING", MESSAGE);

		expect(update.extractionStatus).toBe("FAILED");
	});

	it("treats an unknown status as not-yet-extracted", () => {
		const update = buildIndexingFailureUpdate(null, MESSAGE);

		expect(update.extractionStatus).toBe("FAILED");
	});
});

/**
 * Living Memory design 2026-09-23 §5.3.1 step 9: a re-embed deletes the
 * row's points before it embeds. A pass that fails after that left a row
 * whose `embeddedAt` still said it was indexed while the index held nothing
 * for it, and nothing ever came back for it. The failure write now clears
 * `embeddedAt` when the caller says its points were removed, so the row
 * reads as awaiting indexing and the next repair re-embeds it. The status
 * rule above is unchanged either way.
 */
describe("buildIndexingFailureUpdate — a pass that had removed the row's points", () => {
	it("also clears embeddedAt, with the status rule unchanged", () => {
		expect(
			buildIndexingFailureUpdate("COMPLETED", MESSAGE, {
				pointsRemoved: true,
			}),
		).toEqual({ extractionError: MESSAGE, embeddedAt: null });
		expect(
			buildIndexingFailureUpdate("PENDING", MESSAGE, {
				pointsRemoved: true,
			}),
		).toEqual({
			extractionStatus: "FAILED",
			extractionError: MESSAGE,
			embeddedAt: null,
		});
	});

	it("leaves embeddedAt alone when no points were removed", () => {
		expect(
			buildIndexingFailureUpdate("COMPLETED", MESSAGE),
		).not.toHaveProperty("embeddedAt");
		expect(
			buildIndexingFailureUpdate("COMPLETED", MESSAGE, {
				pointsRemoved: false,
			}),
		).not.toHaveProperty("embeddedAt");
	});
});

describe("recordContextIndexingFailure", () => {
	it("writes the cleared embeddedAt with the reason when the pass removed the row's points", async () => {
		client.findUnique.mockResolvedValue({ extractionStatus: "COMPLETED" });
		client.update.mockResolvedValue({});

		await recordContextIndexingFailure("ctx-1", MESSAGE, {
			pointsRemoved: true,
		});

		expect(client.update).toHaveBeenCalledWith({
			where: { id: "ctx-1" },
			data: { extractionError: MESSAGE, embeddedAt: null },
		});
	});

	it("writes only the reason, as before, when called without the flag", async () => {
		client.findUnique.mockResolvedValue({ extractionStatus: "COMPLETED" });
		client.update.mockResolvedValue({});

		await recordContextIndexingFailure("ctx-1", MESSAGE);

		expect(client.update).toHaveBeenCalledWith({
			where: { id: "ctx-1" },
			data: { extractionError: MESSAGE },
		});
	});
});
