/**
 * "Apply suggestions" on Rules health, as pure functions: which change path
 * the selected edits go through for this viewer and project, and the edits in
 * the shape each path takes. The paths are the editor's own (the same choice
 * `InstructionFileView` makes for one file), so validation, the secret scan,
 * permissions, proposals and audit apply unchanged.
 */

import {
	healthRuleFindings,
	type RuleFinding,
	type RuleFindingCategory,
	type RuleFindingsSummary,
	summarizeRuleFindings,
} from "@repo/instructions/rule-findings";
import type { RuleHealthFinding } from "@repo/instructions/rules-health";
import type { InstructionEdit } from "./edit-snapshot";
import type { InstructionChangeBase } from "./instruction-change-source";
import type { CommitChange } from "./instructions-direct-commit";

/** One edit `suggestRuleEdits` returned. */
export type RuleEditSuggestion = {
	path: string;
	before: string;
	after: string;
	action: "update" | "delete";
	reason: string;
	/** The review's categories the edit addresses. */
	categories: RuleFindingCategory[];
};

/** A file `suggestRuleEdits` has no edit for, and why (a code). */
export type RuleEditSkip = {
	path: string;
	categories: RuleFindingCategory[];
	why: string;
};

/** Each category's word in a count ("3 over budget") and on a badge. */
export const RULE_FINDING_LABELS: Record<RuleFindingCategory, string> = {
	"over-budget": "over budget",
	overlap: "overlap",
	vague: "vague",
	"narrower-scope": "narrower scope",
	"better-enforced": "better enforced",
	cleanup: "clean-up",
};

/** Each category's heading in the review. */
export const RULE_FINDING_HEADINGS: Record<RuleFindingCategory, string> = {
	"over-budget": "Over the always-on budget",
	overlap: "Overlap",
	vague: "Vague rules",
	"narrower-scope": "Narrower scope",
	"better-enforced": "Better enforced automatically",
	cleanup: "To clean up",
};

/**
 * "Review: 4 suggestions in 5 files (3 over budget, 2 overlap)": the one line
 * the panel and the edits dialog both show for a review.
 */
export function ruleReviewSummaryLine(summary: RuleFindingsSummary): string {
	if (summary.findings === 0) {
		return "Review: nothing to change";
	}
	const suggestions = `${summary.findings} ${summary.findings === 1 ? "suggestion" : "suggestions"}`;
	const files = `${summary.files.length} ${summary.files.length === 1 ? "file" : "files"}`;
	const counts = summary.counts
		.map((entry) => `${entry.files} ${RULE_FINDING_LABELS[entry.category]}`)
		.join(", ");
	return `Review: ${suggestions} in ${files} (${counts})`;
}

/** Why a flagged file has no edit, in words, from `suggestRuleEdits`' code. */
export function ruleEditSkipReason(why: string): string {
	switch (why) {
		case "not-changed":
			return "no edit was suggested for it";
		case "unknown-path":
			return "the edit named a file that was not read";
		case "duplicate":
			return "the file was edited twice; the first edit is kept";
		case "no-content":
			return "the edit came back empty";
		case "unchanged":
			return "the edit changed nothing";
		case "too-large":
			return "the edited file would be too large";
		case "secret":
			return "the edit looked like it held a secret";
		case "frontmatter":
			return "the edit broke the frontmatter";
		case "limit":
			return "too many edits for one change";
		default:
			return "the edit failed the checks";
	}
}

/**
 * The always-on budget's state: `over` when the always-on rules exceed the
 * budget, `close` when they are within a tenth of it or any rule was pushed
 * past it, else `headroom`.
 */
export type RulesBudgetState = "headroom" | "close" | "over";

const BUDGET_CLOSE_RATIO = 0.9;

/**
 * Rules health as the panel shows it, computed once: the checks' findings in
 * the shared categories, their counts, and the budget's state. The badge and
 * the budget meter both read this, so they cannot disagree.
 */
export function rulesHealthState(health: {
	budget: number;
	alwaysOnChars: number;
	findings: readonly RuleHealthFinding[];
}): {
	findings: RuleFinding[];
	summary: RuleFindingsSummary;
	budget: RulesBudgetState;
} {
	const findings = healthRuleFindings(health.findings);
	const summary = summarizeRuleFindings(findings);
	const overBudget = summary.counts.some(
		(entry) => entry.category === "over-budget",
	);
	const budget: RulesBudgetState =
		health.alwaysOnChars > health.budget
			? "over"
			: overBudget ||
					health.alwaysOnChars >= health.budget * BUDGET_CLOSE_RATIO
				? "close"
				: "headroom";
	return { findings, summary, budget };
}

