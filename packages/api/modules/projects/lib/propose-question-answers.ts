/**
 * AI answer recommendations for newly minted maturation questions (demo feedback
 * #7 / Fizzy 1711, Phase 2).
 *
 * A DEDICATED structured pass — the recommendation OUTPUT contract (each option +
 * its justification) is enforced in code by a Zod schema (`generateObject`), so it
 * can't be broken by prompt edits. The INSTRUCTION/tone is an org-editable bound
 * prompt (`feature_answer_recommender` / `bug_answer_recommender`, FR-8/FR-14), with
 * a code fallback when unbound. Idiom mirrors `classify-question-topics.ts`: a best-
 * effort, never-throwing second pass over the questions the parser already minted.
 *
 * CONTEXT (parity, bounded): the Clean Spec was JUST rebuilt from the full connected
 * context, so it is the distilled context. We feed the rebuilt spec plus a RAG
 * retrieval (`retrieveProjectContexts`) keyed off the feature — matching the
 * clean-spec build's primary signal. Live Teams/Slack and URL scrapes are
 * deliberately NOT re-fetched here, since this pass runs inline-awaited where latency
 * is user-visible.
 *
 * STORAGE: each recommendation is stamped onto its question root's `metadata` JSONB
 * under `answerRecommendation` (no migration; mirrors the `cleanSpecPropagation`
 * convention). INVARIANT: only ever called on FRESHLY-MINTED roots, whose metadata is
 * still null — `setDecisionMetadata` replaces the whole JSONB, so extending this to
 * pre-existing roots would require a read-merge to avoid clobbering other metadata.
 */

import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
// Imported from the SUBPATH so callers clamp output-token budgets identically to
// the merged reference site. See the helper for the Databricks 8,192 /
// Anthropic-direct 4,096 truncation this guards against.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	getBoundPromptForAgent,
	type MaturationTenantFilter,
	setDecisionMetadata,
} from "@repo/database";
import { logger } from "@repo/logs";
import { formatContextsForPrompt, retrieveProjectContexts } from "@repo/rag";
import { combineCleanSpec } from "@repo/utils/clean-spec-content";
import { zodSchema } from "ai";
import { z } from "zod";

/** Max suggested options per question (FR-3: 1–4, target ~2, no padding). */
const MAX_OPTIONS = 4;

/** A single recommended answer with its required justification (FR-2). */
export interface RecommendedOption {
	text: string;
	justification: string;
}

/** JSONB key on `DecisionLogEntry.metadata` carrying the answer recommendation. */
export const ANSWER_RECOMMENDATION_KEY = "answerRecommendation" as const;

const RecommendationSchema = z.object({
	recommendations: z
		.array(
			z.object({
				id: z
					.number()
					.int()
					.describe("The 1-based number of the question."),
				options: z
					.array(
						z.object({
							text: z
								.string()
								.describe(
									"A concrete, decision-ready candidate answer.",
								),
							justification: z
								.string()
								.describe(
									"1–2 sentences on why this option fits, grounded in the spec/context.",
								),
						}),
					)
					.describe(
						"0–4 candidate answers, each with a justification. Empty when the context supports none.",
					),
				confidence: z
					.enum(["high", "medium", "low"])
					.describe("Confidence that the options are correct."),
			}),
		)
		.describe("One entry per question, referencing its number."),
});

/** Fallback instruction used when no bound recommender prompt is configured. */
function fallbackInstruction(kind: string): string {
	const noun = kind === "BUG" ? "bug report" : "feature";
	return `You are a senior product manager helping resolve the open questions on a ${noun}. For EACH open question, try to answer it using ONLY the provided spec and connected context.

For each question, return between 1 and ${MAX_OPTIONS} candidate options — only those that are genuinely reasonable, popular, or logical given the context. Target about 2 on average. Do NOT pad to a fixed count.

Rules:
- Every option MUST include a short justification (1–2 sentences), grounded in the spec or context.
- If the context supports no confident option for a question, return an empty options list for it — never guess.
- Options must be concrete, decision-ready answers, not restatements of the question.
- Set confidence to "high" only when the context directly supports the options; "low" when inferred.
- Return exactly one entry per question, referencing its number.`;
}

function buildUserPrompt(params: {
	kind: string;
	title: string;
	spec: string;
	context: string | null;
	questions: string[];
}): string {
	const numbered = params.questions
		.map((q, i) => `${i + 1}. ${q}`)
		.join("\n");
	const noun = params.kind === "BUG" ? "BUG" : "FEATURE";
	return `${noun}: ${params.title}

SPEC:
${params.spec}
${params.context ? `\nCONNECTED CONTEXT:\n${params.context}` : ""}

OPEN QUESTIONS:
${numbered}`;
}

interface QuestionToRecommend {
	/** The question root id whose metadata receives the recommendation. */
	rootId: string;
	question: string;
}

export interface ProposeQuestionAnswersParams {
	feature: {
		id: string;
		projectId: string;
		title: string;
		kind: string;
		description: string | null;
		acceptanceCriteria: string | null;
	};
	questions: QuestionToRecommend[];
	tenantFilter: MaturationTenantFilter;
}

export interface ProposeQuestionAnswersResult {
	/** How many roots received at least one recommended option. */
	recommended: number;
}

/**
 * Generate and persist AI answer recommendations for the given freshly-minted
 * question roots. Best-effort: any failure (model error, empty context) leaves the
 * questions un-recommended and never throws. Returns `{ recommended: 0 }` for empty
 * input (no model call).
 */
