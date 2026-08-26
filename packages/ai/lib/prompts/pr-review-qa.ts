import { getBoundPromptForAgent } from "@repo/database";
import { logger } from "@repo/logs";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import {
	criterionIndexFromRef,
	parseAcceptanceCriteria,
} from "@repo/utils/acceptance-criteria";
import { generateObject, type LanguageModel, zodSchema } from "ai";
import { z } from "zod";
import {
	AIProviderNotConfiguredError,
	getAIModelWithMetadata,
} from "../dynamic-model-selector";
import { logModelUsageAsync } from "../usage-logging";

/**
 * The QA review lens — the QA review lens.
 *
 * Asks one question of a pull request Fabric already read: **which behaviour in
 * this change has no test case covering it?** That question is only worth asking
 * here because Fabric holds the other half of the answer — the project's features,
 * their acceptance criteria, and which cases link to which criterion. A generic
 * reviewer looking at the same diff has none of that and can only guess.
 *
 * Two rules from this codebase shape everything below.
 *
 *  1. **Lenient schema, normalize in code.** The AI gateway rejects `z.enum` and
 *     `z.preprocess`, so every field the model fills is a plain string and the
 *     mapping to real values happens here. Same reason as the test-case drafter.
 *
 *  2. **Ground findings in code, not in prompt wording.** A model told "do not
 *     invent a file path" still invents file paths, and a finding pointing at a
 *     file the change never touched is the fastest way to teach somebody to stop
 *     reading the list. So every finding is checked against the facts we already
 *     hold — the diff's own path list, the feature set we supplied, the criteria
 *     we parsed — and one that fails is dropped or stripped, not politely asked
 *     about. See {@link groundFindings}, which is the load-bearing part of this
 *     file and is tested on its own.
 */

/** Agent key for the (org-editable) QA review prompt. */
export const PR_REVIEW_QA_PROMPT_AGENT = "pr_review_qa";

/**
 * How much diff the model sees. Smaller than the 400 KB Fabric STORES per review:
 * storage exists to show a person what was read, this is what goes in a prompt.
 *
 * Set from MEASUREMENT, not from feel. Across 25 consecutive merged pull requests
 * in this repository the median diff is 16 KB, the largest 182 KB, and none came
 * within half of the 400 KB storage bound — so storage was never the one that bit.
 * The first value here was 60 KB, chosen by guess, and it truncated 6 of those 25
 * (24%). Reviewing a quarter of all pull requests from a fraction of their diff is
 * not the "very large change" case that bound was written for; it is the normal
 * case, silently degraded.
 *
 * 200 KB covers every pull request in that sample at roughly 50k tokens, which is
 * comfortable for any model worth resolving for COMPLEX work. Truncation still
 * exists — a generated-client bump or a lockfile refresh will still exceed it —
 * and `buildPrReviewContext` still tells the model when it is seeing only part of
 * a change, because the failure mode of NOT saying so is the lens reporting the
 * half it cannot see as untested.
 */
export const PR_REVIEW_MODEL_DIFF_BYTES = 200_000;

/**
 * How many features (with their criteria) travel with the diff. Ordered by the
 * caller — uncovered first — so the cap drops the best-covered features rather
 * than an arbitrary slice.
 */
export const PR_REVIEW_MAX_FEATURES = 40;

/**
 * Findings kept from one run. A lens that returns thirty observations has not
 * reviewed anything; it has listed the file tree back. The cap is applied after
 * grounding so it never spends a slot on a finding that was going to be dropped.
 */
export const PR_REVIEW_MAX_FINDINGS = 12;

/**
 * How hard the lens looks, from the project's own `strategyDepth`.
 *
 * The pull-request review work scope: "integrates with QA depth configuration (light projects get
 * lighter QA review)". Mirrors the shape `DEPTH_TEST_TYPES` uses for the test-case
 * drafter, so a project's one depth setting means the same thing in both places —
 * a project that asked for less does not get a maximal PR review.
 *
 * EASY does not merely ask for fewer findings, it narrows WHAT COUNTS: reaching
 * for integration and end-to-end gaps on a two-week spike is the noise a light
 * tier exists to avoid.
 */
