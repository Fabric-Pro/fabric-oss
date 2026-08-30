/**
 * Topic Planning & Analysis — schema, question identity and prompt composition
 * (Fizzy #1851, Phase 2A-2).
 *
 * The pure half of the slice: no DB, no model, no Temporal context, so all of it
 * is unit-testable. Mirrors `meeting-agenda/build-agenda-prompt.ts`, which is
 * this repo's worked example of an editable Prompt Library body carrying a
 * code-side contract an org override cannot drop — including its three render
 * guards, each of which was learned from a real failure rather than imagined.
 *
 * `node:crypto` is imported here deliberately and safely: this is an ACTIVITY
 * module, not a workflow one. Activity bodies are not replayed and do not run in
 * Temporal's V8 sandbox, so a hash is fine — the same reason 1A's `dedupeKey` is
 * computed in `computeSuggestionTopics` rather than in its workflow.
 */

import { createHash } from "node:crypto";
import { logger } from "@repo/logs";
import {
	isEffectivelyBlank,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";
// Defined in @repo/utils, not here, so the seed and this activity share ONE
// definition instead of two copies a test has to keep byte-identical.
// Re-exported because this module is the natural import site for everything
// about the Planning & Analysis prompt.
import {
	PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
	PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
} from "@repo/utils/publishing-planning-prompt";
import { z } from "zod";

export {
	PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
	PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
};

// =============================================================================
// Output schema
// =============================================================================

/**
 * One classified recommendation.
 *
 * `type` is a free string, NOT `PublishingTopicPostType`. FR32's supported set
 * includes Webinar/Demo Script, Video Walkthrough Script and Newsletter Blurb,
 * none of which are in that enum; narrowing this would make the model drop three
 * of its eight legitimate answers. `rationale` is required because DV11/DV12
 * only mean something if the classification says why — an unexplained "requires
 * approval" is not actionable by a writer.
 */
const ClassifiedRecommendationSchema = z.object({
	type: z.string().min(1),
	rationale: z.string().min(1),
});

/**
 * The decision types the PO's prompt enumerates under "Decision Handling".
 *
 * These are the vocabulary a question's IDENTITY is built from. Taking them from
 * the PO's own list rather than inventing a taxonomy means the model is being
 * asked to classify along an axis its instructions already describe.
 *
 * `OTHER` is the escape hatch and the honest one: a free-form question has no
 * stable subject to key on, so its identity falls back to its wording and can
 * drift across a rephrasing. That limitation is real; hiding it behind a
 * plausible-looking enum value would be worse.
 */
export const PUBLISHING_DECISION_KINDS = [
	"CUSTOMER_NAME",
	"ASSET_APPROVAL",
	"INTERNAL_UI",
	"VIDEO_WALKTHROUGH",
	"CONTENT_TYPE",
	"AUTHORSHIP",
	"METRICS_APPROVAL",
	"AUDIENCE_SCOPE",
	"CLAIM_STRENGTH",
	"CODEBASE_DETAIL",
	"OTHER",
] as const;

export type PublishingDecisionKind = (typeof PUBLISHING_DECISION_KINDS)[number];

/**
 * The Planning & Analysis document, one field per section of the PO's prompt
 * "Output Format" (v1.1), in that order.
 *
 * EVERY section is optional, because FR21–FR38 each say "where available". A
 * thin topic must yield a thin analysis rather than a validation failure that
 * fails the whole run — the failure mode that would hit exactly the manual and
 * release-derived topics whose context is thinnest.
 *
 * That optionality is also why the `generateObject` call MUST pass
 * `providerOptions: { openai: { strictJsonSchema: false } }` — Azure/OpenAI
 * reject a strict JSON schema containing optional fields outright (bug #1681).
 * The AI SDK still validates the object against this schema.
 */
export const PublishingPlanningAnalysisSchema = z.object({
	/** FR21 */
	topicAngle: z.string().optional(),
	/** FR22 */
	whyWorthPublishing: z.string().optional(),
	/** FR23/FR24, DV12 */
	keyDetails: z
		.object({
			released: z.string().optional(),
			problem: z.string().optional(),
			solution: z.string().optional(),
			whatMakesItInteresting: z.string().optional(),
			evidence: z.string().optional(),
			quotes: z.string().optional(),
			caveats: z.string().optional(),
		})
		.optional(),
	/** FR25/FR26 */
	recommendedAuthors: z.string().optional(),
	/** FR27–FR29, DV13 */
	authorVoiceAndPerspective: z.string().optional(),
	/** FR30/FR31 */
	audienceAndDistributionFit: z.string().optional(),
	/** FR32/FR33 */
	contentTypes: z
		.object({
			recommended: z.array(ClassifiedRecommendationSchema).optional(),
			needsConfirmation: z
				.array(ClassifiedRecommendationSchema)
				.optional(),
			deferred: z.array(ClassifiedRecommendationSchema).optional(),
		})
		.optional(),
	/** FR34/FR35, DV11 */
	supportingAssets: z
		.object({
			recommended: z.array(ClassifiedRecommendationSchema).optional(),
			requiresApproval: z
				.array(ClassifiedRecommendationSchema)
				.optional(),
			deferred: z.array(ClassifiedRecommendationSchema).optional(),
		})
		.optional(),
	/** FR36 */
	sourceSignals: z.array(z.string()).optional(),
	/** FR37 */
	risks: z.array(z.string()).optional(),
	/**
	 * FR39. Deliberately carries NO id: the identity is derived code-side by
	 * `deriveQuestionId`, because an id the model invents is not stable across
	 * regenerations and stability is the entire point of the key.
	 *
	 * `decisionKind` and `subject` are what identity is built from — spec §4.3
	 * asks for a key derived from a question's subject "not its wording", and
	 * these are that subject, in two parts: WHAT KIND of decision, and WHAT it is
	 * about. They are what survives a regeneration that rephrases the question.
	 */
	recommendedQuestions: z
		.array(
			z.object({
				decisionKind: z.enum(PUBLISHING_DECISION_KINDS).optional(),
				subject: z.string().max(160).optional(),
				question: z.string().min(1),
				recommendedResponse: z.string().optional(),
				whyItMatters: z.string().optional(),
			}),
		)
		.optional(),
	/** FR38 */
	preDraftGuidance: z.string().optional(),
});

export type PublishingPlanningAnalysis = z.infer<
	typeof PublishingPlanningAnalysisSchema
>;

// =============================================================================
// Question identity
// =============================================================================

/**
 * Strip the wording noise that does not change what a phrase names.
 *
 * Lowercase, collapse internal whitespace, drop surrounding whitespace and
 * trailing sentence punctuation. Deliberately conservative: it does NOT stem,
 * reorder or drop stop-words, because two subjects that differ by a real word
 * are two subjects, and collapsing them would silently merge decisions a user
 * made separately.
 */
function normalizePhrase(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[?!.\s]+$/, "");
}