export async function proposeQuestionAnswers({
	feature,
	questions,
	tenantFilter,
}: ProposeQuestionAnswersParams): Promise<ProposeQuestionAnswersResult> {
	if (questions.length === 0) {
		return { recommended: 0 };
	}

	const spec = combineCleanSpec(
		feature.description,
		feature.acceptanceCriteria,
	);
	if (!spec.trim()) {
		return { recommended: 0 };
	}

	try {
		// Same primary signal as the clean-spec build: RAG keyed off the feature.
		// Best-effort — a retrieval miss just means a spec-only recommendation.
		let context: string | null = null;
		try {
			const contexts = await retrieveProjectContexts({
				projectId: feature.projectId,
				query: `${feature.title} ${feature.description ?? ""}`.trim(),
				userId: tenantFilter.userId,
				organizationId: tenantFilter.organizationId ?? undefined,
				topK: 5,
			});
			context =
				contexts.length > 0 ? formatContextsForPrompt(contexts) : null;
		} catch (err) {
			logger.warn("[maturation] recommendation RAG retrieval failed", {
				storyId: feature.id,
				err: err instanceof Error ? err.message : String(err),
			});
		}

		// Org-editable instruction (FR-8/FR-14), kind-scoped; fall back to code.
		const agentName =
			feature.kind === "BUG"
				? "bug_answer_recommender"
				: "feature_answer_recommender";
		const boundPrompt = await getBoundPromptForAgent({
			agentName,
			documentType: "ANSWER_RECOMMENDATIONS",
			storyKind: feature.kind as never,
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
		});
		const instruction =
			boundPrompt?.version?.content?.trim() ||
			fallbackInstruction(feature.kind);

		const { model, metadata } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: tenantFilter.userId,
				organizationId: tenantFilter.organizationId ?? undefined,
				featureKey: "answer-recommendation",
				promptVersionId: boundPrompt?.version?.id,
			},
		);

		// Fizzy #1767 Stage 4: append the project's function-tag role-composition
		// clause (flag-gated, self-authorizing — see getProjectFunctionTagClause)
		// so the model knows who's on the project and in what capacity. No-op
		// when the flag is off, or when no roster member holds a tag.
		const roleClause = feature.projectId
			? await getProjectFunctionTagClause({
					projectId: feature.projectId,
					requesterUserId: tenantFilter.userId,
					surface: "propose-question-answers",
				})
			: "";

		// FR-25: append the shared locked-attachment
		// rule so this feature-context pass never fabricates attachment
		// contents or claims to have analysed one. Appended in code so it
		// holds regardless of the org-editable bound instruction. No-op
		// today (no attachment metadata reaches AI context).
		const system = `${instruction}\n\n${getLockedAttachmentRulesClause()}${roleClause ? `\n\n${roleClause}` : ""}`;
		const prompt = buildUserPrompt({
			kind: feature.kind,
			title: feature.title,
			spec,
			context,
			questions: questions.map((q) => q.question),
		});

		// Scaled mode: the recommendations reason over the spec/context, so output
		// tracks the spec size. Without an explicit budget Databricks/Anthropic-
		// direct truncate at their injected defaults; `undefined` for providers
		// that don't need the workaround (they keep their SDK defaults).
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: spec.length,
			promptChars: system.length + prompt.length,
		});

		const { object } = await generateObject({
			model,
			schema: zodSchema(RecommendationSchema),
			system,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		let recommended = 0;
		for (const rec of object.recommendations) {
			const idx = rec.id - 1;
			const target = questions[idx];
			if (!target) {
				continue;
			}
			const options = normalizeOptions(rec.options);
			if (options.length === 0) {
				continue;
			}
			// INVARIANT: minted roots have metadata=null, so a whole-object write is
			// safe (see file header). Built as an inline JSON literal (not the
			// AnswerRecommendation interface) so it satisfies Prisma's InputJsonValue.
			const count = await setDecisionMetadata({
				tenantFilter,
				id: target.rootId,
				metadata: {
					[ANSWER_RECOMMENDATION_KEY]: {
						options: options.map((o) => ({
							text: o.text,
							justification: o.justification,
						})),
						confidence: rec.confidence,
					},
				},
			});
			if (count > 0) {
				recommended++;
			}
		}
		return { recommended };
	} catch (err) {
		logger.warn("[maturation] answer recommendation pass failed", {
			storyId: feature.id,
			err: err instanceof Error ? err.message : String(err),
		});
		return { recommended: 0 };
	}
}

/**
 * Normalize model options: require a non-empty text AND justification (FR-2 — an
 * option without a justification is dropped), trim, dedupe by text
 * (case-insensitive), cap at {@link MAX_OPTIONS}.
 */
export function normalizeOptions(options: unknown): RecommendedOption[] {
	if (!Array.isArray(options)) {
		return [];
	}
	const seen = new Set<string>();
	const out: RecommendedOption[] = [];
	for (const raw of options) {
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const text =
			typeof (raw as { text?: unknown }).text === "string"
				? (raw as { text: string }).text.trim()
				: "";
		const justification =
			typeof (raw as { justification?: unknown }).justification ===
			"string"
				? (raw as { justification: string }).justification.trim()
				: "";
		if (!text || !justification) {
			continue;
		}
		const key = text.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ text, justification });
		if (out.length >= MAX_OPTIONS) {
			break;
		}
	}
	return out;
}