const DEPTH_CLAUSE: Record<string, string> = {
	EASY: "QA depth for this project is EASY. Report only gaps in FUNCTIONAL / acceptance-level coverage — the happy path and the key negative case. Do not report missing integration, end-to-end, security, performance or accessibility coverage even where it would obviously add value: a lighter tier is a deliberate choice about scope, not an oversight for you to correct. Report at most 4 findings.",
	AVERAGE:
		"QA depth for this project is AVERAGE. Report gaps in functional, integration and end-to-end coverage. Report a security, performance or accessibility gap only where an acceptance criterion names one.",
	HARD: "QA depth for this project is HARD. Report gaps at every level: functional/acceptance, integration, end-to-end, and also security (auth, tenant isolation, injection, data-leak paths), performance and accessibility where the change touches them.",
};

/** Findings kept at EASY depth — a light tier gets a short list, not a long one. */
const EASY_MAX_FINDINGS = 4;

/**
 * Assemble the prompt: the reviewer's instructions, the project's QA depth, the
 * cap, then the facts.
 *
 * Pulled out as a function so the depth tier is testable without a model call.
 * It needed to be: the clause was computed and then left out of the prompt, so
 * every project got a HARD-shaped review and EASY differed only in how many of
 * the findings survived the cap.
 */
export function composePrReviewPrompt(input: {
	body: string;
	strategyDepth?: string | null;
	facts: string;
	maxFindings?: number;
}): string {
	const depth = (input.strategyDepth ?? "AVERAGE").toUpperCase();
	const clause = DEPTH_CLAUSE[depth] ?? DEPTH_CLAUSE.AVERAGE;
	const cap = input.maxFindings ?? PR_REVIEW_MAX_FINDINGS;
	return `${input.body}\n\n${clause}\n\nReport at most ${cap} findings.\n\n${input.facts}`;
}

/**
 * Room for the schema itself: the object wrapper, the field names repeated per
 * finding, and the closing braces a structured response cannot do without.
 */
const PR_REVIEW_OUTPUT_ENVELOPE_TOKENS = 800;

/**
 * Room for one finding — a title, a paragraph of detail naming what a test
 * would assert, a path and a line. Set generously: the failure this budget
 * prevents is a truncated response, which arrives as a schema error rather than
 * a short list, so erring high costs a little and erring low costs the run.
 */
const PR_REVIEW_OUTPUT_TOKENS_PER_FINDING = 220;

/**
 * The completion budget for a review that may return `count` findings.
 *
 * Exported so a test can assert a full-size response is not truncated by its
 * own budget. This call ran with no budget at all until the repository's own CI
 * review flagged it — an unbounded generation fails as a hang rather than an
 * error, and the plan behind this feature required every model call in the QA
 * path to state one.
 */
export function prReviewMaxOutputTokens(count: number): number {
	const findings = Math.max(1, Math.min(count, PR_REVIEW_MAX_FINDINGS));
	return (
		PR_REVIEW_OUTPUT_ENVELOPE_TOKENS +
		findings * PR_REVIEW_OUTPUT_TOKENS_PER_FINDING
	);
}

/** What the caller supplies about one feature. */
export interface PrReviewFeature {
	storyId: string;
	/** `F-102` / `B-14` — what the model is told to refer to. */
	identifier: string;
	title: string;
	acceptanceCriteria: string | null;
	/** Titles of the live cases linked to this feature. */
	linkedCaseTitles: string[];
}

/** One grounded observation, ready to persist. */
export interface PrReviewQaFinding {
	severity: "HIGH" | "MEDIUM" | "LOW";
	title: string;
	detail: string;
	/**
	 * What to change, kept out of `detail` so a reader can act without parsing
	 * prose. A finding that reaches here has a non-empty one: `groundFindings`
	 * drops the rest, the same way it drops one with no title.
	 */
	recommendation: string;
	filePath: string | null;
	/** Verified against the diff's hunks; null when unclaimed or unverifiable. */
	line: number | null;
	storyId: string | null;
	criterionRef: string | null;
}

/**
 * Strings only — see rule 1 in the module comment. `severity` is described rather
 * than constrained; `groundFindings` maps it.
 */
