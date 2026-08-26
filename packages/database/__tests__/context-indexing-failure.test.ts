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

import { describe, expect, it } from "vitest";
import { buildIndexingFailureUpdate } from "../prisma/queries/projects/contexts";

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
