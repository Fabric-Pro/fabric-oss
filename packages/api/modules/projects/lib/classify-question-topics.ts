/**
 * Topic classification for maturation questions (Feature Maturation V2).
 *
 * The Summary & Questions tab groups OPEN questions by a stable topic so a PO can
 * triage 13 questions by subject instead of one flat list. We assign each newly
 * minted question one label from a FIXED taxonomy (not free-form) so groups stay
 * stable across runs — two differently-worded toolkit questions both land under
 * "Tooling & Tech" rather than drifting into "Toolkit" vs "Tooling".
 *
 * This is a *labelling* pass over questions the deterministic parser already
 * extracted — it never invents or drops questions, so it does not reopen the
 * faithful-extraction guarantee. Best-effort: any failure (or an unmapped label)
 * falls back to "Other", and the questions still surface ungrouped.
 *
 * When the organization has a typed decision model configured, a single
 * `experimental_evaluate` call asks it for every question up front — one
 * `choice` question per question, over the same fixed taxonomy the language
 * classifier uses. A question whose answer clears the confidence floor is
 * labelled from that answer alone; everything else (no decision model, an
 * uncertain or malformed answer, or a non-usage-limit decision error) falls
 * through to the language classifier below, which stays the behaviour of
 * record. A usage limit at either step yields the same all-"Other" result as
 * today without a second model call, because retrying through the language
 * model would bill the very spend the limit refused.
 */

import {
	experimental_evaluate,
	generateObject,
	getAIDecisionModelWithMetadata,
	getAIModelWithMetadata,
} from "@repo/ai";
import type { MaturationTenantFilter } from "@repo/database";
import { logger } from "@repo/logs";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { zodSchema } from "ai";
import { z } from "zod";

/** Fixed taxonomy, in display order. "Other" always sorts last in the UI. */
const QUESTION_TOPICS = [
	"Scope & Requirements",
	"Tooling & Tech",
	"Data & Storage",
	"UX & Design",
	"Rollout & Migration",
	"Integrations & Sources",
	"Testing & QA",
	"Other",
] as const;

export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

const FALLBACK_TOPIC: QuestionTopic = "Other";

const QuestionTopicEnum = z.enum(QUESTION_TOPICS);

const ClassificationSchema = z.object({
	assignments: z
		.array(
			z.object({
				id: z
					.number()
					.int()
					.describe(
						"The 1-based number of the question being labelled.",
					),
				topic: QuestionTopicEnum,
			}),
		)
		.describe("One entry per question, labelling it with a single topic."),
});

function buildPrompt(questions: string[]): string {
	const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
	return `Classify each product-management question below into exactly ONE of these topics:
${QUESTION_TOPICS.map((t) => `- ${t}`).join("\n")}

Rules:
- Pick the single best-fit topic. Use "Other" only when none clearly applies.
- Questions about which library/framework/toolkit to use → "Tooling & Tech".
- Questions about storing/retrieving/modelling data → "Data & Storage".
- Questions about layout, interaction, or visual design → "UX & Design".
- Questions about release strategy, feature flags, or migrating existing data → "Rollout & Migration".
- Questions about connecting to external sources/services → "Integrations & Sources".
- Questions about test coverage, acceptance criteria, or QA → "Testing & QA".
- Questions about what is in/out of scope or what a requirement means → "Scope & Requirements".
- Return one assignment per question, referencing its number.

QUESTIONS:
${numbered}`;
}

// =============================================================================
// Typed decision fast path
// =============================================================================

/**
 * Typed decision fast path, mirroring the retry budget and acceptance floor in
 * `packages/temporal/src/lib/classify-work-item.ts` and
 * `packages/temporal/src/activities/delivery-track/classify.ts` — and the same
 * rule that anything not clearly parseable is treated as uncertain rather than
 * trusted.
 *
 * The floor is a routing policy, not a claim that provider probabilities are
 * calibrated. Until labeled Fabric question-topic data calibrates it, only a
 * very confident typed choice may skip the language classifier.
 */
const DECISION_TIMEOUT_MS = 30_000;
const DECISION_MAX_RETRIES = 1;
const DECISION_CONFIDENCE_THRESHOLD = 0.9;

/**
 * One short criterion per topic, offered to the decision model as its choice
 * options. Derived from the `Rules:` lines in {@link buildPrompt} — the two
 * must agree so an operator reading either can predict the other's verdict.
 */
const TOPIC_CRITERIA: Record<QuestionTopic, string> = {
	"Scope & Requirements":
		"What is in or out of scope, or what a requirement means.",
	"Tooling & Tech": "Which library, framework, or toolkit to use.",
	"Data & Storage": "How data is stored, retrieved, or modelled.",
	"UX & Design": "Layout, interaction, or visual design.",
	"Rollout & Migration":
		"Release strategy, feature flags, or migrating existing data.",
	"Integrations & Sources": "Connecting to external sources or services.",
	"Testing & QA": "Test coverage, acceptance criteria, or QA.",
	Other: "None of the other topics clearly applies.",
};

/**
 * Read one `choice` answer defensively. An answer that is missing, not a
 * choice, names something outside the fixed taxonomy, carries no
 * distribution, or whose winning probability is not a finite number at or
 * above the floor (and no greater than 1) is uncertain — never a verdict.
 */