const PrReviewQaGenerationSchema = z.object({
	findings: z
		.array(
			z.object({
				severity: z
					.string()
					.describe(
						'How much it matters: "high", "medium" or "low". High means untested behaviour a user can reach and that can lose or corrupt data.',
					),
				title: z
					.string()
					.describe(
						"One line naming the untested behaviour. Not a restatement of the file name.",
					),
				detail: z
					.string()
					.describe(
						"What the change does and why the existing cases do not cover it. Do NOT put the fix here — `recommendation` carries that.",
					),
				recommendation: z
					.string()
					.describe(
						"The concrete next step, one or two sentences: the case to add and what it must assert. Never empty — a finding without one is discarded.",
					),
				filePath: z
					.string()
					.describe(
						"A file path FROM THE DIFF this concerns, copied exactly. Empty string when the observation is about the change as a whole.",
					),
				line: z
					.string()
					.describe(
						"The line number shown in the left margin of the diff for the line this concerns, as digits only. Copy it; do not count. Empty string when no single line applies.",
					),
				storyIdentifier: z
					.string()
					.describe(
						'The identifier of the feature this concerns, e.g. "F-102", from the supplied list only. Empty string when none applies.',
					),
				criterionRef: z
					.string()
					.describe(
						'Which acceptance criterion of that feature, as "AC 3". Empty string when the observation is not about a specific criterion.',
					),
			}),
		)
		.describe(
			"Untested behaviour introduced by the change. An EMPTY array is the correct answer when the change is adequately covered.",
		),
});

export const PR_REVIEW_QA_PROMPT_FALLBACK_BODY = `You are a senior QA engineer reviewing a pull request for test coverage, with access to the project's features, their acceptance criteria, and the test cases that already exist.

Your only question: what behaviour does this change introduce or alter that no existing test case covers?

For each gap, produce one finding naming the behaviour and why the listed cases do not cover it, plus a recommendation: the case to add and what it must assert.

Rules:
- Ground every finding in the diff you were given. If you cannot point at a change that causes it, do not report it.
- Keep the diagnosis in \`detail\` and the fix in \`recommendation\`. A finding that describes a gap without proposing a case is discarded, so write both.
- Only refer to a feature by an identifier from the supplied list, and only to a criterion of that feature.
- Judge coverage against the case titles you were given, not against what you assume a well-tested project has.
- Do NOT report code quality, naming, style, architecture, or performance. Another lens owns those, and mixing them in makes this list unreadable.
- Do NOT report a missing test for behaviour the change did not touch. An untested area that this pull request did not go near is not this pull request's finding.
- Returning NO findings is a real and frequently correct answer. A well-covered change should produce an empty list, and padding it makes every future list less believable.`;

/**
 * The file paths a diff actually touches, from its `diff --git` headers.
 *
 * Both sides are collected: a rename or delete means the path a reviewer would
 * name may be the `a/` one. The `b/` side alone silently rejected valid findings
 * about deleted files.
 */
export function diffFilePaths(diff: string): Set<string> {
	const paths = new Set<string>();
	for (const line of diff.split(/\r?\n/)) {
		const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (git) {
			paths.add(git[1]);
			paths.add(git[2]);
			continue;
		}
		const header = line.match(/^(?:\+\+\+|---) [ab]\/(.+)$/);
		if (header) {
			paths.add(header[1]);
		}
	}
	return paths;
}

/**
 * The NEW-file line numbers each path actually gained, read from the diff's hunk
 * headers.
 *
 * The pull-request review work requirement 4 asks each flag to carry the affected file *and line*. A line the
 * model invents is worse than no line — it sends a reader to the wrong place and
 * looks authoritative doing it — so a claimed line is verified against this the
 * same way a claimed path is verified against {@link diffFilePaths}.
 *
 * Only added/context lines in the `+` side are collected: a finding about missing
 * coverage concerns the code that now exists, not the line it replaced.
 */
export function diffAddedLines(diff: string): Map<string, Set<number>> {
	const byPath = new Map<string, Set<number>>();
	let path: string | null = null;
	let lineNo = 0;
	for (const line of diff.split(/\r?\n/)) {
		const header = line.match(/^\+\+\+ b\/(.+)$/);
		if (header) {
			path = header[1];
			if (!byPath.has(path)) {
				byPath.set(path, new Set());
			}
			continue;
		}
		const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			lineNo = Number.parseInt(hunk[1], 10);
			continue;
		}
		if (!path) {
			continue;
		}
		if (line.startsWith("+")) {
			byPath.get(path)?.add(lineNo);
			lineNo++;
		} else if (!line.startsWith("-") && !line.startsWith("\\")) {
			// A context line advances the new-side counter too.
			lineNo++;
		}
	}
	return byPath;
}

