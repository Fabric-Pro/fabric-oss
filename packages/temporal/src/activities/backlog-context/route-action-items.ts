/**
 * Create-vs-Enrich routing for action items captured from ingested meeting
 * transcripts and monitored chat threads.
 *
 * The four capture-as-is analyzers (meeting transcript, Teams channel, Teams
 * chat, Slack channel) run `analyzeContextAndPropose` with
 * `allowUpdates: false`, so the model can only ever emit `action: "create"`.
 * That is the behaviour this pass refines: after the proposal is formed, each
 * proposed CREATE is evaluated against the project's active tickets, and one
 * that turns out to be additional detail on work already tracked is rewritten
 * into an `action: "update"` against that ticket. Nothing is committed — the
 * reviewer still approves, and can override the routing per item.
 *
 * Two stages, built from the SHARED matching pieces rather than private copies:
 *
 *  1. `buildDetectionText` over the whole ticket — description, acceptance
 *     criteria and, when the ticket is split, its parts — vectors cached in the
 *     same `StoryDuplicateEmbedding` table the duplicate scan and the
 *     meeting-digest linker use, then `selectCandidates` from
 *     `action-item-link-core` for the shortlist. Routing used to carry its own
 *     text builder, cosine floor, candidate cap and cache table; three matchers
 *     could therefore disagree about what a ticket is, and a shared cache would
 *     have thrashed between two different texts for the same story. Changing
 *     how matching behaves is now a single edit that reaches all of them.
 *  2. ONE judgement per action item over that shortlist, returning
 *     enrich-target-or-create plus a confidence. Enrich only at or above the
 *     confidence threshold; precision lives here.
 *
 *     When the organization has a typed decision model configured, that
 *     judgement is first attempted as a single `experimental_evaluate` call
 *     that asks for the create/enrich choice and its target ticket together,
 *     over the same rendered judge prompt the language judge would have seen.
 *     A confident create is taken on the routing answer alone; an enrich is
 *     taken only when the routing answer AND the target answer are confident.
 *     Everything else — no decision model configured, an uncertain or
 *     malformed answer, a target that was not on the shortlist, or any
 *     non-usage-limit decision error — falls through to the COMPLEX language
 *     judge, which stays the behaviour of record. A usage-limit error is
 *     contained as that item's error stamp, exactly as it is for the judge.
 *
 * Degradation contract: this pass NEVER throws. Routing is an enhancement over
 * a proposal that is already valid without it, and an ingest run must not fail
 * because embeddings or the judge were unavailable. A wholesale failure leaves
 * every item a Create and stamps `routing.error` so the review UI can show the
 * NFR-required error state instead of silently presenting unrouted items as if
 * they had been evaluated. A single item's judge failure is likewise contained
 * to that item.
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
	buildDetectionText,
	buildRoutingJudgePrompt,
	type CachedStoryEmbedding,
	db,
	detectionTextForStory,
	getBoundPromptForAgent,
	hashDetectionText,
	listActiveStoriesForDetection,
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	type RoutingJudgeCandidate,
	routingConfidenceThreshold,
	upsertStoryDuplicateEmbeddings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { generateEmbeddings } from "@repo/rag";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import { selectCandidates } from "../../lib/action-item-link-core";
import type { ChangeProposal } from "./analyze-context";

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
 * operator-tunable `routingConfidenceThreshold()` that already binds the
 * language judge — a decision model must not be able to enrich at a confidence
 * an operator has declared too low. Create needs only the decision floor,
 * because create is the safe direction and is what a fall-through would most
 * often produce anyway.
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
 * One decision evaluation for one action item. Returns the verdict when it is
 * confident enough to stand in for the language judge, and null whenever the
 * caller should fall through to it.
 *
 * Only `AiUsageLimitExceededError` escapes: a usage limit is the one decision
 * failure that must NOT be retried through the language judge, because doing so
 * would bill the very spend the limit refused. The per-item `catch` in
 * `judgeOne` turns it into that item's error stamp, so the pass still never
 * throws.
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
}): Promise<DecisionFastPath | null> {
	const { decisionModel, candidates, projectId, title } = params;

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
			"[ActionItemRouting] decision evaluation unavailable; using language judge",
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
			"[ActionItemRouting] decision evaluation was uncertain or malformed; using language judge",
			{ projectId, actionItem: title?.slice(0, 200) },
		);
	}
	return verdict;
}

/**
 * Whether this project has opted into Create-vs-Enrich routing.
 *
 * Read HERE rather than in each calling activity, for two reasons. The ingest
 * activities are otherwise free of a project read, and adding one to them cost
 * a real contract: the user-initiated meeting scan is specified to consult no
 * project flags at all. And this is the only place the answer is used, so a
 * caller cannot get it wrong.
 *
 * Deliberately uncached: a primary-key lookup is negligible beside the LLM
 * calls it gates, and a cached flag would keep routing running for up to a TTL
 * after someone switched it off — the one moment the switch matters most.
 * Missing project (deleted mid-run) reads as OFF.
 */
