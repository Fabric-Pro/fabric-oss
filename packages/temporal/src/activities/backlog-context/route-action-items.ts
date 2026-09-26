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
 * The corpus/embedding/cache stage, the judge/decision-model resolution and the
 * per-item judgement live in the shared
 * `packages/temporal/src/lib/backlog-routing-core.ts` — the same core the
 * interactive roadmap duplicate check (Fizzy #2180) calls from `packages/api`.
 * This activity keeps only what is genuinely its own: the project opt-in
 * check, the per-run item cap and its overflow stamps, heartbeated batching,
 * and turning a judgement into a rewritten `ChangeProposal` row.
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
	buildDetectionText,
	db,
	type listActiveStoriesForDetection,
	routingConfidenceThreshold,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import {
	judgeRoutingItem,
	loadRoutingCorpus,
	type RoutingAlternative,
	resolveRoutingModels,
} from "../../lib/backlog-routing-core";
import type { ChangeProposal } from "./analyze-context";

/** Prefix for every log message this activity emits. */
const LOG_PREFIX = "[ActionItemRouting]";

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
			`${LOG_PREFIX} could not read the project opt-in — skipping routing`,
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

	// The SAME loader, text, cache and embedding stage the duplicate scan, the
	// meeting-digest linker and the interactive duplicate check share.
	let corpus: Awaited<ReturnType<typeof loadRoutingCorpus>>;
	try {
		corpus = await loadRoutingCorpus({
			projectId,
			userId,
			organizationId,
			itemTexts,
			logPrefix: LOG_PREFIX,
			// A cold cache on a large backlog embeds in several sequential
			// requests, and the analyzer's heartbeat interval was cleared before
			// this ran — so without this the embedding pass alone can outlast
			// the two-minute heartbeat timeout. Temporal would then retry the
			// whole activity, discarding an LLM proposal that had already
			// succeeded, which no in-process catch can prevent.
			onEmbedProgress: (done, total) =>
				heartbeat(`routeActionItems: embedding ${done}/${total}`),
		});
	} catch (error) {
		return allFailed(changes, routableIndexes, projectId, error);
	}

	// An empty backlog is a legitimate, fully-evaluated outcome — every routable
	// item is net-new, cap included: no judge call was going to be made for any
	// of them regardless of the per-run cap. Stamp the decision so the UI shows
	// "New ticket" as a considered classification rather than an unevaluated
	// default.
	if (corpus.kind === "empty") {
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

	let models: Awaited<ReturnType<typeof resolveRoutingModels>>;
	try {
		models = await resolveRoutingModels({
			userId,
			organizationId,
			projectId,
			logPrefix: LOG_PREFIX,
		});
	} catch (error) {
		return allFailed(changes, routableIndexes, projectId, error);
	}
	const { judge, decisionModel } = models;

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
		logger.warn(`${LOG_PREFIX} per-run cap hit — overflow unevaluated`, {
			projectId,
			cap: MAX_JUDGED,
			overflow: overflow.length,
		});
	}

	const judgeOne = async (offset: number, changeIndex: number) => {
		const change = routed[changeIndex];
		const judgement = await judgeRoutingItem({
			itemText: itemTexts[offset],
			analyzerReasoning: change.reasoning,
			itemEmbedding: corpus.itemEmbeddings[offset],
			candidateVectors: corpus.candidateVectors,
			storyById: corpus.storyById,
			textByStoryId: corpus.textByStoryId,
			judge,
			decisionModel,
			threshold,
			userId,
			organizationId,
			projectId,
			title: change.title?.to,
			logPrefix: LOG_PREFIX,
			// The batch heartbeat fired before the decision evaluation above,
			// which can take its full timeout before falling through. Signal
			// liveness again so the language judge starts with the whole
			// heartbeat window rather than whatever the evaluation left of it.
			onBeforeLanguageJudge: () =>
				heartbeat(
					`routeActionItems: language judge ${offset}/${judged.length}`,
				),
		});

		if (judgement.kind === "enrich") {
			routed[changeIndex] = buildEnrichedRow({
				change,
				target: judgement.target,
				story: corpus.storyById.get(judgement.target.storyId),
				confidence: judgement.confidence,
				reasoning: judgement.reasoning,
				alternatives: judgement.alternatives,
			});
			enriched += 1;
			logDecision(projectId, change.title?.to, {
				decision: "enrich",
				confidence: judgement.confidence,
				candidates: judgement.alternatives.length,
				matchedIdentifier: judgement.target.identifier,
				source: judgement.source,
			});
			return;
		}

		if (judgement.kind === "create") {
			routed[changeIndex] = {
				...change,
				routing: {
					decision: "create" as const,
					confidence: judgement.confidence,
					reasoning: judgement.reasoning,
					alternatives: judgement.alternatives,
					...capturedContent(change),
				},
			};
			created += 1;
			logDecision(projectId, change.title?.to, {
				decision: "create",
				confidence: judgement.confidence,
				candidates: judgement.alternatives.length,
				source: judgement.source,
				unmatchedTarget: judgement.unmatchedTarget,
			});
			return;
		}

		// Contained to this item: it stays a Create, carrying the error so the
		// review UI can say the evaluation failed rather than implying the item
		// was judged net-new.
		routed[changeIndex] = {
			...change,
			routing: {
				decision: "create" as const,
				confidence: 0,
				alternatives: judgement.alternatives,
				...capturedContent(change),
				error: judgement.error,
			},
		};
		failed += 1;
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

	logger.info(`${LOG_PREFIX} routing complete`, {
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
		`${LOG_PREFIX} evaluation unavailable — all items left as create`,
		{ projectId, items: routableIndexes.length, error: message },
	);
	const routed = [...changes];
	for (const index of routableIndexes) {
		// Per ITEM, not just per run: an operator asking "why was this item not
		// routed" has to be able to find that item in the log, not only a count.
		logger.warn(`${LOG_PREFIX} item left unevaluated`, {
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
	logger.info(`${LOG_PREFIX} decision`, {
		projectId,
		actionItem: title?.slice(0, 200),
		...detail,
	});
}