function normalizeSeverity(raw: string): "HIGH" | "MEDIUM" | "LOW" {
	const value = raw.trim().toUpperCase();
	if (value.startsWith("H") || value.startsWith("CRIT")) {
		return "HIGH";
	}
	if (value.startsWith("L") || value.startsWith("MINOR")) {
		return "LOW";
	}
	// Anything else — "medium", "moderate", "", a sentence — reads as MEDIUM.
	// Guessing HIGH from an unparseable value would inflate the list.
	return "MEDIUM";
}

/**
 * Drop and strip what the model could not have known.
 *
 * This is where the false-positive rate is actually controlled, and it is
 * deliberately code rather than prompt text. Three checks, each against a fact
 * the caller already holds:
 *
 *  - **A path that is not in the diff drops the finding.** The model asserted a
 *    location and got it wrong; that is not a finding with a bad citation, it is
 *    a finding about a file it never saw. A finding with NO path is kept — an
 *    observation about the change as a whole is legitimate.
 *  - **An unknown feature identifier strips the link**, keeping the finding. The
 *    observation about the diff can stand without a feature attached; silently
 *    binding it to nothing would be worse than leaving it unattached.
 *  - **A criterion ref that does not resolve to a parsed criterion of that
 *    feature is stripped.** "AC 7" on a feature with four criteria points at a
 *    row the traceability matrix does not have.
 *
 * Findings with no title or no detail are dropped: an empty row costs a reader
 * a click to discover it says nothing.
 */
export function groundFindings(input: {
	raw: Array<{
		severity: string;
		title: string;
		detail: string;
		recommendation?: string;
		filePath: string;
		line?: string;
		storyIdentifier: string;
		criterionRef: string;
	}>;
	diff: string;
	features: PrReviewFeature[];
	maxFindings?: number;
}): { findings: PrReviewQaFinding[]; dropped: number } {
	const paths = diffFilePaths(input.diff);
	const addedLines = diffAddedLines(input.diff);
	const byIdentifier = new Map(
		input.features.map((f) => [f.identifier.trim().toUpperCase(), f]),
	);
	const criteriaCount = new Map(
		input.features.map((f) => [
			f.storyId,
			parseAcceptanceCriteria(f.acceptanceCriteria).length,
		]),
	);

	const kept: PrReviewQaFinding[] = [];
	let dropped = 0;

	for (const item of input.raw) {
		const title = item.title?.trim() ?? "";
		const detail = item.detail?.trim() ?? "";
		// A recommendation is required for the same reason a title is: the
		// requirement is that every flag carries one, and the only way to keep that
		// true is to refuse the ones that do not. Dropping is honest where a
		// fallback would not be — synthesising "add a test for this" from the title
		// would satisfy the field and tell the reader nothing.
		const recommendation = item.recommendation?.trim() ?? "";
		if (!title || !detail || !recommendation) {
			dropped++;
			continue;
		}

		const claimedPath = item.filePath?.trim() ?? "";
		if (claimedPath && !paths.has(claimedPath)) {
			dropped++;
			continue;
		}

		const feature = byIdentifier.get(
			(item.storyIdentifier ?? "").trim().toUpperCase(),
		);

		let criterionRef: string | null = null;
		const claimedRef = item.criterionRef?.trim() ?? "";
		if (feature && claimedRef) {
			const index = criterionIndexFromRef(claimedRef);
			const count = criteriaCount.get(feature.storyId) ?? 0;
			if (index !== null && index <= count) {
				criterionRef = claimedRef;
			}
		}

		// A line is kept only when the diff actually added that line of that file.
		// Unverifiable becomes null rather than dropping the finding: the
		// observation can be right about the file and vague about the line.
		let line: number | null = null;
		const claimedLine = Number.parseInt(item.line ?? "", 10);
		if (
			claimedPath &&
			Number.isInteger(claimedLine) &&
			addedLines.get(claimedPath)?.has(claimedLine)
		) {
			line = claimedLine;
		}

		kept.push({
			severity: normalizeSeverity(item.severity ?? ""),
			title,
			detail,
			recommendation,
			filePath: claimedPath || null,
			line,
			storyId: feature?.storyId ?? null,
			criterionRef,
		});
	}

	const cap = input.maxFindings ?? PR_REVIEW_MAX_FINDINGS;
	// Worst first, so the cap sheds the least important rather than the last.
	const ranked = [...kept].sort(
		(a, b) => severityRank(a.severity) - severityRank(b.severity),
	);
	return { findings: ranked.slice(0, cap), dropped };
}

