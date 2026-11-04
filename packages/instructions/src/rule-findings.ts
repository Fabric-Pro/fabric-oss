/**
 * The one set of finding categories Rules health speaks in: the deterministic
 * checks (`analyzeRules`), the AI review, and the suggested edits all name
 * what they found, and what an edit addresses, by these, so the counts on the
 * panel, the review and the edits dialog describe the same files.
 *
 * - `over-budget`: always-on rules past the always-on budget (the checks'
 *   `over-budget` finding, the files tiered "over budget").
 * - `cleanup`: every other finding of the checks: a duplicate, a near
 *   duplicate, a long rule, an on-demand rule without a description, or an
 *   empty rule.
 * - `overlap`, `vague`, `narrower-scope`, `better-enforced`: what only the AI
 *   review can see (rules to merge or that contradict each other, rules an
 *   agent cannot act on, rules that belong behind a `paths:` glob, rules a
 *   linter, formatter, test or hook would enforce better).
 *
 * Pure, so the web app reads it too (`@repo/instructions/rule-findings`).
 */

import type { RuleHealthFinding } from "./rules-health";

export const RULE_FINDING_CATEGORIES = [
	"over-budget",
	"overlap",
	"vague",
	"narrower-scope",
	"better-enforced",
	"cleanup",
] as const;

export type RuleFindingCategory = (typeof RULE_FINDING_CATEGORIES)[number];

/** The categories the AI review reports; the other two come from the checks. */
export const AI_RULE_FINDING_CATEGORIES = [
	"overlap",
	"vague",
	"narrower-scope",
	"better-enforced",
] as const satisfies readonly RuleFindingCategory[];

/** One finding: what it is, the rule files it is about, and one line on it. */
export type RuleFinding = {
	category: RuleFindingCategory;
	files: string[];
	summary: string;
};

/** The shared category of one deterministic check finding. */
export function healthFindingCategory(
	kind: RuleHealthFinding["kind"],
): "over-budget" | "cleanup" {
	return kind === "over-budget" ? "over-budget" : "cleanup";
}

/** The checks' findings in the shared shape. */
export function healthRuleFindings(
	findings: readonly RuleHealthFinding[],
): RuleFinding[] {
	return findings.map((finding) => ({
		category: healthFindingCategory(finding.kind),
		files: [...finding.paths],
		summary: finding.detail,
	}));
}

/**
 * Known categories only, each once, in the shared order: what an edit or a
 * finding may carry after a model named them.
 */
export function knownRuleFindingCategories(
	values: readonly unknown[],
): RuleFindingCategory[] {
	return RULE_FINDING_CATEGORIES.filter((category) =>
		values.includes(category),
	);
}

/** Every file a finding names, with the categories it was flagged under. */
export function ruleFindingCategoriesByFile(
	findings: readonly RuleFinding[],
): Map<string, RuleFindingCategory[]> {
	const byFile = new Map<string, Set<RuleFindingCategory>>();
	for (const finding of findings) {
		for (const file of finding.files) {
			const set = byFile.get(file) ?? new Set<RuleFindingCategory>();
			set.add(finding.category);
			byFile.set(file, set);
		}
	}
	return new Map(
		[...byFile].map(([file, set]) => [
			file,
			RULE_FINDING_CATEGORIES.filter((category) => set.has(category)),
		]),
	);
}

export type RuleFindingsSummary = {
	/** How many findings there are. */
	findings: number;
	/** Every file a finding names, each once, in first-mention order. */
	files: string[];
	/** Per category with any finding, in the shared order: how many files it names. */
	counts: Array<{ category: RuleFindingCategory; files: number }>;
};

/**
 * The counts every surface shows for one set of findings. A category counts
 * files, not findings, so "3 over budget" means three files, as the checks'
 * own tier count does.
 */
export function summarizeRuleFindings(
	findings: readonly RuleFinding[],
): RuleFindingsSummary {
	const byFile = ruleFindingCategoriesByFile(findings);
	const counts = RULE_FINDING_CATEGORIES.map((category) => ({
		category,
		files: [...byFile.values()].filter((categories) =>
			categories.includes(category),
		).length,
	})).filter((entry) => entry.files > 0);
	return { findings: findings.length, files: [...byFile.keys()], counts };
}

const MAX_FINDING_SUMMARY_CHARS = 1_000;
const MAX_REVIEW_FINDINGS = 50;

/**
 * The AI review's findings, reduced to what may be shown: a category the
 * review may report (an unknown one, or one the checks own, drops that
 * finding), files among the rules it was given (each once), and a summary.
 * A finding left with no file or no summary is dropped.
 */
export function validateReviewFindings(
	raw: ReadonlyArray<{ category: string; files: string[]; summary: string }>,
	givenPaths: readonly string[],
): RuleFinding[] {
	const known = new Set(givenPaths);
	const out: RuleFinding[] = [];
	for (const finding of raw) {
		const category = finding.category.trim();
		if (
			!(AI_RULE_FINDING_CATEGORIES as readonly string[]).includes(
				category,
			)
		) {
			continue;
		}
		const files = [
			...new Set(finding.files.map((file) => file.trim())),
		].filter((file) => known.has(file));
		const summary = finding.summary
			.trim()
			.slice(0, MAX_FINDING_SUMMARY_CHARS);
		if (files.length === 0 || summary === "") {
			continue;
		}
		out.push({ category: category as RuleFindingCategory, files, summary });
		if (out.length >= MAX_REVIEW_FINDINGS) {
			break;
		}
	}
	return out;
}