/**
 * The stable identity of one recommended question, for spec §4.3's
 * `(topicId, questionId)` reconciliation key.
 *
 * DERIVED, never asked of the model — and derived from the question's SUBJECT
 * rather than its wording, which is what §4.3 actually requires.
 *
 * Two earlier designs failed that requirement in different ways, and both are
 * worth remembering because both looked fine:
 *
 *   1. Ask the model for a "stable slug". Nothing makes an LLM emit the same
 *      slug twice, so the key was unstable exactly when it matters.
 *   2. Hash the question text. Deterministic, but stable only against
 *      typographic noise. A regeneration that rephrases the same decision —
 *      "Can we name the customer publicly?" → "Is public use of the customer
 *      name approved?" — still produces a new id, so §4.3's "refresh the
 *      existing OPEN root in place" never fires and the user gets a duplicate of
 *      a question they may already have answered.
 *
 * Identity is therefore `(decisionKind, subject)`: what kind of decision, about
 * what. Both survive a rewrite of the question itself. `question` is the
 * tiebreak of last resort, used only for a free-form `OTHER` with no subject —
 * where nothing stable exists to key on, and pretending otherwise would be the
 * bug.
 *
 * Scoped by `topicId` so an id is meaningless outside its topic, which stops a
 * reconciler keyed on the id alone from matching across topics.
 */