function severityRank(severity: "HIGH" | "MEDIUM" | "LOW"): number {
	switch (severity) {
		case "HIGH":
			return 0;
		case "MEDIUM":
			return 1;
		case "LOW":
			return 2;
		default: {
			const _exhaustive: never = severity;
			return _exhaustive;
		}
	}
}

/** The facts block the prompt is rendered against. */
/**
 * Number the lines of a diff the way the reader will have to cite them.
 *
 * A finding is meant to carry a file AND a line, and `groundFindings` keeps a
 * line only when the diff actually added it — so a model that guesses gets its
 * line stripped and the finding lands with a file alone. It was guessing because
 * a raw unified diff does not say what line anything is on: the hunk header
 * gives a starting offset and the reader has to count.
 *
 * So the counting happens here instead. Added lines carry their NEW-file number,
 * which is exactly the number the grounding check will accept; context lines
 * carry theirs too, because a finding about untested behaviour often points at
 * the line above the change. Removed lines keep their marker and get no number:
 * they are not in the new file, and a number there would be an invitation to
 * cite something that no longer exists.
 */
/** The `@@ -a,b +c,d @@` header, whose `+c` starts the new-file count. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function numberDiffLines(diff: string): string {
	const out: string[] = [];
	let lineNo = 0;
	for (const line of diff.split(/\r?\n/)) {
		const hunk = line.match(HUNK_HEADER);
		if (hunk) {
			lineNo = Number.parseInt(hunk[1], 10);
			out.push(line);
			continue;
		}
		if (
			line.startsWith("+++") ||
			line.startsWith("---") ||
			line.startsWith("diff --git") ||
			line.startsWith("index ")
		) {
			out.push(line);
			continue;
		}
		if (line.startsWith("+")) {
			out.push(`${String(lineNo).padStart(6)} ${line}`);
			lineNo++;
			continue;
		}
		if (line.startsWith("-")) {
			out.push(`${" ".repeat(6)} ${line}`);
			continue;
		}
		// Context line: present in both sides, so it advances the new-file count.
		out.push(`${String(lineNo).padStart(6)} ${line}`);
		lineNo++;
	}
	return out.join("\n");
}

export function buildPrReviewContext(input: {
	diff: string;
	diffTruncated: boolean;
	features: PrReviewFeature[];
}): string {
	// Bounded BEFORE numbering: the cap is about how much the model reads, and
	// numbering a megabyte to throw most of it away is work for nothing.
	const bounded =
		input.diff.length > PR_REVIEW_MODEL_DIFF_BYTES
			? input.diff.slice(0, PR_REVIEW_MODEL_DIFF_BYTES)
			: input.diff;
	const diff = numberDiffLines(bounded);
	// Two ways the model can be looking at part of a change: Fabric bounded the
	// stored diff when it read the PR, or this bounded it again just now. Either
	// way it must be told, or it will report the untouched half as uncovered.
	const partial = input.diffTruncated || bounded.length < input.diff.length;

	const features = input.features
		.slice(0, PR_REVIEW_MAX_FEATURES)
		.map((f) => {
			const criteria = parseAcceptanceCriteria(f.acceptanceCriteria);
			const criteriaBlock =
				criteria.length > 0
					? criteria
							.map((c) => `    AC ${c.index}: ${c.text}`)
							.join("\n")
					: "    (no acceptance criteria recorded)";
			const cases =
				f.linkedCaseTitles.length > 0
					? f.linkedCaseTitles.map((t) => `    - ${t}`).join("\n")
					: "    (no test cases linked to this feature)";
			return `${f.identifier} — ${f.title}\n  Acceptance criteria:\n${criteriaBlock}\n  Existing test cases:\n${cases}`;
		})
		.join("\n\n");

	return [
		partial
			? "NOTE: this is only PART of the change. Do not report anything about code you cannot see here."
			: "This is the complete change.",
		"",
		"=== FEATURES IN THIS PROJECT, THEIR CRITERIA, AND THE CASES THAT COVER THEM ===",
		features || "(no features recorded for this project)",
		"",
		"=== THE CHANGE ===",
		diff,
	].join("\n");
}

/**
 * Run the QA lens over one pull request's diff.
 *
 * Returns `null` only when no AI provider is configured — the same advisory,
 * non-error state the drafter uses, which the caller renders as a soft hint. A
 * genuine generation failure is re-thrown so the caller reports the real reason
 * rather than mislabelling it as "no provider".
 */
