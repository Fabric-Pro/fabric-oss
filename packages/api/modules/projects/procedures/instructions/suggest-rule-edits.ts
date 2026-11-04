import { ORPCError } from "@orpc/client";
import { generateText, getAIModelWithMetadata, Output } from "@repo/ai";
import { requireStructuredOutput } from "@repo/ai/lib/structured-output";
import {
	analyzeRules,
	healthRuleFindings,
	isRuleFilePath,
	isSecretFileName,
	knownRuleFindingCategories,
	RULE_FINDING_CATEGORIES,
	type RuleFinding,
	type RuleFindingCategory,
	type RuleSource,
	ruleFindingCategoriesByFile,
	SNAPSHOT_LIMITS,
	scanTextForSecrets,
} from "@repo/instructions";
import { logger } from "@repo/logs";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { MAX_CHANGES } from "./change-set";
import { requireHostingOrganizationId } from "./hosting-organization";
import { boundRuleBlocks, readRules } from "./rules-health";

/**
 * "Apply suggestions" on Rules health: the AI review, turned into concrete
 * file edits the person reviews and then submits through the ordinary
 * instruction change path (`commitChange`, a proposal, or a new version).
 * This procedure only proposes: it never writes, stages or commits anything,
 * so validation, the secret scan, permissions, proposals and audit all stay
 * with the change path the edits are later sent through.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * INSTRUCTION_CREATE, the permission an edit itself needs: a reader is refused
 * before any model call. The organization is the project's own
 * (`requireHostingOrganizationId`), never the caller's.
 *
 * The edits are checked before they are returned: each names a rule file that
 * was read and given to the model (so nothing outside the rules area, and
 * nothing the model was not shown, can be touched), carries no secret by the
 * shared scanner, and keeps a frontmatter block that parses.
 *
 * The edits answer the review the person read, by its findings (shared
 * categories, `@repo/instructions` rule-findings): each edit names the
 * categories it addresses (unknown ones dropped, the file's own findings when
 * none is left), an edit of a file the review did not flag is left out
 * (`not-flagged`), and a flagged file the model left alone is reported
 * (`not-changed`), so every flagged file is either edited or accounted for.
 */

const MAX_REASON_CHARS = 300;
const MAX_FINDINGS = 100;
const MAX_FINDING_FILES = 200;
const MAX_FINDING_SUMMARY_CHARS = 1_000;

const input = z.object({
	projectId: z.string(),
	// Accepted for shape parity with the sibling procedures and ignored: the
	// project supplies the tenant.
	organizationId: z.string().nullable().optional(),
	/**
	 * The review the person read (`reviewRules`), so the edits address the
	 * same findings. Absent, the checks' own findings stand in for it.
	 */
	findings: z
		.array(
			z.object({
				category: z.enum(RULE_FINDING_CATEGORIES),
				files: z.array(z.string().max(1_000)).max(MAX_FINDING_FILES),
				summary: z.string().max(MAX_FINDING_SUMMARY_CHARS),
			}),
		)
		.max(MAX_FINDINGS)
		.optional(),
});

/**
 * What the model answers. Every field is required (nullable where it may be
 * empty) so the schema stays valid for providers' strict structured output.
 */
export const SUGGESTED_EDITS_SCHEMA = z.object({
	edits: z.array(
		z.object({
			path: z.string(),
			action: z.enum(["update", "delete"]),
			content: z.string().nullable(),
			reason: z.string(),
			categories: z.array(z.string()),
		}),
	),
});

export type SuggestedRuleEdit = {
	path: string;
	before: string;
	after: string;
	action: "update" | "delete";
	reason: string;
	/** The review's categories this edit addresses. */
	categories: RuleFindingCategory[];
};

/**
 * Why a suggested edit was left out, or why a file the review flagged has no
 * edit; codes only, never model text. `categories` are the review's findings
 * for the file, empty for a file it did not flag.
 */
