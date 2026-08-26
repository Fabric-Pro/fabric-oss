import { getBoundPromptForAgent } from "@repo/database";
import { logger } from "@repo/logs";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import {
	boundAcceptanceCriteria,
	countAcceptanceCriteria,
} from "@repo/utils/acceptance-criteria";
import {
	isOverridingDepthDefault,
	resolveRequiredTestTypes,
	resolveScepticRoles,
} from "@repo/utils/qa-test-types";
import {
	generateObject,
	type LanguageModel,
	NoObjectGeneratedError,
	zodSchema,
} from "ai";
import { z } from "zod";
import {
	AIProviderNotConfiguredError,
	getAIModelWithMetadata,
} from "../dynamic-model-selector";
import { logModelUsageAsync } from "../usage-logging";

/**
 * "Generate test cases with AI" — the model-agnostic generation primitive
 * behind the `ai-draft-test-cases` procedure (drafts editable cases from a
 * feature's acceptance criteria).
 *
 * Two design rules from this codebase shape the schema:
 *
 *  1. **Lenient `generateObject` schema** — the AI gateway rejects schemas
 *     built with `z.enum` / `z.preprocess` ("Schema type is missing"), so the
 *     model only ever returns plain strings. `priority` is asked of the model
 *     but comes back as free text and is mapped onto the Prisma enum by
 *     `normalizePriority`; `state` / `automationStatus` are not asked at all
 *     and are forced in code. This keeps the structured-output call robust
 *     across providers (Azure OpenAI `json_schema`, OpenAI function calling,
 *     Anthropic tool use, …).
 *  2. **AI output is DRAFT only — never READY/CLOSED.** AI never auto-finalizes
 *     a case; the user edits/promotes. The forced `state: "DRAFT"` in
 *     normalization is the single point that guarantees this invariant.
 */

/**
 * Hard cap on the number of cases a single draft request can yield. Bounds
 * both the prompt instruction and the post-generation normalization so a
 * runaway model response can never persist an unbounded number of cases.
 */
export const MAX_DRAFTED_TEST_CASES = 12;

/**
 * The absolute ceiling a caller may raise the cap to. It exists because "at
 * least one test case per acceptance criterion" is unsatisfiable at 12 for
 * criteria-heavy features. Callers that KNOW the criteria count may request
 * up to this many; everything else stays at {@link MAX_DRAFTED_TEST_CASES}.
 * Spend note: output tokens scale ~linearly with case count, so a 30-case run
 * bills roughly 2.5× the output of a 12-case run.
 */
export const ABSOLUTE_MAX_DRAFTED_TEST_CASES = 30;

/** Input-body truncation caps (token-/cost-awareness — bound the prompt). */
const MAX_TITLE_INPUT_LENGTH = 300;
const MAX_DESCRIPTION_INPUT_LENGTH = 4000;
const MAX_ACCEPTANCE_CRITERIA_INPUT_LENGTH = 4000;
const MAX_OPEN_QUESTIONS_INPUT_LENGTH = 1500;

/**
 * Output-token budget, scaled by the requested case count. A drafted case now
 * carries preconditions, an AC ref, a priority and richer steps, so it costs
 * roughly: title ~12t + preconditions ~60t + acceptanceCriterionRef ~8t +
 * priority ~3t + four steps at ~53t each ~212t + JSON punctuation ~15t ≈ 310t.
 * Rounded up to 400t/case for headroom on verbose models, plus a small envelope
 * for the wrapping object. A full 12-case response therefore gets
 * 200 + 12*400 = 5000 tokens — twice the old flat 2500, which truncated a
 * 12-case response into a schema failure. The floor keeps a 1–2 case request
 * from being starved by the per-case arithmetic alone.
 */
const OUTPUT_TOKENS_PER_CASE = 400;
const OUTPUT_TOKENS_ENVELOPE = 200;
const MIN_OUTPUT_TOKENS = 1200;

/** Bound the raw completion we echo into logs on a schema failure. */
const MAX_LOGGED_COMPLETION_LENGTH = 2000;

/** `TestCaseWorkItemLink.acceptanceCriterionRef` is a short ref ("Covers AC N"). */
const MAX_ACCEPTANCE_CRITERION_REF_LENGTH = 120;

/**
 * Lenient structured-output schema. Strings only — no `z.enum`, no
 * `z.preprocess`, no defaults — so the AI gateway accepts it for every
 * provider. `priority` is a plain string mapped onto the Prisma enum in code;
 * `state` / `automationStatus` are intentionally absent and applied in code.
 */
export const DraftTestCasesSchema = z.object({
	testCases: z
		.array(
			z.object({
				title: z
					.string()
					.describe("Short, action-oriented test case title."),
				preconditions: z
					.string()
					.describe(
						"Starting state, user role, tenant context, and concrete sample data needed to run this case standalone.",
					),
				acceptanceCriterionRef: z
					.string()
					.describe(
						"Short ref for the single acceptance criterion this case validates, e.g. 'AC 3'.",
					),
				priority: z
					.string()
					.describe(
						"Business risk of the behaviour under test: LOW, MEDIUM, HIGH, or CRITICAL.",
					),
				scepticRole: z
					.string()
					.optional()
					.describe(
						"Only when this case exists BECAUSE of an adversarial lens you were asked to apply, name that lens (security, ux, performance, accessibility, edgeCase). Omit for ordinary cases derived directly from the acceptance criteria.",
					),
				dimension: z
					.string()
					.optional()
					.describe(
						"Which QUALITY DIMENSION this case exercises: FUNCTIONAL for ordinary behaviour, SECURITY for auth/tenant-isolation/injection/data-leak, ACCESSIBILITY for keyboard/labels/contrast, PERFORMANCE for latency/N+1/unbounded work. Describe the case you wrote; do not aim for a particular dimension.",
					),
				coverageType: z
					.string()
					.optional()
					.describe(
						"Which level of the test pyramid this case sits at: UNIT for a single unit of logic, INTEGRATION for two or more components together, E2E for a full user-facing flow through the running app, MANUAL for a case only a person can run. Answer for the case you actually wrote.",
					),
				steps: z
					.array(
						z.object({
							action: z
								.string()
								.describe("What the tester does in this step."),
							expected: z
								.string()
								.describe(
									"The expected, observable result of the action.",
								),
						}),
					)
					.describe("Ordered steps, followed from top to bottom."),
			}),
		)
		.describe("The drafted test cases for the feature."),
});