export function deriveQuestionId(input: {
	topicId: string;
	decisionKind?: PublishingDecisionKind;
	subject?: string;
	question: string;
}): string {
	const kind = input.decisionKind ?? "OTHER";
	const subject = input.subject ? normalizePhrase(input.subject) : "";
	// A kinded question with no subject is still identified by its kind — there
	// is only one "is this topic internal-only or external-ready?" per topic.
	// Only a kindless, subjectless question has to fall back to wording.
	const discriminator =
		subject || (kind === "OTHER" ? normalizePhrase(input.question) : "");

	return createHash("sha256")
		.update(`${input.topicId}\n${kind}\n${discriminator}`)
		.digest("hex")
		.slice(0, 32);
}

/**
 * Every unresolved decision this analysis carries, as a question (FR39).
 *
 * FR39 says an unresolved decision "shall be represented as a question in the
 * Summary & Questions tab". Rendering only the model's `recommendedQuestions`
 * does NOT satisfy that: the array is optional and entirely independent of the
 * classified buckets, so a valid response can mark a case study as needing
 * confirmation and a customer quote as needing approval while volunteering no
 * question at all — and the user would then see two "requires approval" labels
 * and nowhere to resolve them.
 *
 * So the questions are DERIVED from the recommendations that carry a
 * confirmation requirement, and merged with whatever the model volunteered. The
 * model's own wording wins on a collision, because it is written about this
 * topic rather than assembled from a bucket label; the derived one is the floor
 * that guarantees the decision is represented at all.
 *
 * Only `needsConfirmation` and `requiresApproval` mint questions. A
 * `recommended` entry is a resolved decision and a `deferred` one is a decision
 * already taken the other way — turning either into a question would bury the
 * real ones among noise.
 */
export interface ResolvedConfirmationQuestion {
	questionId: string;
	decisionKind: PublishingDecisionKind;
	subject: string | null;
	question: string;
	recommendedResponse: string | null;
	whyItMatters: string | null;
	/** Whether the model raised this itself, or it was derived from a bucket. */
	source: "MODEL" | "DERIVED";
}

export function resolveConfirmationQuestions(
	topicId: string,
	analysis: PublishingPlanningAnalysis,
): ResolvedConfirmationQuestion[] {
	const byId = new Map<string, ResolvedConfirmationQuestion>();

	// Derived first, so a model-authored question of the same identity overwrites
	// it below rather than being dropped by a "first one wins" rule.
	const derive = (
		decisionKind: PublishingDecisionKind,
		subject: string,
		question: string,
		whyItMatters: string,
	) => {
		const questionId = deriveQuestionId({
			topicId,
			decisionKind,
			subject,
			question,
		});
		byId.set(questionId, {
			questionId,
			decisionKind,
			subject,
			question,
			recommendedResponse: null,
			whyItMatters,
			source: "DERIVED",
		});
	};

	for (const entry of analysis.contentTypes?.needsConfirmation ?? []) {
		derive(
			"CONTENT_TYPE",
			entry.type,
			`Should we produce a ${entry.type} for this topic?`,
			entry.rationale,
		);
	}
	for (const entry of analysis.supportingAssets?.requiresApproval ?? []) {
		derive(
			"ASSET_APPROVAL",
			entry.type,
			`Is the ${entry.type} approved for use in this content?`,
			entry.rationale,
		);
	}

	for (const q of analysis.recommendedQuestions ?? []) {
		const decisionKind = q.decisionKind ?? "OTHER";
		const questionId = deriveQuestionId({
			topicId,
			decisionKind,
			subject: q.subject,
			question: q.question,
		});
		byId.set(questionId, {
			questionId,
			decisionKind,
			subject: q.subject ?? null,
			question: q.question,
			recommendedResponse: q.recommendedResponse ?? null,
			whyItMatters: q.whyItMatters ?? null,
			source: "MODEL",
		});
	}

	return [...byId.values()];
}

// =============================================================================
// Prompt input
// =============================================================================

/** The topic, as the activity reads it from the row — persisted fields only. */
export interface PlanningAnalysisTopic {
	id: string;
	title: string;
	pitch: string | null;
	angle: string | null;
	subject: string | null;
	relevantFunctionTags: string[];
	postTypeRecommendations: unknown;
	/** Resolved from `contributorUserIds`; `[]` is a valid, common answer. */
	contributors: { id: string; name: string | null }[];
}

