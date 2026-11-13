/**
 * The time-suggestion drafter is seeded insert-only, so a wording change
 * reaches an environment that already ran the seed only through an UPDATE
 * migration. This pins that the migration patches the drafter's SYSTEM
 * prompt to exactly the rule the source default now carries, so a fresh seed
 * and a patched environment give the model the same instructions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	TIME_SUGGESTION_FALLBACK_BODY,
	TIME_SUGGESTION_PROMPT_AGENT_KEY,
} from "@repo/utils/time-suggestion-prompt";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
	join(
		__dirname,
		"../prisma/migrations/20261112200000_time_suggestion_prompt_no_outcomes/migration.sql",
	),
	"utf8",
);

const OUTCOME_RULE =
	"Never say that a meeting was attended, that work was completed, merged, shipped or fixed, or state any other outcome, unless the evidence itself says so.";

describe("time suggestion prompt: no attendance, completion or outcome claims", () => {
	it("is part of the source default", () => {
		expect(TIME_SUGGESTION_FALLBACK_BODY).toContain(OUTCOME_RULE);
	});

	it("is patched into the seeded SYSTEM prompt by the migration", () => {
		expect(MIGRATION).toContain(
			`p.key = '${TIME_SUGGESTION_PROMPT_AGENT_KEY}'`,
		);
		expect(MIGRATION).toContain("p.scope = 'SYSTEM'");
		const replacement = MIGRATION.match(
			/REPLACE\(\s*pv\.content,\s*'([^']*)',\s*'([^']*)'\s*\)/,
		);
		expect(replacement).not.toBeNull();
		const [, before, after] = replacement ?? [];
		expect(after).toContain(OUTCOME_RULE);
		expect(TIME_SUGGESTION_FALLBACK_BODY).toContain(after);
		expect(
			TIME_SUGGESTION_FALLBACK_BODY.replace(after, before),
		).not.toContain(OUTCOME_RULE);
	});
});