function readTopicChoice(
	result: Awaited<ReturnType<typeof experimental_evaluate>>,
	questionKey: string,
): QuestionTopic | null {
	const answer = (result as { answers?: Record<string, unknown> }).answers?.[
		questionKey
	];
	if (!answer || typeof answer !== "object") {
		return null;
	}

	const { type, choice, probabilities } = answer as {
		type?: unknown;
		choice?: unknown;
		probabilities?: unknown;
	};
	if (
		type !== "choice" ||
		!probabilities ||
		typeof probabilities !== "object"
	) {
		return null;
	}

	const topic = QuestionTopicEnum.safeParse(choice);
	if (!topic.success) {
		return null;
	}

	const probability = (probabilities as Record<string, unknown>)[topic.data];
	if (
		typeof probability !== "number" ||
		!Number.isFinite(probability) ||
		probability < DECISION_CONFIDENCE_THRESHOLD ||
		probability > 1
	) {
		return null;
	}

	return topic.data;
}

export interface ClassifyQuestionTopicsParams {
	questions: string[];
	tenantFilter: MaturationTenantFilter;
}

/**
 * Label each question with a topic from {@link QUESTION_TOPICS}. Returns an array
 * aligned by index with the input. Never throws — on any error every question
 * gets {@link FALLBACK_TOPIC}. Returns `[]` for empty input (no model call).
 */
export async function classifyQuestionTopics({
	questions,
	tenantFilter,
}: ClassifyQuestionTopicsParams): Promise<QuestionTopic[]> {
	if (questions.length === 0) {
		return [];
	}
	const fallback = questions.map(() => FALLBACK_TOPIC);
	const result = [...fallback];

	// Optional typed decision model, resolved once per call. It is a fast
	// path, not a dependency: an organization without an organization-owned
	// Vercel Gateway decision model — or any other resolution failure —
	// classifies every question with the language model exactly as it does
	// today.
	let decisionModel: Awaited<
		ReturnType<typeof getAIDecisionModelWithMetadata>
	> | null = null;
	try {
		decisionModel = await getAIDecisionModelWithMetadata({
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
			featureKey: "maturation",
		});
	} catch (error) {
		if (error instanceof AiUsageLimitExceededError) {
			// The language model would hit the same limit, so there is
			// nothing to gain from trying it — that is exactly what happens
			// today (the language path's catch swallows it into all-Other).
			logger.warn(
				"[classify-question-topics] Usage limit reached while resolving the decision model; returning fallback",
				{
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			return fallback;
		}
		logger.info(
			"[classify-question-topics] No decision model — using the language model",
			{ error },
		);
		decisionModel = null;
	}

	let leftover = questions.map((_, index) => index);

	if (decisionModel) {
		const keyByIndex = questions.map((_, index) => `question_${index}`);
		const evalQuestions: Record<
			string,
			{
				type: "choice";
				instructions: string;
				criteria: Record<string, string>;
			}
		> = {};
		for (const key of keyByIndex) {
			evalQuestions[key] = {
				type: "choice",
				instructions: `Classify the question keyed "${key}" in questions into exactly one topic; judge only that question. Use "Other" only when no other topic clearly applies.`,
				criteria: TOPIC_CRITERIA,
			};
		}

		let evalResult: Awaited<
			ReturnType<typeof experimental_evaluate>
		> | null = null;
		try {
			evalResult = await experimental_evaluate({
				model: decisionModel.model,
				state: {
					topics: TOPIC_CRITERIA,
					questions: questions.map((text, index) => ({
						key: keyByIndex[index],
						text,
					})),
				},
				questions: evalQuestions,
				maxRetries: DECISION_MAX_RETRIES,
				abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
			});
		} catch (error) {
			if (error instanceof AiUsageLimitExceededError) {
				// Nothing has been decided yet, so there is nothing to keep;
				// retrying through the language model would bill the very
				// spend the limit refused.
				logger.warn(
					"[classify-question-topics] Usage limit reached during decision evaluation; returning fallback",
					{
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
				return fallback;
			}
			logger.warn(
				"[classify-question-topics] Decision evaluation unavailable; using the language model",
				{
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			evalResult = null;
		}

		if (evalResult) {
			// A completed evaluation used the organization provider even when
			// nothing is confident enough for the fast path, so update
			// last-used before inspecting the answers.
			decisionModel.trackUsage();

			const stillLeftover: number[] = [];
			for (const index of leftover) {
				const topic = readTopicChoice(evalResult, keyByIndex[index]);
				if (topic) {
					result[index] = topic;
				} else {
					stillLeftover.push(index);
				}
			}
			leftover = stillLeftover;

			logger.info(
				"[classify-question-topics] Decision evaluation resolved",
				{
					total: questions.length,
					decided: questions.length - leftover.length,
					leftover: leftover.length,
				},
			);
		}
	}

	if (leftover.length === 0) {
		return result;
	}

	try {
		const { model } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: tenantFilter.userId,
				organizationId: tenantFilter.organizationId ?? undefined,
				featureKey: "maturation",
			},
		);

		const { object } = await generateObject({
			model,
			schema: zodSchema(ClassificationSchema),
			prompt: buildPrompt(leftover.map((index) => questions[index])),
		});

		for (const { id, topic } of object.assignments) {
			const idx = leftover[id - 1];
			if (idx !== undefined) {
				result[idx] = topic;
			}
		}
		return result;
	} catch {
		// Decided labels must survive a language-path failure; leftovers stay
		// FALLBACK_TOPIC, which `result` already carries for every index the
		// decision pass didn't resolve.
		return result;
	}
}
