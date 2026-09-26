/**
 * Shared Create-vs-Enrich routing decision core (Fizzy #2180).
 *
 * `routeActionItemsToExistingTickets` (backlog-context/route-action-items.ts)
 * and the interactive roadmap duplicate check
 * (`packages/api/modules/projects/procedures/stories/check-duplicate.ts`) ask
 * the exact same question — "is this new text already tracked by one of the
 * project's active tickets, and if so, which one, and how confident are we" —
 * for two different callers: a background Temporal activity judging a batch of
 * captured action items, and an interactive API request judging one manually
 * typed description. Both callers share ONE implementation of the
 * corpus/embedding/cache stage, the judge and typed-decision-model
 * resolution, and the per-item judgement — a change to any of those reaches
 * both surfaces at once instead of drifting apart between two copies.
 *
 * What stays OUT of this module, deliberately:
 *  - no `@temporalio/activity` import. The Temporal activity heartbeats while
 *    this runs; the API request does not. Both needs are met with plain
 *    callbacks (`onEmbedProgress`, `onBeforeLanguageJudge`) the caller wires
 *    to whatever liveness signal it has, or omits.
 *  - nothing ChangeProposal-shaped. Turning a judgement into a rewritten
 *    `ChangeProposal["changes"][number]` row (`buildEnrichedRow`,
 *    `capturedContent`) is the activity's own concern; the API caller turns
 *    the same judgement into its own response shape instead.
 *
 * Degradation contract: nothing here throws EXCEPT `loadRoutingCorpus` and
 * `resolveRoutingModels` on a wholesale failure (candidate load,
 * embedding-model resolution, embedding generation, or judge-model
 * resolution) — every caller is expected to catch that and treat it as "the
 * whole batch/request could not be evaluated" (the activity's `allFailed`, or
 * the API's error result). `judgeRoutingItem` never throws at all, including
 * for `AiUsageLimitExceededError`: falling through to the language judge after
 * a usage-limit rejection would bill the very spend the limit refused, so that
 * error resolves to a `"failed"` judgement rather than a retry.
 */

import {
	experimental_evaluate,
	generateObject,
	getAIDecisionModelWithMetadata,
	getAIModelWithMetadata,
	resolveModelWithProvider,
} from "@repo/ai";
// Subpath import (not the @repo/ai root) so it stays UNMOCKED in tests that
// mock the root module — the uniform rule across the budget call sites.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	baseModelName,
	buildRoutingJudgePrompt,
	type CachedStoryEmbedding,
	detectionTextForStory,
	getBoundPromptForAgent,
	hashDetectionText,
	listActiveStoriesForDetection,
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	type RoutingJudgeCandidate,
	upsertStoryDuplicateEmbeddings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { generateEmbeddings } from "@repo/rag";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import { z } from "zod";
import { type CandidateStory, selectCandidates } from "./action-item-link-core";

/**
 * Judge verdict. Declared with this package's `zod` (not shared from
 * @repo/database) because the AI SDK's `generateObject` is sensitive to the
 * exact zod build it is handed — the same reason `VerdictSchema` is local in
 * `detect-duplicate-stories.ts`. Only the prompt is shared.
 *
 * Lenient on purpose: `targetIdentifier` accepts any string (validated against
 * the shortlist below, so a hallucinated identifier degrades to Create rather
 * than failing the whole call), and `reasoning` is optional with a generous cap
 * so a verbose model never invalidates an otherwise usable verdict.
 */
const RoutingVerdictSchema = z.object({
	decision: z.enum(["create", "enrich"]),
	targetIdentifier: z.string().nullable().optional(),
	confidence: z.number().min(0).max(1),
	reasoning: z.string().max(2000).optional(),
});

/**
 * Typed decision fast path, mirroring `lib/classify-work-item.ts` — the same
 * timeout, retry budget and acceptance floor, and the same rule that anything
 * not clearly parseable is treated as uncertain rather than trusted.
 *
 * The floor is a routing policy, not a claim that provider probabilities are
 * calibrated. Until labeled Fabric routing data calibrates it, only a very
 * confident typed verdict may skip the language judge.
 */
const DECISION_TIMEOUT_MS = 10_000;
const DECISION_MAX_RETRIES = 1;
const DECISION_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Per-candidate budget for the `target` question's criteria descriptions. The
 * shortlist is already capped by `selectCandidates`, so this bounds only how
 * much of each ticket's detection text travels with it — enough to tell two
 * neighbouring tickets apart without re-sending a whole backlog body that the
 * judge prompt in `state` already carries.
 */