/** The raw shape `generateObject` returns for {@link DraftTestCasesSchema}. */
export type DraftTestCasesObject = z.infer<typeof DraftTestCasesSchema>;

/** A single normalized step ready for persistence (`TestCaseStep`). */
export interface DraftedTestStep {
	action: string;
	expected: string;
}

/**
 * The `TestCasePriority` values a draft may carry. Declared as a const tuple so
 * `normalizePriority` can narrow onto the union by lookup rather than by cast.
 */
const DRAFTED_TEST_CASE_PRIORITIES = [
	"LOW",
	"MEDIUM",
	"HIGH",
	"CRITICAL",
] as const;

export type DraftedTestCasePriority =
	(typeof DRAFTED_TEST_CASE_PRIORITIES)[number];

/**
 * Mirrors the `QaCoverageType` Prisma enum. Declared here rather than imported
 * so this package keeps its zero-dependency stance on `@repo/database` — the
 * same reason `state` and `automationStatus` are string literals below.
 */
export const DRAFTED_TEST_CASE_COVERAGE_TYPES = [
	"UNIT",
	"INTEGRATION",
	"E2E",
	"MANUAL",
] as const;

export type DraftedTestCaseCoverageType =
	(typeof DRAFTED_TEST_CASE_COVERAGE_TYPES)[number];

/**
 * The quality dimension a case exercises, as distinct from its pyramid level.
 *
 * `coverageType` says how far up the stack the case reaches; this says what it
 * is looking FOR. An end-to-end security case and an end-to-end functional case
 * are the same pyramid level and very different work, which is why the tier
 * cares about both independently.
 *
 * Not persisted: it exists so the tier can be checked against the outcome. The
 * pyramid level has a column because the coverage matrix renders it; nobody
 * renders this, and adding a column for a value only the drafter produces would
 * be a schema change with no reader.
 */
export const DRAFTED_TEST_CASE_DIMENSIONS = [
	"FUNCTIONAL",
	"SECURITY",
	"ACCESSIBILITY",
	"PERFORMANCE",
] as const;

export type DraftedTestCaseDimension =
	(typeof DRAFTED_TEST_CASE_DIMENSIONS)[number];

/**
 * A normalized, persistence-ready drafted case. `state` / `automationStatus`
 * are string literals matching the Prisma enum values so the calling procedure
 * can hand them straight to `bulkCreateTestCases`; `priority` is the model's
 * own risk call, mapped onto the enum.
 */
export interface DraftedTestCase {
	title: string;
	/**
	 * The case's preconditions. Persisted into `TestCase.description` — that
	 * column IS the preconditions field (the PM-sync mapper reads it as
	 * `preconditions: detail.description`), so there is no separate column.
	 */
	preconditions: string;
	/** The AC this case validates, for `TestCaseWorkItemLink.acceptanceCriterionRef`. */
	acceptanceCriterionRef: string | null;
	/**
	 * The adversarial lens this case came from, when it came from one at all.
	 * Null for a case derived straight from the acceptance criteria.
	 */
	scepticRole: string | null;
	/**
	 * `PROPOSED` for a sceptic-authored case, `DRAFT` otherwise.
	 *
	 * A case the acceptance criteria imply is one the team has effectively
	 * already asked for. A case an adversarial lens invented is a SUGGESTION, to
	 * be accepted or rejected before it joins the suite — which is also why
	 * PROPOSED does not count as coverage.
	 */
	state: "PROPOSED" | "DRAFT";
	priority: DraftedTestCasePriority;
	automationStatus: "NOT_AUTOMATED";
	/**
	 * Which level of the pyramid the model says this case sits at, or null when
	 * it did not say or said something unrecognised.
	 *
	 * Null is a real answer, not a failure: the coverage matrix renders it as
	 * UNSET and a person can classify it there, which is exactly what happened to
	 * every drafted case before the drafter was asked for this at all.
	 */
	coverageType: DraftedTestCaseCoverageType | null;
	steps: DraftedTestStep[];
}

/** The feature body the draft is generated from. */
export interface DraftTestCasesInput {
	title: string;
	description?: string | null;
	acceptanceCriteria?: string | null;
	/** Soft request for how many cases to draft; clamped to {@link MAX_DRAFTED_TEST_CASES}. */
	maxTestCases?: number;
	/**
	 * The project's QA policy (Settings ▸ Testing), when configured. Rendered
	 * into the prompt so the depth, evidence expectation and adversarial lenses
	 * the project chose actually shape what gets drafted — until this existed
	 * the page stored those choices and nothing read them.
	 */
	qaPolicy?: DraftQaPolicy;
}

/** The slice of the project's QA policy the drafter can act on. */
export interface DraftQaPolicy {
	/** HARD | AVERAGE | EASY — how deep the drafted coverage should go. */
	strategyDepth?: string | null;
	/**
	 * Which kinds of test the project requires. Empty or absent means "follow the
	 * tier", which is what every project did before the setting existed.
	 */
	requiredTestTypes?: string[] | null;
	/** SCREENSHOT_REQUIRED | OPTIONAL | NONE — evidence each case must capture. */
	evidencePolicy?: string | null;
	/** Adversarial persona keys whose lenses should be applied. */
	scepticRoles?: string[] | null;
}

/** Tenant context for model resolution + usage logging (mirrors `enhanceFeatureWithAI`). */
export interface DraftTestCasesContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
}

/**
 * Clamp a requested case count into `[1, ABSOLUTE_MAX_DRAFTED_TEST_CASES]`;
 * an absent request keeps the historical default of
 * {@link MAX_DRAFTED_TEST_CASES}.
 */