export type SkippedRuleEdit = {
	path: string;
	categories: RuleFindingCategory[];
	why:
		| "not-changed"
		| "not-flagged"
		| "unknown-path"
		| "duplicate"
		| "no-content"
		| "unchanged"
		| "too-large"
		| "secret"
		| "frontmatter"
		| "limit";
};

const SUGGEST_PROMPT = `You edit the coding rules an AI coding agent follows in one software project, to fix what a review found. Each rule is a Markdown file, optionally starting with a YAML frontmatter block between --- lines.
Return concrete edits:
- update: give the file's complete new content (frontmatter included), never a fragment or a diff.
- delete: only when its rules move into another file you update in the same answer (a merge), or when it duplicates another file outright. Content is null.
Address the findings listed, in this order: overlap (merge rules that repeat or contradict each other into one file), vague (rewrite them concretely), narrower-scope and over-budget (give a rule that only matters for some files a "paths:" frontmatter list of globs, mark a rule only some tasks need with "load: on-demand", and shorten the always-on core), better-enforced and cleanup.
Edit only files a finding names, by their exact path. Keep every rule's meaning; never invent rules, facts, commands or names that are not in the input. Leave a file out when it needs no change. Give each edit a one-line reason and the categories of the findings it addresses, from: ${RULE_FINDING_CATEGORIES.join(", ")}.`;

const FRONTMATTER_OPEN = /^---\r?\n/;
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FRONTMATTER_KEY = /^[A-Za-z0-9_-]+:(?:\s.*)?$/;

/**
 * Whether a rule's frontmatter is a block the plugin can read: closed, and
 * every top-level line a `key:` (indented lines and list items continue the
 * key above). A file with no frontmatter at all is fine.
 */
export function frontmatterParses(text: string): boolean {
	if (!FRONTMATTER_OPEN.test(text)) {
		return true;
	}
	const match = FRONTMATTER_BLOCK.exec(text);
	if (!match) {
		return false;
	}
	let sawKey = false;
	for (const line of (match[1] ?? "").split(/\r?\n/)) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) {
			continue;
		}
		if (line.startsWith(" ") || line.startsWith("\t")) {
			if (!sawKey) {
				return false;
			}
			continue;
		}
		if (!FRONTMATTER_KEY.test(line)) {
			return false;
		}
		sawKey = true;
	}
	return true;
}

/**
 * The model's answer, reduced to the edits that may be offered. Pure: the
 * rules given to the model are the only paths an edit may name.
 */
