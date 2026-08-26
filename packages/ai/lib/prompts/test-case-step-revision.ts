/**
 * Re-drafting ONE existing test case against a feature that has since changed.
 *
 * The distinction from {@link draftTestCases} is the whole point. Drafting reads
 * a feature and invents cases; this reads a feature AND a case that already
 * exists, and proposes what that case's steps should say now. Re-drafting
 * instead would produce a near-duplicate beside the original — the trap the spec
 * names as blocking the update path, since a human then reconciles two cases
 * that differ by a word.
 *
 * The result is a PROPOSAL. It is written to `TestCase.proposedSteps` and waits
 * for a person, on the same principle as PROPOSED cases: an AI may propose a
 * change to the suite, never make one. A suite that edits itself is not a
 * control.
 */

import { getBoundPromptForAgent } from "@repo/database";
import { logger } from "@repo/logs";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import { generateObject, NoObjectGeneratedError, zodSchema } from "ai";
import { z } from "zod";
import {
	AIProviderNotConfiguredError,
	getAIModelWithMetadata,
} from "../dynamic-model-selector";
import { logModelUsageAsync } from "../usage-logging";

/**
 * Lenient by the same rule as the drafting schema: strings only, no `z.enum`,
 * nothing optional-with-a-default. A gateway that rejects an unsupported schema
 * construct fails the whole call, and a model that returns "Click Pay " instead
 * of an enum member should not cost a generation.
 */
export const ReviseTestCaseStepsSchema = z.object({
	steps: z.array(
		z.object({
			action: z.string(),
			expected: z.string(),
		}),
	),
	/** One line a reviewer reads before accepting. Not stored — shown, then gone. */
	rationale: z.string(),
});

/** Bound before any pattern runs over it — model output, of unknown length. */
const MAX_SALVAGED_COMPLETION = 20_000;

/** ```json … ``` — the container wrong one level further out than usual. */
const FENCED_COMPLETION = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/**
 * Read `steps` however the model shaped it.
 *
 * The container varies more than the content does: a lone object where an array
 * belongs, or a plain string per step with the expectation folded into the
 * sentence. Both carry a usable action, and an action with no stated expectation
 * is already tolerated below — a reviewer reads it and fills the gap, which
 * beats a 500 that discards the whole revision.
 */
function readSteps(
	value: unknown,
): Array<{ action: string; expected: string }> {
	return (Array.isArray(value) ? value : [value])
		.map((step) =>
			typeof step === "string"
				? { action: step.trim(), expected: "" }
				: {
						action: String(
							(step as Record<string, unknown>)?.action ?? "",
						).trim(),
						expected: String(
							(step as Record<string, unknown>)?.expected ?? "",
						).trim(),
					},
		)
		.filter((step) => step.action.length > 0);
}

/**
 * Recover a revision from a completion the structured-output schema rejected.
 *
 * The model sometimes returns `steps` as markup inside a string rather than as
 * an array: the content is right and the container is wrong. Rethrowing turns
 * that into an opaque "Internal server error" for the person who pressed the
 * button, and the answer it discards can be a correct one — observed on staging,
 * where the model had correctly worked out that a fix inverted the case's
 * expected outcome and the user got a 500 instead.
 *
 * Only the positive branch reaches this. A diff with nothing to revise returns
 * an empty array, which validates, so every run with nothing to say looked fine.
 * The sibling drafting prompt already salvages this way; this one did not.
 */
export function salvageRevisedSteps(raw: string | undefined): {
	steps: Array<{ action: string; expected: string }>;
	rationale: string;
} | null {
	if (!raw) {
		return null;
	}
	const clipped = raw.slice(0, MAX_SALVAGED_COMPLETION);
	const bounded = FENCED_COMPLETION.exec(clipped)?.[1] ?? clipped;
	let parsed: unknown = bounded;
	try {
		parsed = JSON.parse(bounded);
	} catch {
		// Not JSON — the tag scan below still reads a bare completion.
	}
	// A top-level array is the wrapper omitted, not a different answer.
	const record: Record<string, unknown> = Array.isArray(parsed)
		? { steps: parsed }
		: parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	const rationale = String(record.rationale ?? "").trim();

	// A string `steps` is the markup case, which only the tag scan can read.
	const usable =
		typeof record.steps === "string" ? [] : readSteps(record.steps);
	if (usable.length > 0) {
		return { steps: usable, rationale };
	}

	// The observed deviation: `<step><action>…</action><expected>…</expected></step>`
	// carried in a string. Negated classes rather than `.*?`, so a malformed
	// completion cannot backtrack quadratically.
	const source = typeof record.steps === "string" ? record.steps : bounded;
	const steps: Array<{ action: string; expected: string }> = [];
	const block = /<step>([\s\S]*?)<\/step>/g;
	let m: RegExpExecArray | null = block.exec(source);
	while (m !== null) {
		const chunk = m[1];
		const action =
			/<action>([^<]*)<\/action>/.exec(chunk)?.[1]?.trim() ?? "";
		const expected =
			/<expected>([^<]*)<\/expected>/.exec(chunk)?.[1]?.trim() ?? "";
		if (action) {
			steps.push({ action, expected });
		}
		m = block.exec(source);
	}
	if (steps.length === 0) {
		return null;
	}
	return { steps, rationale };
}

