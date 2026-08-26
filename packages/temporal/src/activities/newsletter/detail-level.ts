import type { NewsletterDetailLevel } from "@repo/database";

/**
 * Tier-specific instruction lines injected into the newsletter prompt in place
 * of the historical include/exclude/tone lines. STANDARD returns exactly today's
 * three lines (regression-critical — see detail-level.test.ts).
 */
export function getDetailLevelClause(level: NewsletterDetailLevel): string[] {
	switch (level) {
		case "BRIEF":
			return [
				"Include ONLY the 3 most significant major, user-facing feature additions.",
				"Write ONE short sentence per highlight — keep the whole newsletter extremely concise.",
				"EXCLUDE everything minor: bug fixes, refactors, chores, CI, dependency bumps, tests, and internal/granular work.",
				"Write in a friendly, non-technical tone for customers and partners.",
			];
		case "DETAILED":
			return [
				"Include all notable user-facing feature additions AND significant changes; you MAY also include user-visible fixes and meaningful improvements.",
				"EXCLUDE only trivial work: chores, CI, dependency bumps, and tests.",
				"Write 2-4 sentences per highlight with concrete, specific detail.",
				"Light technical detail is acceptable — the audience may include the internal engineering team.",
			];
		default:
			// STANDARD — the historical default. These three lines are verbatim from
			// the pre-feature prompt; changing them is a regression.
			return [
				"Include ONLY major, user-facing feature additions and significant changes.",
				"EXCLUDE bug fixes, refactors, chores, CI, dependency bumps, tests, and internal/granular work.",
				"Write in a friendly, non-technical tone for customers and partners.",
			];
	}
}