const DECISION_CRITERION_CHARS = 500;

/**
 * Read one `choice` answer defensively. An answer that is missing, not a
 * choice, carries no distribution, or whose winning probability is not a finite
 * number in [0,1] is uncertain — never a verdict.
 */
function readChoiceAnswer(
	result: Awaited<ReturnType<typeof experimental_evaluate>>,
	questionKey: string,
): { choice: string; probability: number } | null {
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
		typeof choice !== "string" ||
		choice.length === 0 ||
		!probabilities ||
		typeof probabilities !== "object"
	) {
		return null;
	}

	const probability = (probabilities as Record<string, unknown>)[choice];
	if (
		typeof probability !== "number" ||
		!Number.isFinite(probability) ||
		probability < 0 ||
		probability > 1
	) {
		return null;
	}

	return { choice, probability };
}

type DecisionFastPath =
	| { decision: "create"; confidence: number }
	| { decision: "enrich"; confidence: number; targetIdentifier: string };

/**
 * Whether a decision evaluation is confident enough to stand in for the
 * language judge, and what it decided. Null means "fall through".
 *
 * Enrich has to clear BOTH floors: the fixed decision floor above, and the
 * operator-tunable `threshold` that already binds the language judge — a
 * decision model must not be able to enrich at a confidence an operator has
 * declared too low. Create needs only the decision floor, because create is
 * the safe direction and is what a fall-through would most often produce
 * anyway.
 */
function acceptDecisionEvaluation(
	result: Awaited<ReturnType<typeof experimental_evaluate>>,
	shortlistIdentifiers: ReadonlySet<string>,
	enrichThreshold: number,
): DecisionFastPath | null {
	const routing = readChoiceAnswer(result, "routing");
	if (!routing || routing.probability < DECISION_CONFIDENCE_THRESHOLD) {
		return null;
	}

	if (routing.choice === "create") {
		return { decision: "create", confidence: routing.probability };
	}
	if (routing.choice !== "enrich" || routing.probability < enrichThreshold) {
		return null;
	}

	const target = readChoiceAnswer(result, "target");
	if (
		!target ||
		target.probability < DECISION_CONFIDENCE_THRESHOLD ||
		// The criteria keys ARE the shortlist identifiers, so anything else is
		// a hallucinated target and must never address some other row.
		!shortlistIdentifiers.has(target.choice)
	) {
		return null;
	}

	return {
		decision: "enrich",
		confidence: routing.probability,
		targetIdentifier: target.choice,
	};
}

/**
 * One decision evaluation for one item. Returns the verdict when it is
 * confident enough to stand in for the language judge, and null whenever the
 * caller should fall through to it.
 *
 * Only `AiUsageLimitExceededError` escapes: a usage limit is the one decision
 * failure that must NOT be retried through the language judge, because doing so
 * would bill the very spend the limit refused. `judgeRoutingItem`'s outer catch
 * turns it into a `"failed"` judgement, so this module still never throws
 * outward from a per-item judgement.
 */