export interface ReviseTestCaseStepsInput {
	featureTitle: string;
	featureDescription?: string | null;
	acceptanceCriteria: string;
	caseTitle: string;
	/** The criterion this case was drafted to validate, when the link records one. */
	/** Every criterion the case claims to cover; empty means none recorded. */
	acceptanceCriterionRefs?: string[] | null;
	currentSteps: Array<{ action: string; expected: string }>;
}

export interface ReviseTestCaseStepsContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
}

export interface RevisedTestCaseSteps {
	steps: Array<{ action: string; expected: string }>;
	rationale: string;
}

/**
 * In-memory body used when the Prompt Library binding has not been seeded.
 * MUST stay in sync with the `test_case_step_reviser` seed entry — the seed is
 * insert-only, so an environment that predates the key runs on this.
 */
export const TEST_CASE_STEP_REVISER_PROMPT_FALLBACK_BODY = `You are a senior QA engineer updating ONE existing test case whose feature has changed.

Feature title:
{{{featureTitle}}}

Feature description:
{{{featureDescription}}}

Acceptance criteria (as they stand NOW):
{{{acceptanceCriteria}}}

The test case to update:
Title: {{{caseTitle}}}
Validates criterion: {{{acceptanceCriterionRef}}}

Its current steps:
{{{currentSteps}}}

Rewrite the steps so they verify the acceptance criteria as they stand now.

Rules:
- Keep every step that is still correct, worded as it is. A diff a reviewer cannot scan is a diff they will accept blindly.
- Change only what the feature's change requires. You are revising a case, not rewriting the suite.
- Each step is one concrete action and the one observable result that proves it. "Verify it works" is not an expected result; "the receipt shows the discounted total" is.
- If the feature no longer has anything this case could verify, return an empty steps array and say so in the rationale. Proposing invented coverage is worse than proposing none.

Also return a one-sentence rationale naming what changed and why the steps changed with it. A reviewer reads that line to decide whether to accept.`;

/**
 * In-memory body for revising against the IMPLEMENTATION rather than the spec.
 * MUST stay in sync with the `test_case_implementation_reviser` seed entry —
 * the seed is insert-only, so an environment that predates the key runs on this.
 *
 * The instruction that carries the weight is "the diff is the ground truth".
 * Given both a diff and a case, a model's habit is to average them into
 * something that offends neither, and an averaged test case verifies nothing.
 * The acceptance criteria are deliberately absent from this prompt: including
 * them re-opens the question this path exists to answer, which is what the code
 * does — not what it was supposed to do.
 */
export const TEST_CASE_IMPLEMENTATION_REVISER_PROMPT_FALLBACK_BODY = `You are a senior QA engineer updating ONE existing test case to match the code that was actually written.

Feature title:
{{{featureTitle}}}

The test case to update:
Title: {{{caseTitle}}}

Its current steps:
{{{currentSteps}}}

The diff of the pull request that implemented this feature:
{{{diff}}}

Rewrite the steps so they verify the behaviour this diff actually implements.

Rules:
- The diff is the ground truth. Where the case and the diff disagree, the diff is right and the case is out of date. Do not split the difference — a step that half-matches the code verifies nothing.
- Only claim what the diff shows. If it renames a button, change the step that names that button. Do not invent coverage for behaviour you cannot see in it, and do not restate a step the diff does not touch.
- Keep every step the diff leaves alone, worded exactly as it is. A diff a reviewer cannot scan is a diff they will accept blindly.
- Each step is one concrete action and the one observable result that proves it. "Verify it works" is not an expected result; "the receipt shows the discounted total" is.
- The diff may be truncated, and it may contain changes unrelated to this case. Revise only what it gives you grounds to revise.
- If the diff shows nothing this case could verify, return an empty steps array and say so in the rationale. Proposing invented coverage is worse than proposing none.

Also return a one-sentence rationale naming what the implementation does differently and which steps changed because of it. A reviewer reads that line to decide whether to accept.`;

/** Bounded so one revision cannot bill an unbounded completion. */
const REVISION_MAX_OUTPUT_TOKENS = 4096;

function formatSteps(steps: Array<{ action: string; expected: string }>) {
	if (steps.length === 0) {
		return "(this case has no steps)";
	}
	return steps
		.map((s, i) => `${i + 1}. ${s.action}\n   Expected: ${s.expected}`)
		.join("\n");
}

/**
 * The half both revision paths share: resolve a model, render the bound prompt,
 * ask for a structured proposal, log what it cost, and coerce the result.
 *
 * The two callers differ only in which prompt they resolve and what they put in
 * front of the model — spec text for one, a pull-request diff for the other.
 * Everything below that is one code path on purpose: the coercion that drops a
 * blank step and the null-on-no-provider contract are behaviours a reviewer
 * should only have to check once.
 */