export async function reviewPullRequestForQa(input: {
	diff: string;
	diffTruncated: boolean;
	features: PrReviewFeature[];
	/**
	 * The project's `strategyDepth` (EASY | AVERAGE | HARD). Undefined falls through
	 * to AVERAGE, matching the settings default, so a project that never saved the
	 * page gets the same review it did before this existed.
	 */
	strategyDepth?: string | null;
	context: {
		userId: string;
		organizationId?: string | null;
		projectId: string;
	};
}): Promise<{
	findings: PrReviewQaFinding[];
	dropped: number;
	model: string;
} | null> {
	const { context } = input;
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: context.userId,
				organizationId: context.organizationId ?? undefined,
				// The interceptor inside getAIModelWithMetadata is the only
				// usage recorder now (logModelUsageAsync is a documented
				// no-op), so a projectId that stops here is a usage row filed
				// under no project.
				projectId: context.projectId,
			},
		);

		const boundPrompt = await getBoundPromptForAgent({
			agentName: PR_REVIEW_QA_PROMPT_AGENT,
			documentType: "GENERAL",
			storyKind: null,
			userId: context.userId,
			organizationId: context.organizationId ?? undefined,
		});
		const renderFormat: TemplateFormat =
			(boundPrompt?.format as TemplateFormat | undefined) ?? "HANDLEBARS";
		const rendered = await renderTemplate({
			format: renderFormat,
			template:
				boundPrompt?.version?.content ??
				PR_REVIEW_QA_PROMPT_FALLBACK_BODY,
			variables: { maxFindings: PR_REVIEW_MAX_FINDINGS },
		});
		if (rendered.error) {
			logger.warn("[pr-review-qa] prompt render failed; using raw body", {
				error: rendered.error,
			});
		}

		const depth = (input.strategyDepth ?? "AVERAGE").toUpperCase();
		const maxFindings =
			depth === "EASY" ? EASY_MAX_FINDINGS : PR_REVIEW_MAX_FINDINGS;

		const facts = buildPrReviewContext(input);
		const start = Date.now();
		const { object, usage } = await generateObject({
			model: model as LanguageModel,
			schema: zodSchema(PrReviewQaGenerationSchema),
			prompt: composePrReviewPrompt({
				body: rendered.rendered,
				strategyDepth: input.strategyDepth,
				facts,
			}),
			// Sized to the cap the prompt states, not to the depth-narrowed cap
			// below it: the model is asked for up to the full number and the
			// narrowing is applied afterwards, so budgeting for the smaller one
			// would truncate a response we asked for.
			maxOutputTokens: prReviewMaxOutputTokens(PR_REVIEW_MAX_FINDINGS),
		});

		logModelUsageAsync({
			context: {
				userId: context.userId,
				organizationId: context.organizationId ?? undefined,
			},
			metadata,
			taskType: "COMPLEX",
			usage,
			latencyMs: Date.now() - start,
			projectId: context.projectId,
		});
		trackUsage();

		const grounded = groundFindings({
			raw: object.findings ?? [],
			diff: input.diff,
			features: input.features,
			maxFindings,
		});
		if (grounded.dropped > 0) {
			// Logged, not hidden: a run that drops most of what it produced is the
			// signal that the prompt or the model has started drifting, and it is
			// invisible from the finding list alone.
			logger.info("[pr-review-qa] dropped ungrounded findings", {
				dropped: grounded.dropped,
				kept: grounded.findings.length,
				projectId: context.projectId,
			});
		}
		return { ...grounded, model: metadata.canonicalName };
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			return null;
		}
		logger.error("[pr-review-qa] review failed", { error });
		throw error;
	}
}