async function evaluateRouting(params: {
	decisionModel: Awaited<ReturnType<typeof getAIDecisionModelWithMetadata>>;
	prompt: string;
	actionItem: string;
	analyzerReasoning?: string | null;
	candidates: RoutingJudgeCandidate[];
	threshold: number;
	projectId: string;
	title?: string;
	logPrefix: string;
}): Promise<DecisionFastPath | null> {
	const { decisionModel, candidates, projectId, title, logPrefix } = params;

	// Keyed by the EXACT shortlist identifier, so an accepted target maps back
	// onto the shortlist without any fuzzy matching. Each description is capped
	// because the full bodies already travel with the rendered judge prompt in
	// `state`; this only has to tell neighbouring tickets apart.
	const targetCriteria: Record<string, string> = {};
	for (const candidate of candidates) {
		targetCriteria[candidate.identifier] =
			`${candidate.title}\n${candidate.content}`.slice(
				0,
				DECISION_CRITERION_CHARS,
			);
	}

	let result: Awaited<ReturnType<typeof experimental_evaluate>>;
	try {
		result = await experimental_evaluate({
			model: decisionModel.model,
			state: {
				judgePolicy: params.prompt,
				actionItem: params.actionItem,
				analyzerReasoning: params.analyzerReasoning ?? "",
			},
			questions: {
				routing: {
					type: "choice",
					instructions:
						"Apply judgePolicy to actionItem. Choose enrich only when the action item is additional detail on one of the candidate tickets; choose create when it is work none of them already covers.",
					criteria: {
						create: "The action item is new work that none of the candidate tickets already tracks.",
						enrich: "The action item is additional detail on one of the candidate tickets, which should absorb it rather than a new ticket being opened.",
					},
				},
				target: {
					type: "choice",
					instructions:
						"Choose the candidate ticket the action item belongs to, by its identifier. Answer as if enrich were the correct routing, even when create is the better one.",
					criteria: targetCriteria,
				},
			},
			maxRetries: DECISION_MAX_RETRIES,
			abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof AiUsageLimitExceededError) {
			throw error;
		}
		logger.warn(
			`${logPrefix} decision evaluation unavailable; using language judge`,
			{
				projectId,
				actionItem: title?.slice(0, 200),
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return null;
	}

	// A completed evaluation used the organization provider even when the
	// answer is too uncertain for the fast path, so update last-used before
	// inspecting it.
	decisionModel.trackUsage();

	const verdict = acceptDecisionEvaluation(
		result,
		new Set(candidates.map((candidate) => candidate.identifier)),
		params.threshold,
	);
	if (!verdict) {
		logger.warn(
			`${logPrefix} decision evaluation was uncertain or malformed; using language judge`,
			{ projectId, actionItem: title?.slice(0, 200) },
		);
	}
	return verdict;
}

/** Agent key the routing judge's prompt is bound to in the prompt library.
 * Non-stage binding, so it resolves at documentType GENERAL with a null
 * storyKind — the same shape as the other operator-editable judges
 * (`security_scan_fp_judge`, `test_case_drafter`). Shared by both callers, so
 * an operator's bound wording governs a manual-create check exactly as it
 * governs ingested-transcript routing. */
export const ROUTING_JUDGE_AGENT = "action_item_routing_judge";

/**
 * The judge's prompt, from the prompt library when an operator has one bound,
 * otherwise the shipped fallback.
 *
 * An inline prompt string is not editable by the people who actually tune this
 * behaviour, and routing's whole precision story lives in the judge's wording:
 * how strongly it is told to prefer Create when unsure is the difference between
 * a helpful enrichment and a silently corrupted ticket. That belongs in the
 * library next to the other judges, not compiled into the worker.
 *
 * Never throws: a missing binding, an unseeded environment or a bad template all
 * degrade to the fallback, because failing a caller over prompt resolution
 * would be a far worse outcome than using the shipped wording.
 */
async function resolveJudgePrompt(params: {
	userId: string;
	organizationId?: string;
	actionItem: string;
	reasoning?: string | null;
	candidates: RoutingJudgeCandidate[];
	logPrefix: string;
}): Promise<string> {
	const fallback = buildRoutingJudgePrompt({
		actionItem: params.actionItem,
		reasoning: params.reasoning,
		candidates: params.candidates,
	});
	try {
		const bound = await getBoundPromptForAgent({
			agentName: ROUTING_JUDGE_AGENT,
			documentType: "GENERAL",
			storyKind: null,
			userId: params.userId,
			organizationId: params.organizationId,
		});
		const content = bound?.version?.content;
		if (!content?.trim()) {
			return fallback;
		}
		const rendered = await renderTemplate({
			format: bound?.format as TemplateFormat,
			template: content,
			variables: {
				action_item: params.actionItem,
				reasoning: params.reasoning ?? "",
				// Pre-rendered so the template does not have to loop, and
				// triple-stache in the seed so a ticket body containing <, & or
				// quotes is not HTML-escaped into the prompt.
				candidates: params.candidates
					.map(
						(c, i) =>
							`### Candidate ${i + 1} — ${c.identifier}: ${c.title}\n${c.content}`,
					)
					.join("\n\n"),
				first_identifier: params.candidates[0]?.identifier ?? "F-001",
			},
		});
		if (rendered.error || !rendered.rendered?.trim()) {
			logger.warn(`${params.logPrefix} judge prompt render failed`, {
				error: rendered.error,
			});
			return fallback;
		}
		return rendered.rendered;
	} catch (error) {
		logger.warn(`${params.logPrefix} judge prompt binding unavailable`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return fallback;
	}
}

/** One entry of the ranked shortlist a judgement carries. */
export type RoutingAlternative = {
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
};

type CorpusStory = Awaited<
	ReturnType<typeof listActiveStoriesForDetection>
>[number];

/** The project has no active tickets to match against. Every input is a
 * considered "new work" — no embedding or judge call was made. */
export type EmptyRoutingCorpus = { kind: "empty" };

/** A ready-to-judge corpus: one embedding per input text, plus the project's
 * candidate vectors and the story rows/text behind them. */
export type ReadyRoutingCorpus = {
	kind: "ready";
	itemEmbeddings: number[][];
	candidateVectors: CandidateStory[];
	storyById: Map<string, CorpusStory>;
	textByStoryId: Map<string, string>;
	/** Stale candidates that were skipped over `maxStaleEmbeds` and so are
	 * absent from `candidateVectors` this call — always 0 when the caller
	 * passed no cap. */
	skippedStale: number;
};

export type RoutingCorpus = EmptyRoutingCorpus | ReadyRoutingCorpus;

export interface LoadRoutingCorpusParams {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** Detection-style text for each item to be judged this call, embedded in
	 * the SAME batched provider request as any stale candidate vectors. */
	itemTexts: string[];
	logPrefix: string;
	/** Heartbeat/liveness callback for a multi-batch embedding call. The
	 * Temporal activity heartbeats through this; an interactive caller omits
	 * it. */
	onEmbedProgress?: (completed: number, total: number) => void;
	/** Cap on inline re-embeds of stale candidates this call will pay for,
	 * mirroring `semantic-search.ts`'s `MAX_INLINE_EMBEDS`. Omitted (the
	 * Temporal caller) re-embeds every stale candidate. */
	maxStaleEmbeds?: number;
}

/**
 * Load one call's routing corpus: the project's active tickets as detection
 * text, their embeddings (from the shared `StoryDuplicateEmbedding` cache
 * wherever still valid, re-embedded otherwise), and the caller's own item
 * texts embedded in the same batched request.
 *
 * Throws on a wholesale failure — candidate load, embedding-model resolution,
 * or the embedding call itself — so a caller can treat that as "this whole
 * call could not be evaluated" (the activity's `allFailed`, or the API's error
 * result). A cache read/write failure is NOT wholesale: it degrades to
 * re-embedding everything.
 */
export async function loadRoutingCorpus(
	params: LoadRoutingCorpusParams,
): Promise<RoutingCorpus> {
	const {
		projectId,
		userId,
		organizationId,
		itemTexts,
		logPrefix,
		onEmbedProgress,
		maxStaleEmbeds,
	} = params;

	const candidates = await listActiveStoriesForDetection(projectId);
	const candidateTexts = candidates
		.map((story) => ({ story, text: detectionTextForStory(story) }))
		.filter((entry) => entry.text.length > 0);

	// An empty backlog is a legitimate, fully-evaluated outcome — every item is
	// net-new. No embedding or judge call is made.
	if (candidateTexts.length === 0) {
		return { kind: "empty" };
	}

	const resolved = await resolveModelWithProvider("EMBEDDING", {
		userId,
		organizationId: organizationId ?? undefined,
	});
	const currentModel = baseModelName(resolved.modelString);

	const hashByStoryId = new Map(
		candidateTexts.map((entry) => [
			entry.story.id,
			hashDetectionText(entry.text),
		]),
	);

	const embeddingByStoryId = new Map<string, number[]>();
	try {
		const cacheMeta = await listStoryDuplicateEmbeddingMetadata(projectId);
		const cachedByStoryId = new Map(cacheMeta.map((r) => [r.storyId, r]));
		const reusableIds = new Set(
			candidateTexts
				.filter((entry) => {
					const cached = cachedByStoryId.get(entry.story.id);
					return (
						cached !== undefined &&
						cached.contentHash ===
							hashByStoryId.get(entry.story.id) &&
						cached.model === currentModel
					);
				})
				.map((entry) => entry.story.id),
		);
		// Only pull the heavy vector column when something is actually
		// reusable, so a first run never loads it at all.
		if (reusableIds.size > 0) {
			for (const row of await listStoryDuplicateEmbeddings(projectId)) {
				if (reusableIds.has(row.storyId)) {
					embeddingByStoryId.set(row.storyId, row.embedding);
				}
			}
		}
	} catch (error) {
		// A cache read failure must not fail the call: fall back to embedding
		// everything, which is exactly the pre-cache behaviour.
		logger.warn(`${logPrefix} embedding cache unavailable`, {
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		embeddingByStoryId.clear();
	}

	// Derive what to embed from the vectors actually in hand, never from what
	// the metadata promised. The two cache reads are separate queries, so a row
	// deleted between them (story removed mid-run) would otherwise count as
	// cached, contribute no vector, and drop that ticket out of every shortlist
	// for the call — a silently missed enrichment.
	const staleCandidates = candidateTexts.filter(
		(entry) => !embeddingByStoryId.has(entry.story.id),
	);
	// `.slice(0, undefined)` returns the whole array, so an omitted cap embeds
	// every stale candidate.
	const embedCandidates = staleCandidates.slice(0, maxStaleEmbeds);
	const skippedStale = staleCandidates.length - embedCandidates.length;

	const freshRows: CachedStoryEmbedding[] = [];
	const { embeddings, model } = await generateEmbeddings(
		[...itemTexts, ...embedCandidates.map((entry) => entry.text)],
		{ userId, organizationId, projectId },
		undefined,
		undefined,
		onEmbedProgress,
	);
	const itemEmbeddings = embeddings.slice(0, itemTexts.length);
	embedCandidates.forEach((entry, i) => {
		const vector = embeddings[itemTexts.length + i];
		embeddingByStoryId.set(entry.story.id, vector);
		freshRows.push({
			storyId: entry.story.id,
			contentHash: hashByStoryId.get(entry.story.id) ?? "",
			model,
			embedding: vector,
		});
	});

	// Best-effort write-back: a failure here costs the next call some
	// re-embedding, it does not make this call's routing wrong.
	try {
		await upsertStoryDuplicateEmbeddings(projectId, freshRows);
	} catch (error) {
		logger.warn(`${logPrefix} could not persist embedding cache`, {
			projectId,
			rows: freshRows.length,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	logger.info(`${logPrefix} embeddings resolved`, {
		projectId,
		candidates: candidateTexts.length,
		reembedded: embedCandidates.length,
		fromCache: candidateTexts.length - staleCandidates.length,
		items: itemTexts.length,
		skippedStale,
	});

	// Shaped as the shared `CandidateStory`, so `selectCandidates` consumes it
	// unchanged.
	const candidateVectors = candidateTexts.flatMap((entry) => {
		const embedding = embeddingByStoryId.get(entry.story.id);
		return embedding
			? [
					{
						id: entry.story.id,
						identifier: entry.story.identifier,
						embedding,
					},
				]
			: [];
	});
	// Expected to fall short by exactly `skippedStale` when the caller capped
	// inline re-embeds; anything else means a vector silently went missing,
	// which presents as "the judge got it wrong" rather than "a vector was
	// absent" and must never pass unremarked.
	if (candidateVectors.length !== candidateTexts.length - skippedStale) {
		logger.warn(`${logPrefix} candidates missing vectors`, {
			projectId,
			expected: candidateTexts.length - skippedStale,
			resolved: candidateVectors.length,
		});
	}
	const storyById = new Map(candidateTexts.map((e) => [e.story.id, e.story]));
	const textByStoryId = new Map(
		candidateTexts.map((e) => [e.story.id, e.text]),
	);

	return {
		kind: "ready",
		itemEmbeddings,
		candidateVectors,
		storyById,
		textByStoryId,
		skippedStale,
	};
}

export type RoutingModels = {
	judge: {
		model: Awaited<ReturnType<typeof getAIModelWithMetadata>>["model"];
		metadata: Awaited<
			ReturnType<typeof getAIModelWithMetadata>
		>["metadata"];
		trackUsage: () => void;
	};
	/** Optional typed decision model. Null means no organization-owned Vercel
	 * Gateway decision model is configured — every item judges through the
	 * language model. */
	decisionModel: Awaited<
		ReturnType<typeof getAIDecisionModelWithMetadata>
	> | null;
};

/**
 * Resolve the two models a routing call needs: the COMPLEX language judge
 * (required — thrown on failure, for the same "wholesale failure" treatment as
 * `loadRoutingCorpus`) and the optional typed decision model (never thrown;
 * unavailability degrades to language-judge-only).
 */
export async function resolveRoutingModels(params: {
	userId: string;
	organizationId?: string;
	projectId: string;
	logPrefix: string;
}): Promise<RoutingModels> {
	const { userId, organizationId, projectId, logPrefix } = params;

	// COMPLEX, matching `detect-duplicate-stories.ts`: the SIMPLE tier does not
	// reliably satisfy a `generateObject` schema in the worker runtime, and a
	// verdict that never parses would route everything to Create while looking
	// like a clean evaluation.
	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{ userId, organizationId, featureKey: "backlog-update" },
	);

	// Optional typed decision model. It is a fast path, not a dependency: an
	// organization without an organization-owned Vercel Gateway decision model
	// — or any other resolution failure — judges every item with the language
	// model exactly as it does today. This must never become a wholesale
	// failure, which would stamp an error state on a call that can still be
	// evaluated perfectly well.
	let decisionModel: Awaited<
		ReturnType<typeof getAIDecisionModelWithMetadata>
	> | null = null;
	try {
		decisionModel = await getAIDecisionModelWithMetadata({
			userId,
			organizationId,
			projectId,
		});
	} catch (error) {
		decisionModel = null;
		logger.info(
			`${logPrefix} no decision model — judging every item with the language model`,
			{
				projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}

	return { judge: { model, metadata, trackUsage }, decisionModel };
}

export type RoutingJudgement =
	| {
			kind: "create";
			confidence: number;
			reasoning: string | null;
			alternatives: RoutingAlternative[];
			source?: "decision_evaluation" | "language_model";
			/** An identifier the language judge named that was not on the
			 * shortlist — worth surfacing as the signature of a drifting judge
			 * prompt, never as an address for some other row. */
			unmatchedTarget?: string;
	  }
	| {
			kind: "enrich";
			confidence: number;
			reasoning: string | null;
			target: RoutingAlternative;
			alternatives: RoutingAlternative[];
			source?: "decision_evaluation" | "language_model";
	  }
	| { kind: "failed"; alternatives: RoutingAlternative[]; error: string };

export interface JudgeRoutingItemParams {
	/** Detection-style text for the item being judged — the SAME text that was
	 * embedded into `itemEmbedding` by `loadRoutingCorpus`. */
	itemText: string;
	analyzerReasoning?: string | null;
	itemEmbedding: number[];
	candidateVectors: CandidateStory[];
	storyById: Map<string, CorpusStory>;
	textByStoryId: Map<string, string>;
	judge: RoutingModels["judge"];
	decisionModel: RoutingModels["decisionModel"];
	/** Confidence an enrichment must clear, on EITHER judgement path. */
	threshold: number;
	userId: string;
	organizationId?: string;
	projectId: string;
	/** For logging only. */
	title?: string;
	logPrefix: string;
	/** Called immediately before the language judge's `generateObject` call —
	 * the Temporal activity's extra heartbeat for a decision evaluation that
	 * ran its full timeout before falling through. Omitted by the API caller. */
	onBeforeLanguageJudge?: () => void;
	/** Optional abort signal for the language judge only — the decision fast
	 * path already carries its own fixed timeout. An interactive caller uses
	 * this for its overall request budget; the Temporal activity omits it. */
	abortSignal?: AbortSignal;
}

/**
 * Judge one item against the loaded corpus. NEVER throws: every failure,
 * including `AiUsageLimitExceededError`, resolves to a `"failed"` judgement
 * rather than propagating — see the module doc for why a usage limit must not
 * fall through to a retry instead.
 */
export async function judgeRoutingItem(
	params: JudgeRoutingItemParams,
): Promise<RoutingJudgement> {
	const {
		itemText,
		analyzerReasoning,
		itemEmbedding,
		candidateVectors,
		storyById,
		textByStoryId,
		judge,
		decisionModel,
		threshold,
		userId,
		organizationId,
		projectId,
		title,
		logPrefix,
		onBeforeLanguageJudge,
		abortSignal,
	} = params;

	// The SAME shortlist the meeting-digest linker uses: same cosine floor,
	// same per-item cap, same ranking.
	const shortlist = selectCandidates(itemEmbedding, candidateVectors);

	// The ranked shortlist is retained whatever the verdict — an override
	// picker offers it as "suggested tickets".
	const alternatives: RoutingAlternative[] = shortlist.flatMap((scored) => {
		const story = storyById.get(scored.storyId);
		return story
			? [
					{
						storyId: story.id,
						identifier: story.identifier,
						title: story.title,
						similarity: scored.similarity,
					},
				]
			: [];
	});

	if (shortlist.length === 0) {
		return {
			kind: "create",
			confidence: 1,
			reasoning:
				"No existing ticket was semantically close enough to consider.",
			alternatives,
		};
	}

	try {
		// Built once: the rendered judge prompt and the decision evaluation's
		// target criteria must describe the same shortlist.
		const judgeCandidates: RoutingJudgeCandidate[] = alternatives.map(
			(alt) => ({
				identifier: alt.identifier,
				title: alt.title,
				content: textByStoryId.get(alt.storyId) ?? alt.title,
			}),
		);
		const prompt = await resolveJudgePrompt({
			userId,
			organizationId,
			actionItem: itemText,
			reasoning: analyzerReasoning,
			candidates: judgeCandidates,
			logPrefix,
		});

		// Typed decision fast path. Runs on the SAME rendered prompt the
		// language judge would have received, so an operator's bound judge
		// wording still governs the verdict, and asks both questions in one
		// evaluation over one shared state so the target is chosen against the
		// same reading of the item as the create/enrich call.
		if (decisionModel) {
			const fastPath = await evaluateRouting({
				decisionModel,
				prompt,
				actionItem: itemText,
				analyzerReasoning,
				candidates: judgeCandidates,
				threshold,
				projectId,
				title,
				logPrefix,
			});
			if (fastPath?.decision === "create") {
				return {
					kind: "create",
					confidence: fastPath.confidence,
					// A typed evaluation returns a choice and a distribution,
					// not written evidence. Leave this null rather than
					// inventing a rationale.
					reasoning: null,
					alternatives,
					source: "decision_evaluation",
				};
			}
			if (fastPath?.decision === "enrich") {
				const target = alternatives.find(
					(alt) => alt.identifier === fastPath.targetIdentifier,
				);
				// `acceptDecisionEvaluation` already resolved the choice
				// against this shortlist, so this cannot miss — but a
				// judgement built against `undefined` would address the wrong
				// row, so never assert it.
				if (target) {
					return {
						kind: "enrich",
						confidence: fastPath.confidence,
						reasoning: null,
						target,
						alternatives,
						source: "decision_evaluation",
					};
				}
			}
		}

		// A ceiling, not a target: the verdict is a handful of fields and a
		// capped sentence, so this never binds in practice. It exists because
		// an unbounded generation fails as a HANG rather than an error.
		// Guarded on `metadata` because the clamp dereferences it.
		const maxOutputTokens = judge.metadata
			? computeScaledOutputTokenBudget(judge.metadata, {
					inputChars: itemText.length,
					promptChars: prompt.length,
				})
			: undefined;
		onBeforeLanguageJudge?.();
		const { object: verdict } = await generateObject({
			model: judge.model,
			schema: RoutingVerdictSchema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(abortSignal ? { abortSignal } : {}),
		});
		judge.trackUsage();

		// Resolve the model's identifier against the shortlist it was shown. A
		// value that is not on that list is a hallucination, not a target.
		const target =
			verdict.decision === "enrich" && verdict.targetIdentifier
				? alternatives.find(
						(alt) =>
							alt.identifier.toLowerCase() ===
							verdict.targetIdentifier?.trim().toLowerCase(),
					)
				: undefined;

		if (target && verdict.confidence >= threshold) {
			return {
				kind: "enrich",
				confidence: verdict.confidence,
				reasoning: verdict.reasoning ?? null,
				target,
				alternatives,
				source: "language_model",
			};
		}

		return {
			kind: "create",
			confidence: verdict.confidence,
			reasoning: verdict.reasoning ?? null,
			alternatives,
			source: "language_model",
			// A model that named a ticket we could not match is worth seeing in
			// the logs — it is the signature of a drifting judge prompt.
			unmatchedTarget:
				verdict.decision === "enrich" && !target
					? (verdict.targetIdentifier ?? "(null)")
					: undefined,
		};
	} catch (error) {
		// Contained to this item: it resolves to a failed judgement carrying
		// the error, so the caller can say the evaluation failed rather than
		// implying the item was judged net-new. This is also where a
		// usage-limit rejection from the decision fast path lands — it must
		// not retry through the language judge below.
		logger.warn(`${logPrefix} judge failed for one item`, {
			projectId,
			title,
			error: error instanceof Error ? error.message : String(error),
			modelText: (error as { text?: string })?.text?.slice(0, 300),
		});
		return {
			kind: "failed",
			alternatives,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