/**
 * What the topic's own `provenance` resolved to.
 *
 * These are the three DB-resident source kinds plus PR coordinates. Releases are
 * absent by construction, not by omission: `TopicProvenanceSchema` has no
 * release field and there is no `Release` table — a release-derived topic
 * reaches this prompt only through the 1A engine's distillation of it, i.e. the
 * topic's own title/pitch/angle/subject above.
 */
export interface PlanningAnalysisContext {
	stories: {
		id: string;
		identifier: string;
		title: string;
		description?: string | null;
	}[];
	documents: { id: string; title: string; excerpt?: string | null }[];
	transcripts: { id: string; summary: string | null }[];
	/**
	 * PRs are not stored in Fabric, so the coordinate is always present and the
	 * body is whatever the GitHub read managed to fetch — `null` when it was
	 * capped, unreachable, or the repo is not connected. A coordinate without a
	 * body is still a citable reference.
	 */
	repoPrs: {
		repoFullName: string;
		prNumber: number;
		body?: string | null;
	}[];
}

// =============================================================================
// Template variables
// =============================================================================

/**
 * The data half of the prompt.
 *
 * Pure and synchronous so it stays unit-testable without a model or a database.
 * Each block value is a bullet list WITHOUT its heading: the heading lives in
 * the editable template, so an org can relabel a section without losing the data
 * underneath it. The paired `has_*` boolean is what lets the template keep the
 * invariant that an empty section is omitted rather than rendered as a bare
 * heading — which would invite the model to fill it with plausible inventions,
 * the one thing FR20 forbids.
 */
export interface PlanningAnalysisPromptVariables {
	topic_title: string;
	has_topic_pitch: boolean;
	topic_pitch: string;
	has_topic_angle: boolean;
	topic_angle: string;
	has_topic_subject: boolean;
	topic_subject: string;
	has_function_tags: boolean;
	function_tags: string;
	has_contributors: boolean;
	contributors: string;
	has_post_type_recommendations: boolean;
	post_type_recommendations: string;
	has_stories: boolean;
	stories: string;
	has_documents: boolean;
	documents: string;
	has_transcripts: boolean;
	transcripts: string;
	has_pull_requests: boolean;
	pull_requests: string;
	/** False when every source list above is empty — a manual topic, typically. */
	has_any_source_context: boolean;
}

/** Bound on a free-text excerpt inside the prompt, per item. */
export const SOURCE_EXCERPT_CHAR_CAP = 1200;

function truncate(text: string, cap = SOURCE_EXCERPT_CHAR_CAP): string {
	return text.length > cap ? `${text.slice(0, cap).trimEnd()}…` : text;
}

/**
 * Keep a multi-line excerpt inside its bullet.
 *
 * Without it, the second line of a PR description starts at column 0 and reads
 * as a new top-level item — so the model sees a source's body as if it were
 * another source.
 */
function indent(text: string): string {
	return text.replace(/\n/g, "\n  ");
}

function bullets(lines: string[]): string {
	return lines.map((l) => `- ${l}`).join("\n");
}

function describePostTypeRecommendations(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const lines: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const rec = entry as Record<string, unknown>;
		const type = typeof rec.type === "string" ? rec.type : null;
		if (!type) {
			continue;
		}
		const theme = typeof rec.theme === "string" ? rec.theme : null;
		lines.push(theme ? `${type} — ${theme}` : type);
	}
	return lines;
}