/**
 * How the selected edits are submitted:
 *
 * - `commit`: "Commit to <branch>" (`commitChange`), for an editor of a
 *   repository-backed project outside Read-only mode;
 * - `suggest`: a pull request on the member's branch (a proposal), for an
 *   editor of a repository-backed project in Read-only mode, where a commit is
 *   refused;
 * - `version`: a new published version (`derive` + `finalize`, "Save &
 *   publish"), for an editor of a project whose instructions live in Fabric;
 * - `unavailable`: nothing may be submitted, with the sentence that says why.
 */
export type RuleEditRoute =
	| { kind: "commit"; ref: string }
	| { kind: "suggest"; ref: string }
	| { kind: "version" }
	| { kind: "unavailable"; reason: string };

const CANNOT_EDIT_REASON =
	"Only members who can edit the instructions can apply suggestions.";

export function ruleEditRoute(input: {
	canEdit: boolean;
	readOnlyMode: boolean;
	/** `repository.getState`'s availability, undefined while it loads. */
	availability: string | undefined;
	/** The synced branch of a repository read directly (`getState` READY). */
	directRef?: string | null;
	/** `getSettings.sourceOfTruth`, undefined while it loads. */
	sourceOfTruth: string | undefined;
	/** The configured sync's branch, for a repository-backed uploaded project. */
	configuredRef?: string | null;
}): RuleEditRoute {
	if (!input.canEdit) {
		return { kind: "unavailable", reason: CANNOT_EDIT_REASON };
	}
	if (input.availability === undefined) {
		return {
			kind: "unavailable",
			reason: "Loading where the instructions live…",
		};
	}
	if (input.availability === "MIGRATING") {
		return {
			kind: "unavailable",
			reason: "Changes are paused while the instructions move into a repository.",
		};
	}
	if (input.availability === "READY") {
		const ref = input.directRef ?? "";
		return input.readOnlyMode
			? { kind: "suggest", ref }
			: { kind: "commit", ref };
	}
	if (input.availability !== "UPLOAD") {
		return {
			kind: "unavailable",
			reason: "The instructions repository cannot be reached right now.",
		};
	}
	if (input.sourceOfTruth === undefined) {
		return {
			kind: "unavailable",
			reason: "Loading where the instructions live…",
		};
	}
	if (input.sourceOfTruth !== "REPOSITORY") {
		return { kind: "version" };
	}
	if (!input.configuredRef) {
		return {
			kind: "unavailable",
			reason: "These instructions are changed in their repository, which is not configured.",
		};
	}
	return input.readOnlyMode
		? { kind: "suggest", ref: input.configuredRef }
		: { kind: "commit", ref: input.configuredRef };
}

/** The selected edits as `commitChange` takes them. */
export function toCommitChanges(
	edits: readonly RuleEditSuggestion[],
): CommitChange[] {
	return edits.map((edit) =>
		edit.action === "delete"
			? { op: "delete", path: edit.path }
			: {
					op: "put",
					path: edit.path,
					content: edit.after,
					encoding: "utf8",
				},
	);
}

/** The selected edits as `editInstructionSnapshot` takes them. */
export function toInstructionEdits(
	edits: readonly RuleEditSuggestion[],
): InstructionEdit[] {
	return edits.map((edit) =>
		edit.action === "delete"
			? { op: "delete", path: edit.path }
			: {
					op: "put",
					path: edit.path,
					// Explicit UTF-8 text: the server re-hashes what arrives.
					body: new Blob([edit.after], { type: "text/plain" }),
				},
	);
}

/** The commit message (or pull request title) the edits start from. */
export function defaultRuleSuggestionsMessage(count: number): string {
	return count === 1
		? "Apply a rules review suggestion"
		: `Apply ${count} rules review suggestions`;
}

/**
 * The server's base (the version the rules were read from) in the editor's
 * change-base shape, or null when it named none.
 */
export function ruleEditChangeBase(
	base:
		| { nativeBase: { generation: number; commitSha: string } }
		| { baseSnapshotId: string }
		| null
		| undefined,
): InstructionChangeBase | null {
	if (!base) {
		return null;
	}
	return "nativeBase" in base
		? { nativeBase: base.nativeBase }
		: { baseSnapshotId: base.baseSnapshotId };
}