export function validateSuggestedEdits(
	raw: z.infer<typeof SUGGESTED_EDITS_SCHEMA>["edits"],
	given: readonly RuleSource[],
	/** The review's findings; absent, every given file may be edited. */
	findings?: readonly RuleFinding[],
): { edits: SuggestedRuleEdit[]; skipped: SkippedRuleEdit[] } {
	const byPath = new Map(given.map((rule) => [rule.path, rule.text]));
	const flagged = findings ? ruleFindingCategoriesByFile(findings) : null;
	const flaggedOf = (path: string) => flagged?.get(path) ?? [];
	const seen = new Set<string>();
	const edits: SuggestedRuleEdit[] = [];
	const skipped: SkippedRuleEdit[] = [];
	const skip = (path: string, why: SkippedRuleEdit["why"]) => {
		skipped.push({ path, categories: flaggedOf(path), why });
	};
	for (const edit of raw) {
		const path = edit.path.trim();
		const before = byPath.get(path);
		if (
			before === undefined ||
			!isRuleFilePath(path) ||
			isSecretFileName(path) !== null
		) {
			skip(path, "unknown-path");
			continue;
		}
		if (seen.has(path)) {
			skip(path, "duplicate");
			continue;
		}
		if (flagged && !flagged.has(path)) {
			skip(path, "not-flagged");
			continue;
		}
		seen.add(path);
		const tagged = knownRuleFindingCategories(edit.categories);
		const categories = tagged.length > 0 ? tagged : flaggedOf(path);
		const reason =
			edit.reason
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, MAX_REASON_CHARS) ||
			(edit.action === "delete"
				? "Remove this file"
				: "Rewrite this file");
		if (edit.action === "delete") {
			if (edits.length >= MAX_CHANGES) {
				skip(path, "limit");
				continue;
			}
			edits.push({
				path,
				before,
				after: "",
				action: "delete",
				reason,
				categories,
			});
			continue;
		}
		const after = edit.content;
		if (after === null || after.trim() === "") {
			skip(path, "no-content");
			continue;
		}
		if (after === before) {
			skip(path, "unchanged");
			continue;
		}
		if (Buffer.byteLength(after, "utf8") > SNAPSHOT_LIMITS.maxFileBytes) {
			skip(path, "too-large");
			continue;
		}
		if (scanTextForSecrets(after, { limit: 1 }).total > 0) {
			skip(path, "secret");
			continue;
		}
		if (!frontmatterParses(after)) {
			skip(path, "frontmatter");
			continue;
		}
		if (edits.length >= MAX_CHANGES) {
			skip(path, "limit");
			continue;
		}
		edits.push({
			path,
			before,
			after,
			action: "update",
			reason,
			categories,
		});
	}
	// A flagged file with neither an edit nor a reason it was left out.
	const accounted = new Set([
		...edits.map((edit) => edit.path),
		...skipped.map((entry) => entry.path),
	]);
	for (const path of flagged?.keys() ?? []) {
		if (!accounted.has(path)) {
			skip(path, "not-changed");
		}
	}
	return { edits, skipped };
}

export const suggestRuleEditsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/rules-review/edits",
		tags: ["Projects", "Instructions"],
		summary:
			"Concrete rule-file edits for the AI rules review, to review and submit as a change",
	})
	.input(input)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const { rules, base } = await readRules(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (rules.length === 0 || base === null) {
			return { base, edits: [], skipped: [] };
		}
		const given = boundRuleBlocks(rules);
		const health = analyzeRules(rules);
		const findings: RuleFinding[] =
			input.findings ?? healthRuleFindings(health.findings);
		const listed = findings
			.map(
				(f) =>
					`- ${f.category}: ${f.summary.replace(/\s+/g, " ").trim()} (${f.files.join(", ")})`,
			)
			.join("\n");
		const prompt = [
			`Always-on budget: ${health.alwaysOnChars} of ${health.budget} characters used.`,
			listed ? `The review found:\n${listed}` : "",
			`Rules (${given.length} of ${rules.length} files):\n\n${given.map((g) => g.block).join("\n\n")}`,
		]
			.filter(Boolean)
			.join("\n\n");
		let raw: z.infer<typeof SUGGESTED_EDITS_SCHEMA>;
		try {
			const { model, trackUsage } = await getAIModelWithMetadata(
				{ taskType: "SIMPLE", complexity: "medium" },
				{
					userId: context.user.id,
					organizationId,
					projectId: input.projectId,
					jobType: "context-summarization",
				},
			);
			const result = await requireStructuredOutput(
				generateText({
					model,
					instructions: SUGGEST_PROMPT,
					prompt,
					output: Output.object({ schema: SUGGESTED_EDITS_SCHEMA }),
				}),
			);
			trackUsage();
			raw = SUGGESTED_EDITS_SCHEMA.parse(result.output);
		} catch (error) {
			logger.warn("[instructions.suggestRuleEdits] model call failed", {
				error: error instanceof Error ? error.name : typeof error,
			});
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"The AI suggestions are unavailable: check the organization's AI provider settings, or try again.",
			});
		}
		const { edits, skipped } = validateSuggestedEdits(
			raw.edits,
			given.map((g) => g.rule),
			// Only a review the person read limits and accounts for the files.
			input.findings,
		);
		return { base, edits, skipped };
	});