export function buildPlanningAnalysisVariables({
	topic,
	context,
}: {
	topic: PlanningAnalysisTopic;
	context: PlanningAnalysisContext;
}): PlanningAnalysisPromptVariables {
	const contributorLines = topic.contributors
		.map((c) => c.name?.trim())
		.filter((n): n is string => Boolean(n));

	const storyLines = context.stories.map((s) => {
		const head = `${s.identifier}: ${s.title}`;
		return s.description
			? `${head}\n  ${indent(truncate(s.description))}`
			: head;
	});

	const documentLines = context.documents.map((d) =>
		d.excerpt ? `${d.title}\n  ${indent(truncate(d.excerpt))}` : d.title,
	);

	const transcriptLines = context.transcripts
		.map((t) => t.summary?.trim())
		.filter((s): s is string => Boolean(s))
		.map((s) => truncate(s));

	// `owner/repo#number` is the citable form, and the body follows it when the
	// GitHub read got one. A PR with no body still appears: it is evidence the
	// work happened, and omitting it would silently narrow what the model may
	// cite.
	const prLines = context.repoPrs.map((p) => {
		const ref = `${p.repoFullName}#${p.prNumber}`;
		return p.body ? `${ref}\n  ${indent(truncate(p.body))}` : ref;
	});

	const postTypeLines = describePostTypeRecommendations(
		topic.postTypeRecommendations,
	);

	return {
		topic_title: topic.title,
		has_topic_pitch: Boolean(topic.pitch),
		topic_pitch: topic.pitch ?? "",
		has_topic_angle: Boolean(topic.angle),
		topic_angle: topic.angle ?? "",
		has_topic_subject: Boolean(topic.subject),
		topic_subject: topic.subject ?? "",
		has_function_tags: topic.relevantFunctionTags.length > 0,
		function_tags: topic.relevantFunctionTags.join(", "),
		has_contributors: contributorLines.length > 0,
		contributors: bullets(contributorLines),
		has_post_type_recommendations: postTypeLines.length > 0,
		post_type_recommendations: bullets(postTypeLines),
		has_stories: storyLines.length > 0,
		stories: bullets(storyLines),
		has_documents: documentLines.length > 0,
		documents: bullets(documentLines),
		has_transcripts: transcriptLines.length > 0,
		transcripts: bullets(transcriptLines),
		has_pull_requests: prLines.length > 0,
		pull_requests: bullets(prLines),
		has_any_source_context:
			storyLines.length > 0 ||
			documentLines.length > 0 ||
			transcriptLines.length > 0 ||
			prLines.length > 0,
	};
}

// =============================================================================
// The editable body
// =============================================================================

// =============================================================================
// The locked clauses
// =============================================================================

/**
 * Appended after the editable body, and therefore NOT removable by an org
 * override — the same arrangement `buildAgendaLockedClauses` uses, and for the
 * same reason.
 *
 * Two things live here rather than in the seed:
 *
 *  1. The OUTPUT CONTRACT. The body an org edits describes what to think about;
 *     how the answer is shaped is a contract with `generateObject` and a Zod
 *     schema. An org editing its prompt must not be able to change the response
 *     shape, because the result is not a worse analysis — it is a schema
 *     validation failure that fails the run.
 *  2. FR40–FR42. "Generate no asset" and "treat nothing sensitive as approved"
 *     are the requirements that make this phase safe to ship at all. A prompt
 *     edit that dropped them would not look like a mistake in the editor.
 */
export function buildPlanningAnalysisLockedClauses(): string {
	return `## Output contract

Return one field per section. The value of a field is Markdown; the response as
a whole is structured data, not a Markdown document.

Omit any section the available context does not support. An omitted section is a
correct answer for a thin topic; an invented one is not.

For each recommended question, give the question itself, a recommended response
where the context supports one (otherwise say what the user needs to provide),
and why the decision matters before drafting. Do not supply an identifier for a
question — one is assigned for you.

Also classify each question, because that is how the same decision is recognised
again when this analysis is regenerated:

- "decisionKind" — one of CUSTOMER_NAME, ASSET_APPROVAL, INTERNAL_UI,
  VIDEO_WALKTHROUGH, CONTENT_TYPE, AUTHORSHIP, METRICS_APPROVAL, AUDIENCE_SCOPE,
  CLAIM_STRENGTH, CODEBASE_DETAIL, or OTHER when none fits.
- "subject" — a short noun phrase naming WHAT the decision is about ("the
  customer quote", "the architecture diagram", "the first content format"). Name
  the same thing the same way every time; do not restate the question here.

Raise a question for every recommendation you classify as needing confirmation
or approval. One is raised on your behalf for any you miss, but yours will be
better written.

## Rules that override anything above

- Do NOT generate the final content asset. Not the blog post, short post, case
  study, stakeholder email, demo script, newsletter blurb or video walkthrough.
  This is a pre-draft planning worksheet and nothing else.
- Do NOT generate, create or use a supporting asset. Recommending one is the
  whole of your job here; producing one is not.
- Do NOT recommend creating a video walkthrough without marking it as requiring
  explicit user confirmation first.
- Do NOT treat a customer name, customer logo, customer or stakeholder quote,
  screenshot, internal UI capture, outcome metric, or AI voice or video likeness
  as approved for use. Where one would strengthen the content, classify it as
  requiring confirmation or approval and raise the approval as a question.`;
}