async function isActionItemRoutingEnabled(projectId: string): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { actionItemRoutingEnabled: true },
	});
	return project?.actionItemRoutingEnabled === true;
}

/**
 * The action item exactly as the analyzer proposed it, captured BEFORE routing
 * rewrites the row into an enrichment and before the structure-preserving pass
 * merges the body into the target ticket.
 *
 * Every routed row carries this, whichever way it was classified: it is what a
 * reviewer's override re-submits, and re-submitting a body that was already
 * merged into some other ticket is how one ticket's content ends up written
 * onto another.
 */
function capturedContent(change: ChangeProposal["changes"][number]) {
	return {
		proposedTitle: change.title?.to ?? null,
		proposedDescription: change.description?.to ?? null,
		proposedAcceptanceCriteria: change.acceptanceCriteria?.to ?? null,
	};
}

/** One entry of the ranked shortlist retained on every routed row. */
type RoutingAlternative = {
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
};

/**
 * The enrichment row, built once for both judgements.
 *
 * The decision fast path and the language judge must produce a byte-identical
 * row — the only difference between them is where `confidence` and `reasoning`
 * came from — so the shape lives here rather than in two copies that could
 * drift apart.
 */
function buildEnrichedRow(params: {
	change: ChangeProposal["changes"][number];
	target: RoutingAlternative;
	story:
		| Awaited<ReturnType<typeof listActiveStoriesForDetection>>[number]
		| undefined;
	confidence: number;
	reasoning: string | null;
	alternatives: RoutingAlternative[];
}): ChangeProposal["changes"][number] {
	const { change, target, story, confidence, reasoning, alternatives } =
		params;
	return {
		...change,
		action: "update" as const,
		existingId: target.storyId,
		existingIdentifier: target.identifier,
		// The reviewer is editing an EXISTING ticket now, so its title
		// stands. `from === to` means the diff view renders no title
		// change — FR10's "no existing content removed". The action
		// item's own wording is kept on `routing.proposedTitle` so the
		// reviewer can still see what was captured.
		title: { from: target.title, to: target.title },
		// `from` is filled with the true current body by
		// `structurePreserveUpdates`, which runs next and produces the
		// merged `to`. Seeding it here keeps the diff honest even if
		// that pass safe-holds.
		description: change.description
			? {
					from: story?.description ?? "",
					to: change.description.to,
				}
			: undefined,
		acceptanceCriteria: change.acceptanceCriteria
			? {
					from: story?.acceptanceCriteria ?? "",
					to: change.acceptanceCriteria.to,
				}
			: undefined,
		routing: {
			decision: "enrich" as const,
			confidence,
			matchedStoryId: target.storyId,
			matchedIdentifier: target.identifier,
			matchedTitle: target.title,
			reasoning,
			alternatives,
			...capturedContent(change),
		},
	};
}

/**
 * Hard cap on action items judged per run. Each judgement costs at most one
 * typed decision evaluation plus a COMPLEX LLM call — the language judge is
 * skipped only when the decision model answered confidently — inside an
 * activity whose workflows set a two-minute heartbeat timeout, so the cap plus
 * the batched heartbeat is what stops a long transcript stalling the worker.
 * Applied BEFORE embedding, so an item over the cap costs nothing.
 */
const MAX_JUDGED = 40;

/**
 * Agent key the routing judge's prompt is bound to in the prompt library.
 * Non-stage binding, so it resolves at documentType GENERAL with a null
 * storyKind — the same shape as the other operator-editable judges
 * (`security_scan_fp_judge`, `test_case_drafter`).
 */