function clampMaxTestCases(requested: number | undefined): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return MAX_DRAFTED_TEST_CASES;
	}
	const floored = Math.floor(requested);
	return Math.min(Math.max(1, floored), ABSOLUTE_MAX_DRAFTED_TEST_CASES);
}

/**
 * The acceptance-criteria boundary rule, the parser and the criterion count all
 * live in `@repo/utils/acceptance-criteria` — ONE implementation, shared with the
 * QA traceability matrix in `apps/web`.
 *
 * They used to be two. This file counted criteria to size `maxTestCases` and to
 * define the "AC N" numbering the drafter is told to use; the matrix parsed them
 * to render the rows those refs land on. Both carried a comment saying "keep in
 * lock-step", and `ac-parser-parity.test.ts` existed because they had already
 * drifted once. A differential run over 11,154 generated blobs found them still
 * disagreeing on 2,098 — in BOTH directions — so a shared implementation
 * replaced them rather than a third guard test being added.
 *
 * Re-exported here so `@repo/ai`'s public surface is unchanged for its callers.
 */
export { boundAcceptanceCriteria, countAcceptanceCriteria };

/**
 * The completion budget for `count` cases. Exported so the drafting test can
 * assert a full 12-case response is not truncated by the budget.
 */
export function draftMaxOutputTokens(count: number): number {
	const cases = clampMaxTestCases(count);
	return Math.max(
		MIN_OUTPUT_TOKENS,
		OUTPUT_TOKENS_ENVELOPE + cases * OUTPUT_TOKENS_PER_CASE,
	);
}