// =============================================================================
// Composition
// =============================================================================

/**
 * Render the editable body against this topic's context and append the locked
 * clauses.
 *
 * Three guards, inherited wholesale from `composeAgendaPrompt` because each was
 * learned from a real failure and none of them is hypothetical here:
 *
 *   1. MARKDOWN / PLAIN_TEXT do no templating at all — `renderTemplate` returns
 *      the body verbatim with NO error set. For a prompt whose entire context
 *      arrives as variables, that silently ships zero topic data to the model,
 *      which then invents a whole analysis. Decided from the format alone,
 *      before rendering.
 *   2. Output still containing an unrendered template construct means the body
 *      did not render — a parse error `renderHandlebars` swallowed into a
 *      raw-body return. Matches "{{{" or "{{#" rather than a bare "{{", because
 *      the context is user prose and a document title can plausibly contain
 *      mustaches; discarding a working org prompt over that would be the worse
 *      bug.
 *   3. Output that is blank once rendered. `{{#unknown}}x{{/unknown}}` is a
 *      falsy block, not a syntax error: it parses, renders to "", and guard 2
 *      cannot see it precisely because nothing survived. The model would receive
 *      only the locked clauses — no instructions and no topic — and still emit a
 *      plausible analysis that is persisted as READY.
 *
 * `bodyRecovered` is reported in the return value, not merely logged. A degraded
 * run produces a perfectly plausible analysis, so "this came from the default
 * body because your prompt would not render" is exactly the thing a reader
 * cannot infer from the output. It is persisted as `promptSource`.
 */
const UNRENDERED_TEMPLATE = /\{\{[{#]/;

export interface ComposedPlanningAnalysisPrompt {
	prompt: string;
	/** Guard 1 fired: a non-templating format was rendered as Handlebars. */
	formatOverridden: boolean;
	/**
	 * Guard 2 or 3 fired: the supplied body yielded nothing usable and the
	 * default was used instead. One flag for both, because the consequence a
	 * reader needs is identical — this analysis did not come from the prompt it
	 * is bound to.
	 */
	bodyRecovered: boolean;
}

export async function composePlanningAnalysisPrompt({
	templateBody,
	format,
	topic,
	context,
}: {
	templateBody: string;
	format: TemplateFormat;
	topic: PlanningAnalysisTopic;
	context: PlanningAnalysisContext;
}): Promise<ComposedPlanningAnalysisPrompt> {
	const variables = buildPlanningAnalysisVariables({ topic, context });

	let effectiveFormat = format;
	let formatOverridden = false;
	if (format === "MARKDOWN" || format === "PLAIN_TEXT") {
		logger.error(
			"[publishing-planning] bound prompt has a non-templating format; rendering as Handlebars",
			{ format },
		);
		effectiveFormat = "HANDLEBARS";
		formatOverridden = true;
	}

	const rendered = await renderTemplate({
		format: effectiveFormat,
		template: templateBody,
		variables,
	});

	let body = rendered.rendered;
	let bodyRecovered = false;
	// Not `trim()`: a template can render down to zero-width characters, which
	// trim leaves standing and the model reads as nothing.
	const renderedBlank = isEffectivelyBlank(body);
	if (rendered.error || UNRENDERED_TEMPLATE.test(body) || renderedBlank) {
		logger.error(
			"[publishing-planning] bound prompt did not render; using the default body",
			{ format: effectiveFormat, error: rendered.error, renderedBlank },
		);
		const recovery = await renderTemplate({
			format: "HANDLEBARS",
			template: PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
			variables,
		});
		body = recovery.rendered;
		bodyRecovered = true;
	}

	return {
		prompt: `${body.trimEnd()}\n\n${buildPlanningAnalysisLockedClauses()}`,
		formatOverridden,
		bodyRecovered,
	};
}
