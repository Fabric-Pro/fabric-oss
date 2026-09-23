/**
 * One eligibility predicate, four readers (Fizzy #2211).
 *
 * The capability gate that hides "Remove AI Recommended Items", the batch
 * list, the preview and the removal door must agree on which items a removal
 * takes. If any of them built its own WHERE, the gate could offer a removal
 * the door then finds nothing for, or the preview could promise items the
 * door leaves behind. This pins that each reader goes through the shared
 * builder in @repo/database and that none spells the eligibility rule out
 * inline.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modulesRoot = resolve(__dirname, "../../../..");

function source(relativePath: string): string {
	return readFileSync(resolve(modulesRoot, relativePath), "utf-8");
}

const READERS: Array<[string, RegExp]> = [
	["capabilities/evidence.ts", /\bcountEligibleAiRecommendationBatches\s*\(/],
	[
		"projects/procedures/ai-recommended/list-batches.ts",
		/\baiRecommendedEligibleWhere\s*\(/,
	],
	[
		"projects/procedures/ai-recommended/preview-batch.ts",
		/\baiRecommendedEligibleWhere\s*\(/,
	],
	[
		"projects/procedures/ai-recommended/remove-batch.ts",
		/\baiRecommendedEligibleWhere\s*\(/,
	],
];

describe("AI-recommended batch eligibility has one predicate", () => {
	it.each(READERS)("%s reads it through the shared builder", (file, uses) => {
		expect(source(file)).toMatch(uses);
	});

	it.each(READERS)("%s does not restate the rule inline", (file) => {
		// The rule's distinguishing clause. Protect's own write filter is the
		// one legitimate inline use and is not a reader here.
		expect(source(file)).not.toMatch(/aiBatchProtectedAt:\s*null/);
	});
});