/** Trim + hard-truncate a possibly-null body field for inclusion in the prompt. */
function truncateForPrompt(
	value: string | null | undefined,
	maxLength: number,
): string {
	if (!value) {
		return "";
	}
	const trimmed = value.trim();
	return trimmed.length > maxLength
		? `${trimmed.slice(0, maxLength)}...`
		: trimmed;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
/** "Initial Questions" is the placeholder stage's draft list, not a live open question. */
const DRAFT_QUESTION_HEADING_RE = /^initial\s+questions?$/i;

/**
 * Pull the open-questions bullets out of a feature description.
 *
 * Open questions have no column of their own — the feature-drafting prompts
 * emit them as a markdown section inside the body (`## Open Questions`,
 * `## Open Questions (Discovery)`, `## Questions (Prioritized)`,
 * `### Critical & High Outstanding Questions`), and the clean-spec split leaves
 * everything above `## Acceptance Criteria` in `description`. Matching any
 * heading containing "question" mirrors how the maturation extractor finds the
 * same sections.
 *
 * They are lifted out BEFORE `description` is truncated because they sit near
 * the end of the generated body — a full feature body overruns
 * MAX_DESCRIPTION_INPUT_LENGTH long before it reaches them, so the drafter
 * would otherwise never see the constraints it is meant to cover.
 */
export function extractOpenQuestions(
	description: string | null | undefined,
): string {
	if (!description) {
		return "";
	}
	const collected: string[] = [];
	// Heading level of the question section currently being collected; `null`
	// when outside one.
	let sectionLevel: number | null = null;

	for (const line of description.split(/\r?\n/)) {
		const heading = HEADING_RE.exec(line);
		if (!heading) {
			if (sectionLevel !== null && line.trim()) {
				collected.push(line.trim());
			}
			continue;
		}
		const level = heading[1].length;
		const text = heading[2].trim();
		// A sibling or parent heading closes the section; a deeper one is a
		// subheading of it and leaves collection running.
		if (sectionLevel !== null && level <= sectionLevel) {
			sectionLevel = null;
		}
		if (
			sectionLevel === null &&
			/question/i.test(text) &&
			!DRAFT_QUESTION_HEADING_RE.test(text)
		) {
			sectionLevel = level;
		}
	}
	return collected.join("\n");
}

/**
 * In-memory fallback for the `test_case_drafter` SYSTEM prompt — used only when
 * the Prompt Library binding hasn't been seeded yet (mirrors
 * `STORY_TITLE_GENERATOR_PROMPT_FALLBACK_BODY`). Admins customize the live prompt
 * in the Prompt Library; this keeps drafting working on a fresh install.
 *
 * The free-text slots use TRIPLE-stache so a feature body containing `<`, `&`,
 * or quotes is passed through verbatim rather than HTML-escaped into the prompt.
 *
 * Kept byte-identical to the `test_case_drafter` row in `seed-prompts-only.ts`.
 */
export const TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY = `You are a senior QA engineer drafting test cases for a feature in a multi-tenant SaaS product.

Feature title:
{{{featureTitle}}}

Feature description:
{{{featureDescription}}}

Acceptance criteria:
{{{acceptanceCriteria}}}

Open questions and constraints:
{{{openQuestions}}}

Draft up to {{maxTestCases}} concrete, independent test cases that verify the acceptance criteria above. Order them positive paths first, then the negative and edge cases.

Each test case carries:
- title: short and action-oriented, naming the behaviour under test.
- preconditions: the starting state needed to run this case on its own — seeded data with concrete sample values, the signed-in user's role, and the tenant context (personal workspace, or a named organization). Never leave this empty and never write "none".
- acceptanceCriterionRef: the single acceptance criterion or must-have the case validates, as a short ref such as "AC 3". Use the criteria's own numbering or heading text.
- priority: LOW, MEDIUM, HIGH, or CRITICAL, chosen by business risk. CRITICAL or HIGH for core flows, data mutation, permissions and tenant isolation; MEDIUM for ordinary variations; LOW for cosmetic rendering and copy.
- dimension: which quality dimension the case exercises — FUNCTIONAL for ordinary behaviour, SECURITY for auth/tenant-isolation/injection/data-leak, ACCESSIBILITY for keyboard/labels/contrast, PERFORMANCE for latency or unbounded work. Describe the case you wrote.
- coverageType: which level of the test pyramid the case you wrote actually sits at — UNIT for one unit of logic, INTEGRATION for two or more components together, E2E for a full user-facing flow through the running app, MANUAL for a case only a person can carry out. Describe the case you wrote; do not aim for a particular level.
- steps: ordered steps followed top to bottom, each with an "action" (what the tester does) and an "expected" (the observable result).

Coverage requirements:
- Access and tenant isolation: this product isolates data on an exclusive (XOR) tenant model — a record belongs to an organization OR to a user's personal workspace, never both, and a query for one context must never return the other's rows. If the feature persists data, include at least one case proving data created in an organization is not visible from a personal workspace or from a second organization, and at least one case where a user without the required permission is denied. If the acceptance criteria name roles, add a denied-access case for each restricted role.
- Test design: for every stated limit, cover the boundary at it, just below it, and just above it; for free-text input, cover empty, whitespace-only, and one character. Pair each valid equivalence class with its invalid counterpart. When a combination of choices drives different outcomes, enumerate it as a decision table with one case per row. When the feature moves through states, cover each transition explicitly, including transitions that must be rejected.
- Failure paths: for every asynchronous or external operation, include at least one case for that operation failing, timing out, or returning malformed data. Its expected result must commit to what the user sees and to no partial write surviving.
- Cover each open question or constraint listed above with its own case, testing the behaviour the acceptance criteria commit to.

Rules:
- Every expected result must be falsifiable: one committed, checkable outcome a tester can confirm or refute. Never write "if the UI allows", "meaningfully revised", "works as expected", "appropriate", or any other hedge.
- Every case must be distinct: no two cases may share the same acceptance criterion, starting state, and outcome.
- Every case must run standalone from its own preconditions — never depend on another case having run first.
- Return only the structured object — no prose, no markdown.`;

/**
 * Appended to the prompt for the single repair retry. Names the failure and
 * gives the model an escape hatch that fixes the dominant cause — a response
 * cut off mid-object — without another schema change.
 */
const REPAIR_INSTRUCTION =
	"Your previous response could not be parsed into the required structure. Return ONLY a valid JSON object matching the schema exactly, with every field present on every test case. If the response risks being cut short, return fewer test cases rather than an incomplete one.";

/**
 * Render the project's QA policy as prompt-ready English.
 *
 * Kept as prose rather than raw enum values because the template interpolates it
 * straight into instructions — "HARD" tells a model nothing, "cover the happy
 * path, negative paths and edge cases" tells it what to do. Absent policy yields
 * a neutral sentence so the prompt reads the same as it always did.
 */
const DEPTH_GUIDANCE: Record<string, string> = {
	HARD: "Go deep: cover the happy path, every negative path, boundary values and concurrency, plus tenant-isolation cases.",
	AVERAGE:
		"Balanced coverage: the happy path, the main negative paths, and the obvious edge cases.",
	EASY: "Keep it light: the happy path and the most important negative case per criterion.",
};

/**
 * Which TEST TYPES the tier is allowed to produce, as distinct from how
 * thoroughly it explores each one.
 *
 * `DEPTH_GUIDANCE` above says how hard to look; this says where to look at all.
 * The two are genuinely different axes and were previously conflated, which
 * meant Settings ▸ Testing advertised "Unit only" for Easy and "E2E +
 * Integration + Unit" for Hard while every tier in fact drafted the same mix —
 * the depth only ever changed the adjectives. A reader who picked Easy to keep
 * an early-stage project cheap still got security and end-to-end cases.
 *
 * Stated as an explicit inclusion AND an explicit exclusion because a model
 * told only what to cover treats the list as a floor and adds the rest anyway.
 * The exclusion sentence is what makes the lighter tiers actually lighter.
 *
 * ── Why the exclusion defers to the lenses ──────────────────────────────────
 * Sceptic roles are an INDEPENDENT control, and they default to all five on. A
 * flat "do not write security, performance or accessibility cases" therefore
 * contradicted the lens clauses appended a few lines below it — on a default
 * project set to Easy the prompt argued with itself four times, which is worse
 * than either instruction alone. The tier is the baseline; a lens somebody
 * deliberately enabled is an opt-in exception to it, and the wording says so.
 * Order matters: `parts` puts the lenses AFTER this sentence, so "named below"
 * is literally true of the rendered prompt.
 *
 * Kept beside `DEPTH_GUIDANCE` so the tier's full meaning is readable in one
 * place; `STRATEGY_DEPTH_INFO` in the web app mirrors these words for the
 * settings page, and the two must be changed together.
 */
const DEPTH_TEST_TYPES: Record<string, string> = {
	HARD: "Cover every level: functional/acceptance, integration, end-to-end, security (auth, tenant isolation, injection, data-leak paths) and accessibility (keyboard navigation, labels, contrast).",
	AVERAGE:
		"Cover functional/acceptance, integration and end-to-end cases. Beyond those, add a security, performance or accessibility case only where an acceptance criterion names one.",
	EASY: "Write functional/acceptance cases by default: do not reach for integration, end-to-end, security, performance or accessibility cases on your own initiative, even where they would obviously add value — a lighter tier is a deliberate choice, not an oversight to correct.",
};

/** How each required kind is named to the model, in the tier sentences' vocabulary. */
const TEST_TYPE_PHRASES: Record<string, string> = {
	functional: "functional/acceptance",
	integration: "integration",
	e2e: "end-to-end",
	security: "security (auth, tenant isolation, injection, data-leak paths)",
	performance: "performance (slow queries, unbounded lists, first paint)",
	accessibility: "accessibility (keyboard navigation, labels, contrast)",
};

/**
 * The types sentence when a project has stated its own list.
 *
 * Replaces the tier sentence rather than joining it, so the prompt never carries
 * two answers to "which types". A project that has not touched the control never
 * reaches this — it keeps the tier sentence verbatim, which is why adding the
 * setting changed no existing project's output.
 */
function describeRequiredTestTypes(types: readonly string[]): string {
	const named = types.map((t) => TEST_TYPE_PHRASES[t] ?? t);
	const list =
		named.length === 1
			? named[0]
			: `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
	return `This project requires these kinds of test: ${list}. Give each of them at least one case before adding depth anywhere. Do not write cases of other kinds on your own initiative — the list is a deliberate choice, not an oversight to correct.`;
}

const EVIDENCE_GUIDANCE: Record<string, string> = {
	SCREENSHOT_REQUIRED:
		"Each case must end on an observable, screenshotable result.",
	OPTIONAL:
		"Evidence is optional; still state an observable expected result.",
	NONE: "No evidence capture is required.",
};

const SCEPTIC_GUIDANCE: Record<string, string> = {
	security:
		"a security lens (auth, tenant isolation, injection and data-leak paths)",
	ux: "a UX lens (empty and error states, focus order, ambiguous copy)",
	performance:
		"a performance lens (N+1 queries, unbounded lists, slow first paint)",
	accessibility:
		"an accessibility lens (keyboard navigation, labels, contrast, live regions)",
	edgeCase:
		"an edge-case lens (boundary inputs, race conditions, concurrency)",
};

export function describeQaPolicy(policy: DraftQaPolicy | undefined): string {
	if (!policy) {
		return "(no project QA policy configured — use balanced judgement)";
	}
	const parts: string[] = [];
	const depth = policy.strategyDepth
		? DEPTH_GUIDANCE[policy.strategyDepth]
		: undefined;
	if (depth) {
		parts.push(depth);
	}
	// Which types to write, immediately after how thoroughly to write them, so
	// the scope sentence is never separated from the rigour sentence by the
	// evidence and lens clauses below.
	//
	// An explicit list REPLACES the tier sentence instead of joining it: two
	// sentences about which types to write is how a prompt comes to contradict
	// the settings page that produced it.
	const testTypes = isOverridingDepthDefault(
		policy.strategyDepth,
		policy.requiredTestTypes,
	)
		? describeRequiredTestTypes(
				resolveRequiredTestTypes(
					policy.strategyDepth,
					policy.requiredTestTypes,
				),
			)
		: policy.strategyDepth
			? DEPTH_TEST_TYPES[policy.strategyDepth]
			: undefined;
	if (testTypes) {
		parts.push(testTypes);
	}
	const evidence = policy.evidencePolicy
		? EVIDENCE_GUIDANCE[policy.evidencePolicy]
		: undefined;
	if (evidence) {
		parts.push(evidence);
	}
	// Capped HERE as well as at the call site, and deliberately so.
	//
	// The contradiction this prevents is a property of the sentence, not of any
	// caller: a tier that says "no security cases" followed by "apply a security
	// lens" is broken however the roles arrived. Making the invariant structural
	// means a future caller cannot reintroduce it by forgetting. The cap is
	// idempotent, so running it twice costs nothing.
	const applicableRoles = resolveScepticRoles({
		depth: policy.strategyDepth,
		requiredTestTypes: policy.requiredTestTypes,
		scepticRoles: policy.scepticRoles,
		scepticRolesEnabled: true,
	});
	const lenses = applicableRoles
		.map((role) => SCEPTIC_GUIDANCE[role])
		.filter((lens): lens is string => Boolean(lens));
	if (lenses.length > 0) {
		// No longer phrased as an exception to the scope above.
		//
		// It used to be: roles were independent of depth and defaulted to all
		// five on, so a default Light project got "do not write security cases"
		// immediately followed by "apply a security lens" — a contradiction the
		// prompt had to explain away. `resolveScepticRoles` now drops a role
		// whose dimension the project's effective test types exclude, so every
		// lens that reaches this line is already inside the stated scope and
		// needs no exemption.
		parts.push(
			`Additionally apply ${lenses.join(", ")} to the scope above.`,
		);
	}
	return parts.length > 0
		? parts.join(" ")
		: "(no project QA policy configured — use balanced judgement)";
}

/** Build the render variables for the drafting prompt from a feature body. */
function buildTestCaseDraftingVariables(
	input: DraftTestCasesInput,
): Record<string, string> {
	return {
		featureTitle:
			truncateForPrompt(input.title, MAX_TITLE_INPUT_LENGTH) ||
			"(untitled)",
		featureDescription:
			truncateForPrompt(
				input.description,
				MAX_DESCRIPTION_INPUT_LENGTH,
			) || "(no description provided)",
		acceptanceCriteria:
			truncateForPrompt(
				// Bounded at the first sibling section so leaked operational
				// content ("Rollout: TBD") can't skew the AC numbering.
				input.acceptanceCriteria
					? boundAcceptanceCriteria(input.acceptanceCriteria)
					: input.acceptanceCriteria,
				MAX_ACCEPTANCE_CRITERIA_INPUT_LENGTH,
			) || "(no acceptance criteria provided)",
		openQuestions:
			truncateForPrompt(
				extractOpenQuestions(input.description),
				MAX_OPEN_QUESTIONS_INPUT_LENGTH,
			) || "(none recorded)",
		maxTestCases: String(clampMaxTestCases(input.maxTestCases)),
		qaPolicy: describeQaPolicy(input.qaPolicy),
	};
}

/** Narrow an unknown value to a plain (non-array) record, else `null`. */
function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Parse a value that should already be structured but may have arrived as JSON
 * text. Returns `null` when it is neither.
 *
 * Models routinely answer a structured-output request by putting the whole
 * answer in a string — sometimes the entire object, sometimes just the array
 * field. The content is right; only the nesting is wrong. Unwrapping is safe
 * because the result still has to survive normalization.
 */
function parseIfJsonString(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

/**
 * How deep a wrapped response is worth chasing. Two observed levels plus a
 * margin; a bound stops a pathological `{testCases:{testCases:{…}}}` from
 * walking forever.
 */
const MAX_TEST_CASE_UNWRAP_DEPTH = 4;

/**
 * Find the array of raw cases in whatever the model actually returned.
 *
 * The schema asks for `{ testCases: [...] }`, but a rejected completion is
 * usually that exact answer wrapped a level too deep — the whole object as
 * text, or the envelope kept and the payload stringified (both seen live, where
 * the response was `{"testCases": "{\"testCases\": [...]}"}`). Peeling strings
 * and `testCases` envelopes until an array falls out recovers the cases without
 * paying for a second generation. Anything that never yields an array returns
 * empty, and normalization rejects it as before.
 */
function extractTestCaseList(raw: unknown): unknown[] {
	let current = parseIfJsonString(raw);
	for (let depth = 0; depth < MAX_TEST_CASE_UNWRAP_DEPTH; depth++) {
		if (Array.isArray(current)) {
			return current;
		}
		const record = asRecord(current);
		if (!record) {
			return [];
		}
		current = parseIfJsonString(record.testCases);
	}
	return [];
}

/** Coerce an unknown value to a string ("" for any non-string). */
function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Map the model's free-text priority onto the Prisma enum. The schema must stay
 * lenient (no `z.enum`), so the model can return "high", "P1", or prose —
 * anything unrecognized falls back to MEDIUM rather than failing the draft.
 */
/**
 * The adversarial lenses a case may be attributed to.
 *
 * Mirrors `QA_SCEPTIC_ROLES` in `@repo/database`, restated here rather than
 * imported because this package must not depend on the database layer. The
 * drift risk is real but bounded: an unrecognised value is treated as "not
 * sceptic-authored", so the worst case is a proposed case arriving as an
 * ordinary draft — never a case that vanishes.
 */
const SCEPTIC_ROLE_KEYS = new Set([
	"security",
	"ux",
	"performance",
	"accessibility",
	"edgeCase",
]);

/**
 * Which lens produced this case, or null when the model did not attribute it to
 * one.
 *
 * Lenient like every other field here: the model is asked for a key from a small
 * set and its answer is matched case-insensitively, because "Security" and
 * "security" mean the same thing and rejecting one of them would silently
 * downgrade a proposal to a draft.
 */
function normaliseScepticRole(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const key = value.trim();
	if (!key) {
		return null;
	}
	const match = [...SCEPTIC_ROLE_KEYS].find(
		(k) => k.toLowerCase() === key.toLowerCase(),
	);
	return match ?? null;
}

function normalizePriority(value: unknown): DraftedTestCasePriority {
	const candidate = asString(value).trim().toUpperCase();
	return (
		DRAFTED_TEST_CASE_PRIORITIES.find(
			(priority) => priority === candidate,
		) ?? "MEDIUM"
	);
}

/**
 * Map the model's pyramid-level answer onto the enum.
 *
 * Unrecognised and absent both become `null` rather than a guess. A wrong
 * classification is worse than no classification here: `null` renders as UNSET
 * and invites a person to set it, whereas a confident "UNIT" on an end-to-end
 * case quietly corrupts the coverage matrix and the depth check below it.
 */
/** Map the model's dimension answer onto the enum; unknown/absent -> null. */
function normalizeDimension(value: unknown): DraftedTestCaseDimension | null {
	const candidate = asString(value).trim().toUpperCase();
	return DRAFTED_TEST_CASE_DIMENSIONS.find((d) => d === candidate) ?? null;
}

function normalizeCoverageType(
	value: unknown,
): DraftedTestCaseCoverageType | null {
	const candidate = asString(value).trim().toUpperCase();
	return (
		DRAFTED_TEST_CASE_COVERAGE_TYPES.find((type) => type === candidate) ??
		null
	);
}

/**
 * The pyramid levels a tier does not write **on its own initiative**.
 *
 * The mirror of `DEPTH_TEST_TYPES`, expressed as data so the outcome can be
 * checked rather than only requested. Only EASY excludes anything at this level:
 * AVERAGE and HARD both cover the whole pyramid, and what separates them is the
 * security / accessibility dimension, which is not a `coverageType` at all — it
 * arrives as a sceptic lens and is handled as an override below.
 */
const OFF_TIER_COVERAGE_TYPES: Record<
	string,
	readonly DraftedTestCaseCoverageType[]
> = {
	EASY: ["INTEGRATION", "E2E"],
};

/**
 * The quality dimensions a tier does not pursue on its own initiative.
 *
 * This is the half of `DEPTH_TEST_TYPES` that `coverageType` cannot express.
 * EASY and AVERAGE both say "security / accessibility / performance only where a
 * criterion or a lens asks", and until now nothing checked it — a spontaneous
 * security case on a light project was indistinguishable from a functional one.
 *
 * HARD is absent because it asks for every dimension.
 */
const OFF_TIER_DIMENSIONS: Record<string, readonly DraftedTestCaseDimension[]> =
	{
		EASY: ["SECURITY", "ACCESSIBILITY", "PERFORMANCE"],
		AVERAGE: ["SECURITY", "ACCESSIBILITY", "PERFORMANCE"],
	};

/**
 * Whether a drafted case sits outside what its tier asked for.
 *
 * A case attributed to a sceptic lens is never off-tier: enabling that lens is
 * the deliberate exception to the tier, and the prompt says so. Judging it a
 * violation here would contradict the instruction the model was given.
 *
 * An unclassified case (`coverageType: null`) is never off-tier either. The
 * check fails **safe**: an absent answer is not evidence of a violation, and
 * treating it as one would demote ordinary cases whenever a model declined to
 * classify them.
 */
function isOffTier(
	coverageType: DraftedTestCaseCoverageType | null,
	dimension: DraftedTestCaseDimension | null,
	scepticRole: string | null,
	strategyDepth: string | null | undefined,
): boolean {
	// A lens-authored case is never off-tier, and neither is one on a project
	// with no tier configured.
	if (scepticRole || !strategyDepth) {
		return false;
	}
	// Each axis fails SAFE independently: an absent answer is not evidence of a
	// violation, so a model that classifies the level but declines the dimension
	// is still checked on the level.
	const offPyramid =
		coverageType != null &&
		(OFF_TIER_COVERAGE_TYPES[strategyDepth] ?? []).includes(coverageType);
	const offDimension =
		dimension != null &&
		(OFF_TIER_DIMENSIONS[strategyDepth] ?? []).includes(dimension);
	return offPyramid || offDimension;
}

/** Trim + bound the AC ref; absent/blank becomes `null` (the column is nullable). */
function normalizeAcceptanceCriterionRef(value: unknown): string | null {
	const trimmed = asString(value).trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.length > MAX_ACCEPTANCE_CRITERION_REF_LENGTH
		? trimmed.slice(0, MAX_ACCEPTANCE_CRITERION_REF_LENGTH)
		: trimmed;
}

/** Normalize the `steps` of a single raw case: trim, drop fully-empty steps. */
function normalizeSteps(rawSteps: unknown): DraftedTestStep[] {
	if (!Array.isArray(rawSteps)) {
		return [];
	}
	const steps: DraftedTestStep[] = [];
	for (const entry of rawSteps) {
		const record = asRecord(entry);
		if (!record) {
			continue;
		}
		const action = asString(record.action).trim();
		const expected = asString(record.expected).trim();
		// A step with neither an action nor an expected result carries no
		// information — drop it rather than persist an empty row.
		if (!action && !expected) {
			continue;
		}
		steps.push({ action, expected });
	}
	return steps;
}

/**
 * Normalize raw model output into persistence-ready DRAFT cases. Pure +
 * defensive — tolerates omitted/empty/wrong-typed fields (the lenient schema
 * means the model can return surprising shapes) and enforces the invariants:
 *
 *  - drop cases with an empty title;
 *  - drop empty steps, and drop cases left with no steps;
 *  - trim all strings;
 *  - cap the count at `maxCount` (clamped to {@link MAX_DRAFTED_TEST_CASES});
 *  - map the model's free-text `priority` onto the enum (MEDIUM when unusable);
 *  - force `state: "DRAFT"` (AI never finalizes) + `automationStatus:
 *    "NOT_AUTOMATED"`.
 */
export function normalizeDraftedTestCases(
	raw: unknown,
	maxCount: number = MAX_DRAFTED_TEST_CASES,
	/**
	 * The tier the draft was requested at, when there is one. Used only to spot a
	 * case that sits outside it — see `isOffTier`. Omitted (or absent policy)
	 * means no tier check runs at all, which is the behaviour every caller had
	 * before the check existed.
	 */
	strategyDepth?: string | null,
): DraftedTestCase[] {
	const cap = clampMaxTestCases(maxCount);
	const list = extractTestCaseList(raw);

	const normalized: DraftedTestCase[] = [];
	for (const entry of list) {
		if (normalized.length >= cap) {
			break;
		}
		const record = asRecord(entry);
		if (!record) {
			continue;
		}
		const title = asString(record.title).trim();
		if (!title) {
			continue;
		}
		const steps = normalizeSteps(record.steps);
		if (steps.length === 0) {
			continue;
		}
		const scepticRole = normaliseScepticRole(record.scepticRole);
		const coverageType = normalizeCoverageType(record.coverageType);
		// A case the tier did not ask for arrives as a PROPOSAL, not as coverage.
		//
		// The alternatives are both worse. Dropping it discards work the customer's
		// credits already paid for, on the strength of the model's own
		// self-classification. Keeping it as DRAFT lets an end-to-end case join an
		// Easy project's suite and count towards its coverage — which is the exact
		// behaviour the tier exists to prevent.
		//
		// PROPOSED already means "an AI suggested this, a human decides", and is
		// already excluded from coverage totals. So the off-tier case stays
		// visible and reviewable, and simply does not count until somebody says it
		// should. No new state, no new UI, nothing discarded.
		const dimension = normalizeDimension(record.dimension);
		const offTier = isOffTier(
			coverageType,
			dimension,
			scepticRole,
			strategyDepth,
		);
		normalized.push({
			title,
			preconditions: asString(record.preconditions).trim(),
			acceptanceCriterionRef: normalizeAcceptanceCriterionRef(
				record.acceptanceCriterionRef,
			),
			scepticRole,
			// The AI still never FINALISES a case — it may only propose one or
			// draft one. `READY` remains a human's decision either way.
			state: scepticRole || offTier ? "PROPOSED" : "DRAFT",
			priority: normalizePriority(record.priority),
			automationStatus: "NOT_AUTOMATED",
			coverageType,
			steps,
		});
	}
	return normalized;
}

/**
 * Run the structured-output call, retrying ONCE when the model returns
 * something the schema rejects — overwhelmingly a completion cut off mid-object.
 *
 * The retry is scoped to `NoObjectGeneratedError` on purpose: every other
 * failure (billing, rate limit, auth, network) is re-thrown untouched, because
 * re-asking the same provider cannot fix it and would just double the bill and
 * the latency on an already-failing request.
 */
/**
 * A generation recovered from a rejected completion. Mirrors the `generateObject`
 * result the caller reads — the cases are already normalized, so the caller's
 * own normalization pass is a no-op over them.
 */
interface SalvagedGeneration {
	object: { testCases: DraftedTestCase[] };
	usage:
		| NonNullable<Awaited<ReturnType<typeof generateObject>>["usage"]>
		| Record<string, never>;
}

async function generateDraftedTestCasesObject(params: {
	model: LanguageModel;
	prompt: string;
	maxOutputTokens: number;
	/** Tier the draft was requested at, so salvaged cases get the same check. */
	strategyDepth?: string | null;
}) {
	const call = (prompt: string) =>
		generateObject({
			model: params.model,
			schema: zodSchema(DraftTestCasesSchema),
			prompt,
			maxOutputTokens: params.maxOutputTokens,
		});

	/** The rejection to surface when neither attempt yields anything usable. */
	let lastRejection: Error | undefined;

	/**
	 * One attempt, with the rejected completion mined before it is discarded.
	 *
	 * Applied to BOTH attempts on purpose, because the two rejections have
	 * different causes: a truncation (`finishReason: "length"`) leaves nothing
	 * to salvage and genuinely wants a shorter answer, while a schema rejection
	 * is usually the right cases wrapped a level too deep. Observed live in a
	 * single run: attempt 1 truncated to `{}`, and the retry then returned
	 * twelve perfectly good cases inside a string — which a first-attempt-only
	 * salvage discards, having paid for both.
	 *
	 * `null` means "nothing usable here" — the caller decides whether that is
	 * worth another generation.
	 */
	const attempt = async (
		prompt: string,
	): Promise<
		Awaited<ReturnType<typeof call>> | SalvagedGeneration | null
	> => {
		try {
			return await call(prompt);
		} catch (error) {
			if (!NoObjectGeneratedError.isInstance(error)) {
				throw error;
			}
			// The raw completion is the only way to tell a truncation apart from
			// a model that ignored the schema. It is model output — the feature
			// body and the resolved credentials are never in it — but bound it
			// anyway so a runaway response cannot flood the logs.
			logger.warn("[test-case-drafting] structured output rejected", {
				reason: error.message,
				finishReason: error.finishReason,
				rawCompletion: truncateForPrompt(
					error.text,
					MAX_LOGGED_COMPLETION_LENGTH,
				),
			});
			lastRejection = error;

			const salvaged = normalizeDraftedTestCases(
				parseIfJsonString(error.text),
				MAX_DRAFTED_TEST_CASES,
				params.strategyDepth,
			);
			if (salvaged.length === 0) {
				return null;
			}
			logger.info(
				"[test-case-drafting] recovered cases from the rejected completion",
				{ count: salvaged.length },
			);
			// `usage` is absent on some providers' error paths; the tokens are
			// recorded by the global interceptor that wraps the model either
			// way, so an empty tally here loses no accounting.
			return {
				object: { testCases: salvaged },
				usage: error.usage ?? {},
			};
		}
	};

	const first = await attempt(params.prompt);
	if (first) {
		return first;
	}
	const second = await attempt(`${params.prompt}\n\n${REPAIR_INSTRUCTION}`);
	if (second) {
		return second;
	}
	// Both attempts produced nothing usable — surface the provider's own reason.
	throw lastRejection;
}

/**
 * Resolve the project AI provider, generate test cases from a feature body, and
 * return them normalized to DRAFT-only.
 *
 * Returns `null` ONLY when no AI provider is configured — an advisory,
 * non-error state the caller renders as a soft hint (mirrors
 * `enhanceFeatureWithAI`). A genuine generation failure — the configured
 * provider rejecting the call (billing/credits, rate limit, auth), malformed
 * model output that survives the repair retry, or a network error — is logged
 * and RE-THROWN so the caller can surface the true reason, instead of being
 * mislabelled as "no AI provider configured".
 */
export async function draftTestCases(
	feature: DraftTestCasesInput,
	context: DraftTestCasesContext,
): Promise<DraftedTestCase[] | null> {
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: context.userId,
				organizationId: context.organizationId,
				// The usage row is stamped with whatever project scope arrives
				// here, so dropping it does not lose the spend — it files it
				// under no project at all. Drafting then bills the org while
				// the project's Usage tab stays flat, which reads as "the run
				// was free" to anyone checking cost per project.
				projectId: context.projectId,
			},
		);

		const maxTestCases = clampMaxTestCases(feature.maxTestCases);

		// Resolve the admin-customizable `test_case_drafter` SYSTEM prompt (via the
		// Prompt Library binding), falling back to the in-memory body when the seed
		// hasn't run — mirrors `story_title_generator`.
		const boundPrompt = await getBoundPromptForAgent({
			agentName: "test_case_drafter",
			documentType: "GENERAL",
			storyKind: null,
			userId: context.userId,
			organizationId: context.organizationId,
		});
		const renderFormat: TemplateFormat =
			(boundPrompt?.format as TemplateFormat | undefined) ?? "HANDLEBARS";
		const templateBody =
			boundPrompt?.version?.content ??
			TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY;
		const rendered = await renderTemplate({
			format: renderFormat,
			template: templateBody,
			variables: buildTestCaseDraftingVariables({
				...feature,
				maxTestCases,
			}),
		});
		if (rendered.error) {
			logger.warn(
				"[test-case-drafting] prompt render failed; using raw body",
				{ error: rendered.error },
			);
		}

		// Composed code-side (like the locked clauses elsewhere) so it holds
		// regardless of org prompt overrides: breadth of criterion coverage is
		// the contract the traceability matrix renders.
		const coverageClause = `\n\nCoverage requirement: give EVERY acceptance criterion at least one test case before adding depth anywhere — breadth of criterion coverage over multiple cases for one criterion. The case limit (${maxTestCases}) accommodates this.`;

		const generationStart = Date.now();
		const { object, usage } = await generateDraftedTestCasesObject({
			model,
			prompt: rendered.rendered + coverageClause,
			maxOutputTokens: draftMaxOutputTokens(maxTestCases),
			strategyDepth: feature.qaPolicy?.strategyDepth,
		});

		trackUsage();
		logModelUsageAsync({
			context: {
				userId: context.userId,
				organizationId: context.organizationId,
			},
			metadata,
			taskType: "COMPLEX",
			usage,
			latencyMs: Date.now() - generationStart,
			projectId: context.projectId,
		});

		return normalizeDraftedTestCases(
			object,
			maxTestCases,
			feature.qaPolicy?.strategyDepth,
		);
	} catch (error) {
		// "No provider configured" is the ONLY advisory, non-error outcome — the
		// caller renders a soft hint for it. Signal it with `null`.
		if (error instanceof AIProviderNotConfiguredError) {
			return null;
		}
		// Any OTHER failure is a genuine generation error: the configured
		// provider rejected the request (billing/credits, rate limit, auth), the
		// model returned malformed output, or the network failed. Do NOT collapse
		// it into `null` — that mislabels a real, actionable failure as "no AI
		// provider configured". Log it and re-throw so the caller can surface the
		// true reason to the user.
		logger.warn("[test-case-drafting] generation failed", error);
		throw error;
	}
}
