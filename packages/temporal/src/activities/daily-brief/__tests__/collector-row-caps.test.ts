/**
 * Every Daily Brief collector must bound how many rows it returns
 * (Fizzy #1997).
 *
 * The collectors' outputs are assembled into one `sections` object that
 * travels to the summarizer as a single activity argument — one gRPC message,
 * hard-capped at 4 MiB. Per-item text caps alone do not bound it: an uncapped
 * row count multiplies straight through, and the PR collector additionally
 * multiplied per-repo across every connected repo.
 *
 * These assertions read the collector sources rather than executing them: the
 * queries need a live database and the outer fetch functions are not exported,
 * but a missing `take:` is exactly the regression worth catching, and it is
 * visible in the source. If a collector is rewritten to bound its rows another
 * way, update the matching assertion deliberately.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..");

const read = (file: string) => readFileSync(join(DIR, file), "utf8");

describe("daily-brief collectors bound their row counts", () => {
	it.each([
		["collect-story-activity.ts", 3],
		["collect-document-changes.ts", 1],
		["collect-meeting-transcripts.ts", 1],
		["collect-teams-proposals.ts", 1],
	])("%s caps every findMany it issues", (file, expectedTakes) => {
		const src = read(file);
		const findManyCount = (src.match(/\.findMany\(/g) ?? []).length;
		const takeCount = (src.match(/take: MAX_[A-Z_]+/g) ?? []).length;

		expect(findManyCount).toBeGreaterThan(0);
		expect(takeCount).toBe(expectedTakes);
	});

	it("the PR collector caps the total across all repos, not just per repo", () => {
		const src = read("collect-github-pull-requests.ts");

		// Per-repo cap alone lets N repos multiply through.
		expect(src).toContain("MAX_PRS_PER_REPO");
		// The aggregate cap is what bounds the section.
		expect(src).toContain("MAX_PRS_TOTAL");
		expect(src).toMatch(/slice\(0,\s*MAX_PRS_TOTAL\)/);
		// And the newest items must survive the cut.
		expect(src).toMatch(/items\.sort\(/);
	});

	it("the releases collector keeps its existing aggregate cap", () => {
		expect(read("collect-github-releases.ts")).toContain(
			"MAX_DEPLOYMENT_ITEMS",
		);
	});
});
