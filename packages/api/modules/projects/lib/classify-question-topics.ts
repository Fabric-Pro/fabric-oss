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
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import type { MaturationTenantFilter } from "@repo/database";
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
				topic: z.enum(QUESTION_TOPICS),
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
			prompt: buildPrompt(questions),
		});

		const result = [...fallback];
		for (const { id, topic } of object.assignments) {
			const idx = id - 1;
			if (idx >= 0 && idx < result.length) {
				result[idx] = topic;
			}
		}
		return result;
	} catch {
		return fallback;
	}
}
