/**
 * The AI failure analysis — the half of failure handling that was missing.
 *
 * What shipped first was failure *reporting*: the RCA path carries the assertion
 * CI printed into a bug body from a fixed template. Useful, and not what the card
 * asks for. This is the model call that reads that assertion plus the failure's
 * recurrence history and proposes a **cause**.
 *
 * **Advisory, never an actuator.** The result is written onto the finding so a
 * human triaging it starts from a hypothesis instead of a stack trace. It files
 * nothing, closes nothing and promotes nothing — that was the product ruling on
 * 2026-07-26 and it is the reason `suspectedKind` exists at all: a coarse guess
 * is a fine thing to show a person and a terrible thing to act on unattended.
 *
 * This module is the model half. Persisting the result, the permission gate and
 * the audit entry live in the procedure.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import {
	FAILURE_MESSAGE_LIMIT,
	getBoundPromptForAgent,
	type TestFailureKind,
	// The generated enum is a value as well as a type; aliased so the type name
	// can be re-exported below without colliding with it.
	TestFailureKind as TestFailureKindEnum,
} from "@repo/database";
import { zodSchema } from "ai";
import { z } from "zod";

/** Agent key + document type for the (org-editable) failure-analysis prompt. */
const FAILURE_ANALYSIS_PROMPT_AGENT = "test_failure_analyst";
const FAILURE_ANALYSIS_PROMPT_DOCUMENT_TYPE = "GENERAL";

/**
 * How much of CI's output the model sees.
 *
 * Re-exported from the RCA path rather than re-declared: a reader comparing the
 * bug body to the analysis must be looking at the same evidence, and two 1500s
 * kept in step by a comment is a promise nothing enforces.
 */
export const ANALYSIS_FAILURE_MESSAGE_LIMIT = FAILURE_MESSAGE_LIMIT;

/**
 * The closed set, taken from the DATABASE enum rather than restated here.
 *
 * A hand-written copy compiles cleanly while it happens to agree, so a value
 * added to the schema would not surface until a model returned it and this
 * silently normalised it to UNKNOWN — the failure mode being loudly guarded
 * against everywhere else in this file.
 */
export const TEST_FAILURE_KINDS = Object.values(TestFailureKindEnum);

export type { TestFailureKind };

/**
 * Lenient by design: `kind` is a plain string, not a `z.enum`.
 *
 * A strict enum turns "Product Bug" or "product_bug" into a schema-rejection
 * retry loop and, on a model that keeps missing, an outright failure — for a
 * field whose whole job is advisory. Normalised in {@link normaliseKind} below,
 * where an unrecognised value becomes UNKNOWN, which is a real answer.
 */
const FailureAnalysisGenerationSchema = z.object({
	suspectedCause: z.string().optional(),
	kind: z.string().optional(),
});

export interface FailureAnalysisInput {
	testName: string;
	classname?: string | null;
	failureMessage?: string | null;
	/** How many runs this same fingerprint has failed in. */
	occurrences: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
	/** The Fabric case the linkage cascade matched, when it resolved one. */
	caseTitle?: string | null;
	/**
	 * What changed between the last run where this test passed and the run where
	 * it failed, already ranked by how plausibly each file relates to it (spec
	 * §7.2).
	 *
	 * Absent for a finding with no resolvable commit range — a provider that
	 * sends no commit, or a test that has never passed. The evidence block says
	 * so explicitly rather than omitting the section, because a model shown
	 * nothing infers nothing, while a model told the diff is unavailable has the
	 * one fact it needs to stop short of blaming a change it cannot see.
	 */
	changedFiles?: Array<{ path: string; reason: string }>;
	/** Set when a range was resolved, for the model to cite. */
	commitRange?: { baseSha: string; headSha: string } | null;
	/** The compare was capped by the provider, so the list is incomplete. */
	changedFilesTruncated?: boolean;
}

export interface FailureAnalysis {
	suspectedCause: string;
	kind: TestFailureKind;
	/** Provenance: this is a guess shown beside facts, so name its author. */
	model: string | null;
}

/**
 * Map whatever the model said onto the closed set, case- and separator-
 * insensitively. Anything unrecognised is UNKNOWN rather than a throw: a
 * mis-spelled kind must not cost the reader an otherwise good cause paragraph.
 */
export function normaliseKind(raw: string | undefined): TestFailureKind {
	const key = (raw ?? "")
		.trim()
		.toUpperCase()
		.replace(/[\s-]+/g, "_");
	return (TEST_FAILURE_KINDS as readonly string[]).includes(key)
		? (key as TestFailureKind)
		: "UNKNOWN";
}

function truncate(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length <= limit
		? trimmed
		: `${trimmed.slice(0, limit)}\n… truncated; the full output is on the run.`;
}

/**
 * How long this failure has been going on, in the terms the prompt asks the
 * model to reason about.
 *
 * Days are computed from the two timestamps rather than from the clock so the
 * same finding analysed twice describes the same history, and so this stays
 * testable without freezing time.
 */
