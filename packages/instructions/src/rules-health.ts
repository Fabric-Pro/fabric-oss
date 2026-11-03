/**
 * Rules health (specs/2026-10-21-ai-artifacts-hub §5.8): how much of a
 * session the project's rules take, and what in them is worth cleaning up.
 * Pure and deterministic; the AI review adds contradictions and merges on top.
 *
 * The tiers are the plugin's (`tierRules` in the CLI): a rule with `paths:`
 * loads only for matching files, a rule marked `load: on-demand` is listed
 * and loaded when a task calls for it, and the rest are always on while they
 * fit `ALWAYS_ON_RULES_BUDGET` characters; past it they are loaded on demand.
 */

export const ALWAYS_ON_RULES_BUDGET = 8_000;
/** A single rule longer than this is worth splitting or scoping. */
const LONG_RULE_CHARS = 4_000;
/** Shingle overlap from which two rules say much the same thing. */
const NEAR_DUPLICATE = 0.6;

export type RuleSource = { path: string; text: string };

export type RuleTier = "always-on" | "scoped" | "on-demand" | "over-budget";

export type RuleHealthFinding = {
	kind:
		| "duplicate"
		| "near-duplicate"
		| "over-budget"
		| "long"
		| "no-description"
		| "empty";
	paths: string[];
	detail: string;
};

export type RulesHealth = {
	budget: number;
	alwaysOnChars: number;
	rules: Array<{ path: string; tier: RuleTier; chars: number }>;
	findings: RuleHealthFinding[];
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The path of a rule file in an instruction tree, or false. */
export function isRuleFilePath(path: string): boolean {
	const lower = path.toLowerCase().replace(/\\/g, "/");
	return (
		lower.endsWith(".md") &&
		(lower.startsWith("rules/") ||
			lower.startsWith(".claude/rules/") ||
			lower.includes("/rules/"))
	);
}

function parse(text: string) {
	const match = FRONTMATTER.exec(text);
	const head = match?.[1] ?? "";
	return {
		head,
		body: match ? text.slice(match[0].length) : text,
		scoped: /^paths:/m.test(head),
		onDemand: /^load:\s*["']?on-demand["']?\s*$/m.test(head),
		described: /^description:\s*\S/m.test(head),
	};
}

function shingles(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	const out = new Set<string>();
	for (let i = 0; i + 4 < words.length; i++) {
		out.add(words.slice(i, i + 5).join(" "));
	}
	return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) {
		return 0;
	}
	let shared = 0;
	for (const s of a) {
		if (b.has(s)) {
			shared++;
		}
	}
	return shared / Math.min(a.size, b.size);
}

function normalized(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function analyzeRules(
	sources: readonly RuleSource[],
	budget = ALWAYS_ON_RULES_BUDGET,
): RulesHealth {
	const sorted = [...sources].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	const findings: RuleHealthFinding[] = [];
	const rules: RulesHealth["rules"] = [];
	let alwaysOnChars = 0;
	const overBudget: string[] = [];
	const parsed = sorted.map((source) => ({
		...source,
		...parse(source.text),
	}));

	for (const rule of parsed) {
		const chars = rule.body.length;
		let tier: RuleTier;
		if (rule.scoped && !rule.onDemand) {
			tier = "scoped";
		} else if (rule.onDemand) {
			tier = "on-demand";
		} else if (alwaysOnChars + chars <= budget) {
			tier = "always-on";
			alwaysOnChars += chars;
		} else {
			tier = "over-budget";
			overBudget.push(rule.path);
		}
		rules.push({ path: rule.path, tier, chars });
		if (rule.body.trim() === "") {
			findings.push({
				kind: "empty",
				paths: [rule.path],
				detail: "The rule has no text.",
			});
		}
		if (chars > LONG_RULE_CHARS) {
			findings.push({
				kind: "long",
				paths: [rule.path],
				detail: `${chars.toLocaleString("en-US")} characters: split it, or scope it with paths: so it loads only where it applies.`,
			});
		}
		if (
			!rule.described &&
			(tier === "on-demand" || tier === "over-budget")
		) {
			findings.push({
				kind: "no-description",
				paths: [rule.path],
				detail: "Loaded on demand without a description: add description: so the agent knows when to load it.",
			});
		}
	}
	if (overBudget.length > 0) {
		findings.push({
			kind: "over-budget",
			paths: overBudget,
			detail: `The always-on rules are past the ${budget.toLocaleString("en-US")}-character budget, so these load on demand. Scope them with paths:, mark the rare ones load: on-demand, or shorten the core.`,
		});
	}

	const seen = new Map<string, string>();
	const exact = new Set<string>();
	for (const rule of parsed) {
		const key = normalized(rule.body);
		if (key === "") {
			continue;
		}
		const first = seen.get(key);
		if (first) {
			findings.push({
				kind: "duplicate",
				paths: [first, rule.path],
				detail: "The same rule twice: keep one.",
			});
			exact.add(rule.path);
		} else {
			seen.set(key, rule.path);
		}
	}
	const grams = parsed.map((rule) => ({
		path: rule.path,
		set: shingles(rule.body),
	}));
	for (let i = 0; i < grams.length; i++) {
		for (let j = i + 1; j < grams.length; j++) {
			const a = grams[i];
			const b = grams[j];
			if (!a || !b || exact.has(a.path) || exact.has(b.path)) {
				continue;
			}
			const score = overlap(a.set, b.set);
			if (score >= NEAR_DUPLICATE) {
				findings.push({
					kind: "near-duplicate",
					paths: [a.path, b.path],
					detail: `${Math.round(score * 100)}% of the text is shared: merge them into one rule.`,
				});
			}
		}
	}
	return { budget, alwaysOnChars, rules, findings };
}