const ROUTING_JUDGE_AGENT = "action_item_routing_judge";

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
 * degrade to the fallback, because failing an ingest over prompt resolution
 * would be a far worse outcome than using the shipped wording.
 */
async function resolveJudgePrompt(params: {
	userId: string;
	organizationId?: string;
	actionItem: string;
	reasoning?: string | null;
	candidates: RoutingJudgeCandidate[];
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
			logger.warn("[ActionItemRouting] judge prompt render failed", {
				error: rendered.error,
			});
			return fallback;
		}
		return rendered.rendered;
	} catch (error) {
		logger.warn("[ActionItemRouting] judge prompt binding unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return fallback;
	}
}

export type RouteActionItemsParams = {
	changes: ChangeProposal["changes"];
	projectId: string;
	userId: string;
	organizationId?: string;
};

export type RouteActionItemsResult = {
	changes: ChangeProposal["changes"];
	/** Items rewritten into an enrichment of an existing ticket. */
	enriched: number;
	/** Items evaluated and left as new-ticket creates. */
	created: number;
	/** Items whose evaluation failed and were left as creates with an error stamp. */
	failed: number;
};

/**
 * Evaluate every proposed CREATE against the project's active tickets and
 * rewrite the genuine matches into enrichments. Returns the (new) changes array
 * plus per-outcome counts. Never throws.
 */