async function generateStepProposal(params: {
	agentName: string;
	fallbackBody: string;
	variables: Record<string, string>;
	context: ReviseTestCaseStepsContext;
	/** Prefixes the warn line, so a failure names the path that produced it. */
	logLabel: string;
}): Promise<RevisedTestCaseSteps | null> {
	const { context } = params;
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: context.userId,
				organizationId: context.organizationId,
				// Both callers supply the project scope; dropping it here files
				// the spend under no project rather than losing it, so the
				// project's Usage tab under-reports what QA actually costs.
				projectId: context.projectId,
			},
		);

		const boundPrompt = await getBoundPromptForAgent({
			agentName: params.agentName,
			documentType: "GENERAL",
			storyKind: null,
			userId: context.userId,
			organizationId: context.organizationId,
		});
		const rendered = await renderTemplate({
			format:
				(boundPrompt?.format as TemplateFormat | undefined) ??
				"HANDLEBARS",
			template: boundPrompt?.version?.content ?? params.fallbackBody,
			variables: params.variables,
		});
		if (rendered.error) {
			logger.warn(
				`${params.logLabel} prompt render failed; using raw body`,
				{ error: rendered.error },
			);
		}

		const start = Date.now();
		const { object, usage } = await generateObject({
			model,
			schema: zodSchema(ReviseTestCaseStepsSchema),
			prompt: rendered.rendered,
			maxOutputTokens: REVISION_MAX_OUTPUT_TOKENS,
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
			latencyMs: Date.now() - start,
			projectId: context.projectId,
		});

		// Coerced field by field, not cast: the lenient schema admits a malformed
		// row, and a blank step must be dropped here rather than surface as an
		// empty line a reviewer accepts without noticing.
		const steps = (object.steps ?? [])
			.map((s) => ({
				action: String(s?.action ?? "").trim(),
				expected: String(s?.expected ?? "").trim(),
			}))
			.filter((s) => s.action.length > 0);

		return { steps, rationale: String(object.rationale ?? "").trim() };
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			return null;
		}
		// A completion the schema rejected is not automatically a lost one: the
		// model returns the right content in the wrong container often enough
		// that rethrowing shows an internal error while a usable revision sits
		// in the response.
		if (NoObjectGeneratedError.isInstance(error)) {
			const salvaged = salvageRevisedSteps(error.text);
			if (salvaged) {
				logger.info(
					`${params.logLabel} recovered a revision from the rejected completion`,
					{ steps: salvaged.steps.length },
				);
				return salvaged;
			}
		}
		logger.warn(`${params.logLabel} generation failed`, error);
		throw error;
	}
}

/**
 * Propose revised steps for one case, checked against the feature's spec.
 *
 * Returns `null` when no AI provider is configured — an advisory non-error the
 * caller renders as a hint. Every other failure throws, because collapsing a
 * billing or rate-limit failure into "no provider" mislabels something the user
 * can actually act on.
 */
export async function reviseTestCaseSteps(
	input: ReviseTestCaseStepsInput,
	context: ReviseTestCaseStepsContext,
): Promise<RevisedTestCaseSteps | null> {
	return generateStepProposal({
		agentName: "test_case_step_reviser",
		fallbackBody: TEST_CASE_STEP_REVISER_PROMPT_FALLBACK_BODY,
		logLabel: "[test-case-step-revision]",
		context,
		variables: {
			featureTitle: input.featureTitle,
			featureDescription: input.featureDescription || "(no description)",
			acceptanceCriteria: input.acceptanceCriteria,
			caseTitle: input.caseTitle,
			// Joined for the prompt: the model reads one sentence, and a case
			// proving three criteria should say so rather than name whichever
			// happened to be first.
			acceptanceCriterionRef:
				input.acceptanceCriterionRefs
					?.map((r) => r.trim())
					.filter(Boolean)
					.join(", ") || "(not recorded)",
			currentSteps: formatSteps(input.currentSteps),
		},
	});
}

export interface ReviseFromImplementationInput {
	featureTitle: string;
	caseTitle: string;
	currentSteps: Array<{ action: string; expected: string }>;
	/** The pull request's unified diff. May be truncated by the caller. */
	diff: string;
}

/**
 * Propose revised steps for one case, checked against the code that shipped.
 *
 * The same proposal machinery as {@link reviseTestCaseSteps} pointed at a
 * different ground truth. Kept as a separate entry point rather than a flag
 * because the two answer different questions and a caller should have to say
 * which one it is asking — the answer decides whether accepting the result may
 * clear the case's spec-drift flag.
 */
export async function reviseTestCaseStepsFromImplementation(
	input: ReviseFromImplementationInput,
	context: ReviseTestCaseStepsContext,
): Promise<RevisedTestCaseSteps | null> {
	return generateStepProposal({
		agentName: "test_case_implementation_reviser",
		fallbackBody: TEST_CASE_IMPLEMENTATION_REVISER_PROMPT_FALLBACK_BODY,
		logLabel: "[test-case-implementation-revision]",
		context,
		variables: {
			featureTitle: input.featureTitle,
			caseTitle: input.caseTitle,
			currentSteps: formatSteps(input.currentSteps),
			diff: input.diff,
		},
	});
}
