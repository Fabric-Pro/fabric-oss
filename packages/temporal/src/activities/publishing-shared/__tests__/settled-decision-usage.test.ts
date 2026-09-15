import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvedCallCount } from "./_ast-guards";

/**
 * Every publishing activity that reads a topic's decisions settles them through
 * `settledDecision` (Fizzy #1988 1B).
 *
 * Discovery is by the SHAPE being policed — a production `publishing-*` file
 * that calls `listTopicDecisions` from `@repo/database` — not by the KNOWN list
 * alone, so an eighth content type that derives its own "settled" answer inline
 * fails here rather than silently reintroducing the summary fallback.
 *
 * Counted with `resolvedCallCount` (AST, not source text). NOT DETECTED, as
 * documented on that helper: a call made through a wrapper or by reference, and
 * a nested same-named local that shadows the import.
 */
const activitiesDir = join(__dirname, "..", "..");
const DATABASE_MODULES = ["@repo/database"];
const HELPER_MODULES = ["@repo/utils/publishing-restrictions", "@repo/utils"];
const KNOWN = [
	"publishing-blog-post/generate-blog-post.ts",
	"publishing-case-study/generate-case-study.ts",
	"publishing-linkedin-post/generate-linkedin-post.ts",
	"publishing-newsletter-blurb/generate-newsletter-blurb.ts",
	"publishing-short-post/generate-short-post.ts",
	"publishing-stakeholder-email/generate-stakeholder-email.ts",
	"publishing-webinar-script/generate-webinar-script.ts",
];

function decisionReaders(): string[] {
	const found: string[] = [];
	const walk = (rel: string): void => {
		for (const entry of readdirSync(join(activitiesDir, rel), {
			withFileTypes: true,
		})) {
			const child = `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== "__tests__") {
					walk(child);
				}
			} else if (
				entry.name.endsWith(".ts") &&
				resolvedCallCount(
					join(activitiesDir, child),
					"listTopicDecisions",
					DATABASE_MODULES,
				) > 0
			) {
				found.push(child);
			}
		}
	};
	for (const dir of readdirSync(activitiesDir)) {
		if (dir.startsWith("publishing-") && dir !== "publishing-shared") {
			walk(dir);
		}
	}
	return found.sort();
}

describe("settledDecision is the one way a publishing activity settles a decision", () => {
	it("discovers at least the seven known decision readers", () => {
		expect(decisionReaders()).toEqual(expect.arrayContaining(KNOWN));
	});

	it("every decision reader calls settledDecision exactly once", () => {
		// Collected, then asserted once, so a failure names EVERY file that
		// does not settle through the helper rather than stopping at the first.
		const mismatches = decisionReaders()
			.map((rel) => ({
				rel,
				settles: resolvedCallCount(
					join(activitiesDir, rel),
					"settledDecision",
					HELPER_MODULES,
				),
			}))
			.filter(({ settles }) => settles !== 1);
		expect(mismatches).toEqual([]);
	});
});