export async function routeActionItemsToExistingTickets(
	params: RouteActionItemsParams,
): Promise<RouteActionItemsResult> {
	const { changes, projectId, userId, organizationId } = params;

	// Project opt-in. Checked before anything else so a project that has not
	// enabled routing pays nothing beyond this one indexed lookup, and its
	// proposal comes back byte-identical to today's — no routing stamps at all,
	// so the review row renders exactly as it always has.
	//
	// Wrapped like every other await in this pass: a DB blip on a lookup this
	// trivial must not be the one thing that throws out of a function documented
	// never to, discarding an LLM proposal that had already succeeded. Unknown
	// reads as opted-out, which is the no-op direction.
	try {
		if (!(await isActionItemRoutingEnabled(projectId))) {
			return { changes, enriched: 0, created: 0, failed: 0 };
		}
	} catch (error) {
		logger.warn(
			"[ActionItemRouting] could not read the project opt-in — skipping routing",
			{
				projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return { changes, enriched: 0, created: 0, failed: 0 };
	}

	// Only creates are routable. An update the analyzer somehow produced already
	// names its target and is left alone.
	const routableIndexes = changes
		.map((change, index) => ({ change, index }))
		.filter(
			({ change }) =>
				change.action === "create" && !!change.title?.to?.trim(),
		)
		.map(({ index }) => index);

	if (routableIndexes.length === 0) {
		return { changes, enriched: 0, created: 0, failed: 0 };
	}

	// The SAME loader, text and cache the duplicate scan and the meeting-digest
	// linker use. Routing previously carried its own copy of all three, which
	// meant three matchers could silently disagree about what a ticket "is" —
	// and a shared cache keyed on content hash would have thrashed between
	// them. One text, one hash, one cache: a change to the flow now reaches
	// every matcher at once.
	let candidates: Awaited<ReturnType<typeof listActiveStoriesForDetection>>;
	try {
		candidates = await listActiveStoriesForDetection(projectId);
	} catch (error) {
		return allFailed(changes, routableIndexes, projectId, error);
	}

	const candidateTexts = candidates
		.map((story) => ({
			story,
			text: detectionTextForStory(story),
		}))
		.filter((entry) => entry.text.length > 0);

	// An empty backlog is a legitimate, fully-evaluated outcome — every item is
	// net-new. Stamp the decision so the UI shows "New ticket" as a considered
	// classification rather than an unevaluated default.
	if (candidateTexts.length === 0) {
		const routed = [...changes];
		for (const index of routableIndexes) {
			routed[index] = {
				...routed[index],
				routing: {
					decision: "create" as const,
					confidence: 1,
					reasoning: "No existing tickets in this project to enrich.",
					...capturedContent(routed[index]),
				},
			};
		}
		for (const index of routableIndexes) {
			logDecision(projectId, routed[index].title?.to, {
				decision: "create",
				confidence: 1,
				candidates: 0,
			});
		}
		return {
			changes: routed,
			enriched: 0,
			created: routableIndexes.length,
			failed: 0,
		};
	}

	// Cap BEFORE embedding. `judged` is what actually reaches the judge, so
	// embedding the whole routable set would pay for vectors the cap then
	// throws away.
	const judged = routableIndexes.slice(0, MAX_JUDGED);
	const overflow = routableIndexes.slice(MAX_JUDGED);

	const itemTexts = judged.map((index) =>
		buildDetectionText(
			changes[index].title?.to ?? "",
			changes[index].description?.to,
			changes[index].acceptanceCriteria?.to,
		),
	);

	// Candidate vectors come from the cache wherever they are still valid.
	//
	// Without this the pass re-embeds every active ticket in the project on
	// EVERY ingestion run, and routing runs far more often than the duplicate
	// scan that already hit this wall (a five-minute gateway timeout on a
	// ~350-ticket backlog, which is why that pass grew the same cache): once
	// per ingested transcript and once per monitored thread. A ticket is
	// re-embedded only when its routing text changed or the embedding model
	// did, so cosine is never computed across vectors from different models.
	let currentModel: string;
	try {
		const resolved = await resolveModelWithProvider("EMBEDDING", {
			userId,
			organizationId: organizationId ?? undefined,
		});
		currentModel = baseModelName(resolved.modelString);
	} catch (error) {
		return allFailed(changes, routableIndexes, projectId, error);
	}

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
		// A cache read failure must not fail routing: fall back to embedding
		// everything, which is exactly the pre-cache behaviour.
		logger.warn("[ActionItemRouting] embedding cache unavailable", {
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		embeddingByStoryId.clear();
	}

	// Derive what to embed from the vectors actually in hand, never from what
	// the metadata promised. The two cache reads are separate queries, so a row
	// deleted between them (story removed mid-run) would otherwise count as
	// cached, contribute no vector, and drop that ticket out of every shortlist
	// for the run — a silently missed enrichment. Deriving it here also makes
	// the `fromCache` figure below true by construction rather than by
	// agreement between two independent filters.
	const staleCandidates = candidateTexts.filter(
		(entry) => !embeddingByStoryId.has(entry.story.id),
	);

	let itemEmbeddings: number[][];
	const freshRows: CachedStoryEmbedding[] = [];
	try {
		const { embeddings, model } = await generateEmbeddings(
			[...itemTexts, ...staleCandidates.map((entry) => entry.text)],
			{ userId, organizationId, projectId },
			undefined,
			undefined,
			// A cold cache on a large backlog embeds in several sequential
			// requests, and the analyzer's heartbeat interval was cleared before
			// this ran — so without this the embedding pass alone can outlast the
			// two-minute heartbeat timeout. Temporal would then retry the whole
			// activity, discarding an LLM proposal that had already succeeded,
			// which no in-process catch can prevent. Same reasoning as the judge
			// loop below, which has heartbeated per batch since it was written.
			(done, total) =>
				heartbeat(`routeActionItems: embedding ${done}/${total}`),
		);
		itemEmbeddings = embeddings.slice(0, itemTexts.length);
		staleCandidates.forEach((entry, i) => {
			const vector = embeddings[itemTexts.length + i];
			embeddingByStoryId.set(entry.story.id, vector);
			freshRows.push({
				storyId: entry.story.id,
				contentHash: hashByStoryId.get(entry.story.id) ?? "",
				model,
				embedding: vector,
			});
		});
	} catch (error) {
		return allFailed(changes, routableIndexes, projectId, error);
	}

	// Best-effort write-back: a failure here costs the next run some
	// re-embedding, it does not make this run's routing wrong.
	try {
		await upsertStoryDuplicateEmbeddings(projectId, freshRows);
	} catch (error) {
		logger.warn("[ActionItemRouting] could not persist embedding cache", {
			projectId,
			rows: freshRows.length,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	logger.info("[ActionItemRouting] embeddings resolved", {
		projectId,
		candidates: candidateTexts.length,
		reembedded: staleCandidates.length,
		fromCache: candidateTexts.length - staleCandidates.length,
		items: itemTexts.length,
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
	// Unreachable while the embed set is derived from the map above, but a
	// shortlist quietly missing candidates presents as "the judge got it wrong"
	// rather than "a vector was absent", so it must never pass unremarked.
	if (candidateVectors.length !== candidateTexts.length) {
		logger.warn("[ActionItemRouting] candidates missing vectors", {
			projectId,
			expected: candidateTexts.length,
			resolved: candidateVectors.length,
		});
	}
	const storyById = new Map(candidateTexts.map((e) => [e.story.id, e.story]));
	const textByStoryId = new Map(
		candidateTexts.map((e) => [e.story.id, e.text]),
	);

	let model: Awaited<ReturnType<typeof getAIModelWithMetadata>>["model"];
	let metadata: Awaited<
		ReturnType<typeof getAIModelWithMetadata>
	>["metadata"];
	let trackUsage: () => void;
	try {
		// COMPLEX, matching `detect-duplicate-stories.ts`: the SIMPLE tier does
		// not reliably satisfy a `generateObject` schema in the worker runtime,
		// and a verdict that never parses would route everything to Create while
		// looking like a clean evaluation.
		const resolved = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{ userId, organizationId, featureKey: "backlog-update" },
		);
		model = resolved.model;
		metadata = resolved.metadata;
		trackUsage = resolved.trackUsage;
	} catch (error) {
		return allFailed(changes, routableIndexes, projectId, error);
	}

	// Optional typed decision model, resolved ONCE per run. It is a fast path,
	// not a dependency: an organization without an organization-owned Vercel
	// Gateway decision model — or any other resolution failure — judges every
	// item with the language model exactly as it does today. This must never
	// become an `allFailed`, which would stamp an error state on a proposal
	// that routing can still evaluate perfectly well.
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
			"[ActionItemRouting] no decision model — judging every item with the language model",
			{
				projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}

	const threshold = routingConfidenceThreshold();
	const routed = [...changes];
	let enriched = 0;
	let created = 0;
	let failed = 0;

	// Bound the work, exactly as the sibling `structurePreserveUpdates` pass
	// does. Each judgement costs at most a typed decision evaluation plus a
	// COMPLEX LLM call, inside an activity whose
	// workflows all set `heartbeatTimeout: "2 minutes"`, and the analyzer's own
	// heartbeat interval has already been cleared by the time this runs — so a
	// busy transcript's worth of sequential calls would let the heartbeat lapse
	// and get the worker killed mid-run, failing an ingest whose analysis had
	// already succeeded. Limited concurrency also cuts wall-clock, which is what
	// the card's "no perceptible delay" requirement actually turns on.
	const CONCURRENCY = 4;

	// Overflow is reported, never silently dropped: an unevaluated item that
	// looked like a considered "this is new work" is exactly the false
	// reassurance the error state exists to prevent.
	for (const index of overflow) {
		routed[index] = {
			...routed[index],
			routing: {
				decision: "create" as const,
				confidence: 0,
				...capturedContent(routed[index]),
				error: `Only the first ${MAX_JUDGED} action items from this source were checked against existing tickets.`,
			},
		};
		failed += 1;
	}
	if (overflow.length > 0) {
		logger.warn(
			"[ActionItemRouting] per-run cap hit — overflow unevaluated",
			{
				projectId,
				cap: MAX_JUDGED,
				overflow: overflow.length,
			},
		);
	}

	const judgeOne = async (offset: number, changeIndex: number) => {
		const change = routed[changeIndex];
		// The SAME shortlist the meeting-digest linker uses: same cosine floor,
		// same per-item cap, same ranking. Routing carried a private copy of all
		// three, so the two action-item matchers could drift apart on what counts
		// as a candidate. This is the one place to change that behaviour now.
		const shortlist = selectCandidates(
			itemEmbeddings[offset],
			candidateVectors,
		);

		// The ranked shortlist is retained whatever the verdict — the review UI's
		// override picker offers it as "suggested tickets".
		const alternatives = shortlist.flatMap((scored) => {
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
			routed[changeIndex] = {
				...change,
				routing: {
					decision: "create" as const,
					confidence: 1,
					reasoning:
						"No existing ticket was semantically close enough to consider.",
					alternatives,
					...capturedContent(change),
				},
			};
			created += 1;
			logDecision(projectId, change.title?.to, {
				decision: "create",
				confidence: 1,
				candidates: 0,
			});
			return;
		}

		try {
			// Built once: the rendered judge prompt and the decision
			// evaluation's target criteria must describe the same shortlist.
			const judgeCandidates = alternatives.map((alt) => ({
				identifier: alt.identifier,
				title: alt.title,
				content: textByStoryId.get(alt.storyId) ?? alt.title,
			}));
			const prompt = await resolveJudgePrompt({
				userId,
				organizationId,
				actionItem: itemTexts[offset],
				reasoning: change.reasoning,
				candidates: judgeCandidates,
			});

			// Typed decision fast path. Runs on the SAME rendered prompt the
			// language judge would have received, so an operator's bound judge
			// wording still governs the verdict, and asks both questions in one
			// evaluation over one shared state so the target is chosen against
			// the same reading of the item as the create/enrich call.
			if (decisionModel) {
				const fastPath = await evaluateRouting({
					decisionModel,
					prompt,
					actionItem: itemTexts[offset],
					analyzerReasoning: change.reasoning,
					candidates: judgeCandidates,
					threshold,
					projectId,
					title: change.title?.to,
				});
				if (fastPath?.decision === "create") {
					routed[changeIndex] = {
						...change,
						routing: {
							decision: "create" as const,
							confidence: fastPath.confidence,
							// A typed evaluation returns a choice and a
							// distribution, not written evidence. Leave this
							// null rather than inventing a rationale; the
							// review UI already renders nothing for it.
							reasoning: null,
							alternatives,
							...capturedContent(change),
						},
					};
					created += 1;
					logDecision(projectId, change.title?.to, {
						decision: "create",
						confidence: fastPath.confidence,
						candidates: alternatives.length,
						source: "decision_evaluation",
					});
					return;
				}
				if (fastPath?.decision === "enrich") {
					const target = alternatives.find(
						(alt) => alt.identifier === fastPath.targetIdentifier,
					);
					// `acceptDecisionEvaluation` already resolved the choice
					// against this shortlist, so this cannot miss — but a row
					// rewritten against `undefined` would be a corrupted
					// ticket, so never assert it.
					if (target) {
						routed[changeIndex] = buildEnrichedRow({
							change,
							target,
							story: storyById.get(target.storyId),
							confidence: fastPath.confidence,
							reasoning: null,
							alternatives,
						});
						enriched += 1;
						logDecision(projectId, change.title?.to, {
							decision: "enrich",
							confidence: fastPath.confidence,
							candidates: alternatives.length,
							matchedIdentifier: target.identifier,
							source: "decision_evaluation",
						});
						return;
					}
				}
			}

			// A ceiling, not a target: the verdict is a handful of fields and a
			// capped sentence, so this never binds in practice. It exists because
			// an unbounded generation fails as a HANG rather than an error, and a
			// hung judge inside a heartbeated batch reads as a broken feature
			// rather than a slow one. Guarded on `metadata` because the clamp
			// dereferences it.
			const maxOutputTokens = metadata
				? computeScaledOutputTokenBudget(metadata, {
						inputChars: itemTexts[offset].length,
						promptChars: prompt.length,
					})
				: undefined;
			// The batch heartbeat fired before the decision evaluation above, which
			// can take its full timeout before falling through. Signal liveness
			// again so the language judge starts with the whole heartbeat window
			// rather than whatever the evaluation left of it.
			heartbeat(
				`routeActionItems: language judge ${offset}/${judged.length}`,
			);
			const { object: verdict } = await generateObject({
				model,
				schema: RoutingVerdictSchema,
				prompt,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			});
			trackUsage();

			// Resolve the model's identifier against the shortlist it was shown.
			// A value that is not on that list is a hallucination, not a target.
			const target =
				verdict.decision === "enrich" && verdict.targetIdentifier
					? alternatives.find(
							(alt) =>
								alt.identifier.toLowerCase() ===
								verdict.targetIdentifier?.trim().toLowerCase(),
						)
					: undefined;

			if (target && verdict.confidence >= threshold) {
				routed[changeIndex] = buildEnrichedRow({
					change,
					target,
					story: storyById.get(target.storyId),
					confidence: verdict.confidence,
					reasoning: verdict.reasoning ?? null,
					alternatives,
				});
				enriched += 1;
				logDecision(projectId, change.title?.to, {
					decision: "enrich",
					confidence: verdict.confidence,
					candidates: alternatives.length,
					matchedIdentifier: target.identifier,
					source: "language_model",
				});
				return;
			}

			routed[changeIndex] = {
				...change,
				routing: {
					decision: "create" as const,
					confidence: verdict.confidence,
					reasoning: verdict.reasoning ?? null,
					alternatives,
					...capturedContent(change),
				},
			};
			created += 1;
			logDecision(projectId, change.title?.to, {
				decision: "create",
				confidence: verdict.confidence,
				candidates: alternatives.length,
				source: "language_model",
				// A model that named a ticket we could not match is worth seeing in
				// the logs — it is the signature of a drifting judge prompt.
				unmatchedTarget:
					verdict.decision === "enrich" && !target
						? (verdict.targetIdentifier ?? "(null)")
						: undefined,
			});
		} catch (error) {
			// Contained to this item: it stays a Create, carrying the error so the
			// review UI can say the evaluation failed rather than implying the item
			// was judged net-new.
			routed[changeIndex] = {
				...change,
				routing: {
					decision: "create" as const,
					confidence: 0,
					alternatives,
					...capturedContent(change),
					error:
						error instanceof Error ? error.message : String(error),
				},
			};
			failed += 1;
			logger.warn("[ActionItemRouting] judge failed for one item", {
				projectId,
				title: change.title?.to,
				error: error instanceof Error ? error.message : String(error),
				modelText: (error as { text?: string })?.text?.slice(0, 300),
			});
		}
	};

	// `judged` is a PREFIX of `routableIndexes`, so a position within it is the
	// same offset that indexes `itemTexts` / `embeddings` — no lookup needed.
	for (let i = 0; i < judged.length; i += CONCURRENCY) {
		heartbeat(`routeActionItems: ${i}/${judged.length}`);
		await Promise.all(
			judged
				.slice(i, i + CONCURRENCY)
				.map((changeIndex, k) => judgeOne(i + k, changeIndex)),
		);
	}

	logger.info("[ActionItemRouting] routing complete", {
		projectId,
		evaluated: judged.length,
		unevaluated: overflow.length,
		enriched,
		created,
		failed,
		confidenceThreshold: threshold,
	});

	return { changes: routed, enriched, created, failed };
}

/**
 * Wholesale failure (candidate load, embeddings, or model resolution): leave
 * every routable item a Create and stamp the error so the review UI surfaces an
 * error state. The proposal itself is still valid and worth showing — refusing
 * to persist it would lose the meeting's content entirely.
 */
function allFailed(
	changes: ChangeProposal["changes"],
	routableIndexes: number[],
	projectId: string,
	error: unknown,
): RouteActionItemsResult {
	const message = error instanceof Error ? error.message : String(error);
	logger.error(
		"[ActionItemRouting] evaluation unavailable — all items left as create",
		{ projectId, items: routableIndexes.length, error: message },
	);
	const routed = [...changes];
	for (const index of routableIndexes) {
		// Per ITEM, not just per run: an operator asking "why was this item not
		// routed" has to be able to find that item in the log, not only a count.
		logger.warn("[ActionItemRouting] item left unevaluated", {
			projectId,
			actionItem: changes[index].title?.to?.slice(0, 200),
			error: message,
		});
		routed[index] = {
			...routed[index],
			routing: {
				decision: "create" as const,
				confidence: 0,
				...capturedContent(routed[index]),
				error: message,
			},
		};
	}
	return {
		changes: routed,
		enriched: 0,
		created: 0,
		failed: routableIndexes.length,
	};
}

/**
 * Per-item decision log. The card's observability NFR requires every routing
 * decision — classification, matched ticket, confidence — to be recorded for
 * audit and debugging.
 *
 * `source` distinguishes the two judgements that can produce a verdict, so a
 * shift in routing behaviour after an organization configures a decision model
 * is visible in the logs rather than inferred. It is absent for the decisions
 * that no model made at all: an empty backlog, and a shortlist that cleared
 * nothing.
 */
function logDecision(
	projectId: string,
	title: string | undefined,
	detail: {
		decision: "create" | "enrich";
		confidence: number;
		candidates: number;
		matchedIdentifier?: string;
		unmatchedTarget?: string;
		source?: "decision_evaluation" | "language_model";
	},
): void {
	logger.info("[ActionItemRouting] decision", {
		projectId,
		actionItem: title?.slice(0, 200),
		...detail,
	});
}