export function describeRecurrence(input: {
	occurrences: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
}): string {
	const spanMs = input.lastSeenAt.getTime() - input.firstSeenAt.getTime();
	const days = Math.max(0, Math.floor(spanMs / 86_400_000));
	const seen =
		input.occurrences === 1
			? "Seen once."
			: `Seen ${input.occurrences} times.`;
	if (days === 0) {
		return `${seen} First and last seen the same day.`;
	}
	return `${seen} First seen ${days} day${days === 1 ? "" : "s"} before the most recent occurrence.`;
}

/** The evidence block appended below the org's instructions. */
export function buildFailureEvidence(input: FailureAnalysisInput): string {
	const message = input.failureMessage?.trim();
	return [
		"FAILING TEST:",
		`Name: ${input.testName}`,
		input.classname ? `Class/suite: ${input.classname}` : null,
		input.caseTitle ? `Linked Fabric test case: ${input.caseTitle}` : null,
		"",
		"RECURRENCE:",
		describeRecurrence(input),
		"",
		"WHAT CI REPORTED:",
		// Said explicitly rather than left as an empty section. A model shown a
		// blank block infers nothing; a model told the output is missing has the
		// one fact it needs to answer UNKNOWN, which is the right answer here.
		message
			? truncate(message, ANALYSIS_FAILURE_MESSAGE_LIMIT)
			: "(The runner reported no failure output for this test.)",
		"",
		...buildDiffSection(input),
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

/**
 * What changed since this test last passed.
 *
 * Stated as an explicit "not available" when there is no range, for the same
 * reason the failure-output block is: a model shown a blank section infers
 * nothing, while a model told the diff is unavailable knows not to blame a
 * change it cannot see. That distinction is the whole point of §7.2 — a
 * proposed cause must not read as diff correlation.
 */
function buildDiffSection(input: FailureAnalysisInput): string[] {
	if (!input.commitRange || !input.changedFiles?.length) {
		return [
			"WHAT CHANGED SINCE IT LAST PASSED:",
			"(Not available. Do not attribute this failure to a code change — you cannot see one.)",
		];
	}
	return [
		"WHAT CHANGED SINCE IT LAST PASSED:",
		`Comparing ${input.commitRange.baseSha.slice(0, 8)}..${input.commitRange.headSha.slice(0, 8)} — the last run where this test passed, and the run where it failed.`,
		// Ranked, not exhaustive. The ranking is what makes this evidence rather
		// than a changelog, so the model is told the order means something.
		"Files most plausibly related to this test, most relevant first:",
		...input.changedFiles.map((file) => `- ${file.path} (${file.reason})`),
		input.changedFilesTruncated
			? "(The provider capped this comparison, so other files changed too.)"
			: null,
	].filter((line): line is string => line !== null);
}

/**
 * Resolve the org-editable instructions. Falls back to nothing rather than to an
 * inlined copy: an unseeded environment should surface as "analysis unavailable"
 * at the caller, not quietly run a prompt no admin can see or edit.
 */
async function resolveFailureAnalysisInstructions(tenant: {
	userId: string;
	organizationId?: string | null;
}): Promise<string | null> {
	const bound = await getBoundPromptForAgent({
		agentName: FAILURE_ANALYSIS_PROMPT_AGENT,
		documentType: FAILURE_ANALYSIS_PROMPT_DOCUMENT_TYPE,
		storyKind: null,
		userId: tenant.userId,
		organizationId: tenant.organizationId ?? undefined,
	});
	const content = bound?.version?.content?.trim();
	return content && content.length > 0 ? content : null;
}

/**
 * Propose a cause for one failing test. Returns null when the prompt is not
 * seeded — the caller turns that into a refusal the user can act on rather than
 * an analysis from an invisible prompt.
 */
export async function analyseTestFailure(input: {
	failure: FailureAnalysisInput;
	tenant: { userId: string; organizationId?: string | null };
}): Promise<FailureAnalysis | null> {
	const instructions = await resolveFailureAnalysisInstructions(input.tenant);
	if (!instructions) {
		return null;
	}

	const { model, metadata } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: input.tenant.userId,
			organizationId: input.tenant.organizationId ?? undefined,
		},
	);

	const { object } = await generateObject({
		model,
		schema: zodSchema(FailureAnalysisGenerationSchema),
		prompt: `${instructions}\n\n${buildFailureEvidence(input.failure)}`,
		maxOutputTokens: 2_000,
	});

	const suspectedCause = object.suspectedCause?.trim() ?? "";
	return {
		// An empty cause with a confident kind is worse than no analysis: the
		// badge would imply a judgement with nothing behind it. Fall back to
		// UNKNOWN so the two halves cannot disagree.
		suspectedCause,
		kind: suspectedCause ? normaliseKind(object.kind) : "UNKNOWN",
		// `canonicalName` is the display name, which is what a reader wants beside
		// a hypothesis; `modelString` is the provider-specific id and means
		// nothing to them.
		model: metadata?.canonicalName ?? metadata?.modelString ?? null,
	};
}
