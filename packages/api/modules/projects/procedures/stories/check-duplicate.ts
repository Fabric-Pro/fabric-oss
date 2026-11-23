import { ORPCError } from "@orpc/client";
import {
	AIProviderNotConfiguredError,
	hasProviderCredentials,
	resolveModelWithProvider,
} from "@repo/ai";
import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
import {
	buildDetectionText,
	getProjectTenantId,
	hasProjectAccess,
	routingConfidenceThreshold,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	judgeRoutingItem,
	loadRoutingCorpus,
	resolveRoutingModels,
} from "@repo/temporal/backlog-routing-core";
import { z } from "zod";
import { RATE_LIMIT_PRESETS } from "../../../../lib/rate-limit";
import { INPUT_BOUNDS } from "../../../../lib/zod-bounds";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	MAX_INLINE_EMBEDS,
	startRequestDeadline,
} from "../../lib/duplicate-check-limits";
import {
	findProposalInboxMatches,
	type InboxMatchEntry,
	listInboxMatchEntries,
	type ManualEntryInboxMatches,
	manualEntry,
	manualEntryCorpusTexts,
} from "../../lib/proposal-duplicate-matching";
import type { ProposalInboxMatch } from "../../lib/proposal-duplicate-scoring";

/**
 * Duplicate-detection warning for the roadmap "Add" dialog's manual create
 * (Fizzy #2180) — NOT the feature-proposal review flow, which already carries
 * this check as `routeActionItemsToExistingTickets`. Both call the SAME
 * shared decision core in `@repo/temporal/backlog-routing-core`: the same
 * corpus/embedding-cache stage, the same judge and typed-decision-model
 * resolution, and the same per-item judgement. A change to how matching or
 * judging behaves reaches both surfaces at once.
 *
 * The interactive contract:
 *   - tenant auth (STORY_CREATE + project access), rate-limited like the
 *     other AI-cost endpoints — the tenant is derived from the
 *     ACCESS-CHECKED project row, never from `input.organizationId`, exactly
 *     as `semanticSearchProcedure` does;
 *   - the dialog has only a description (title and kind are AI-generated
 *     server-side on create), so the detection text's title segment is
 *     derived from the description's own first line rather than left blank
 *     (`buildDetectionText` returns "" without a title);
 *   - inline stale re-embeds are capped per request, mirroring
 *     `semantic-search.ts`'s `MAX_INLINE_EMBEDS`;
 *   - ONE request deadline, `DUPLICATE_CHECK_TIMEOUT_MS` after the auth
 *     check, bounds the whole embed-and-judge pipeline (not just the language
 *     judge): the handler races that work against the deadline, so a slow
 *     embedding provider, a stalled decision evaluation, or a stalled
 *     language judge all degrade this into an unchecked create rather than
 *     stalling the dialog. A DB read or `resolveModelWithProvider` call ahead
 *     of the first abortable step cannot itself be cancelled, so the race is
 *     what still bounds the RESPONSE even then — the abandoned call keeps
 *     running server-side, exactly as any other orphaned request would;
 *   - THIS CHECK NEVER BLOCKS CREATION: any failure, timeout, or usage-limit
 *     rejection returns a "create" decision with `error` set, distinguishing
 *     "checked, found nothing" from "could not check" for the UI. Only an
 *     auth failure (no project access) still throws;
 *   - `proposalMatches` lists unreviewed Proposal Inbox items the roadmap
 *     duplicate scan's candidate rule selects against the description and
 *     its verifier then confirms (see `proposal-duplicate-scoring.ts`).
 *     Their texts, and the Scope or acceptance-criteria sections both sides
 *     have, ride in the corpus's embedding request, so the description is
 *     embedded once. The list is settled under the same deadline, and its
 *     own failure only leaves it empty: it never changes the ticket result;
 *   - a typing prefetch (`verifyProposalMatches: false`) bills no inbox
 *     verification: it lists only the candidates a kept verdict confirmed
 *     and counts the rest in `unverifiedProposalMatches`, for the final
 *     check (blur or submit) to verify. Verdicts are kept for a day, so the
 *     final check bills only what no earlier check of the same text did;
 *   - the request's own abort signal joins the deadline, so an abandoned
 *     request stops its model calls.
 */

const LOG_PREFIX = "[Duplicate Check]";

/** Cap on the description's first line used as the detection text's title
 * segment — generous enough to carry real signal, short enough that a
 * one-paragraph description with no line breaks does not become the "title". */
const TITLE_SEGMENT_MAX_CHARS = 200;

const UNAVAILABLE_MESSAGE = "Could not check for similar work items right now.";

type CheckDuplicateAlternative = {
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
};

type CheckDuplicateResult = {
	decision: "create" | "enrich";
	confidence: number;
	matchedStoryId?: string;
	matchedIdentifier?: string;
	matchedTitle?: string;
	reasoning?: string | null;
	alternatives: CheckDuplicateAlternative[];
	error?: string;
	/** Similar unreviewed Proposal Inbox items, strongest first. */
	proposalMatches: ProposalInboxMatch[];
	/** Inbox candidates this check left for a verifying check to decide. */
	unverifiedProposalMatches: number;
};

/** The ticket half of the result, before the inbox matches are attached. */
type StoryCheckResult = Omit<
	CheckDuplicateResult,
	"proposalMatches" | "unverifiedProposalMatches"
>;

/**
 * The detection text's title segment, derived from the description's own
 * first non-empty line — the dialog collects only a description, and
 * `buildDetectionText` returns "" for a blank title, which would make the
 * whole item invisible to the shared cosine pre-filter.
 */
function deriveTitleSegment(description: string): string {
	const firstLine = description
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	return (firstLine ?? description.trim()).slice(0, TITLE_SEGMENT_MAX_CHARS);
}

/** Per-stage elapsed time, for the decision log and the deadline-exceeded
 * warn. Fields are filled in as each stage settles, so a log written before
 * every stage has run (an early failure, or the deadline firing) simply omits
 * whichever ones haven't happened yet. */
type StageTimings = {
	embeddingCheckMs?: number;
	corpusMs?: number;
	modelMs?: number;
	judgeMs?: number;
};

function logDecision(
	projectId: string,
	detail: {
		decision: "create" | "enrich";
		confidence: number;
		candidates: number;
		matchedIdentifier?: string;
		source?: "decision_evaluation" | "language_model";
	},
	ms: StageTimings & { totalMs: number },
): void {
	logger.info(`${LOG_PREFIX} decision`, {
		projectId,
		surface: "manual-create",
		...detail,
		...ms,
	});
}

export const checkDuplicateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_CREATE))
	// Spends provider money (an embedding, and usually a COMPLEX judge call) on
	// every dialog submission — cap it like the other AI-cost endpoints.
	.use(async ({ context, next, path }) => {
		await enforceAiRateLimit(context.user.id, path, RATE_LIMIT_PRESETS.ai);
		return await next();
	})
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/check-duplicate",
		tags: ["Projects", "Stories"],
		summary:
			"Check a manually entered description against existing work items",
		description:
			"Runs the same Create-vs-Enrich duplicate detection the feature-proposal review flow uses against one manually typed description, before it becomes a new roadmap item. Never blocks creation: any failure or timeout returns a create decision with `error` set.",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for shape parity with sibling procedures; the tenant used
			// for model/credit resolution is the ACCESS-CHECKED project's own,
			// never this caller-supplied value.
			organizationId: z.string().nullable().optional(),
			description: z.string().trim().min(1).max(INPUT_BOUNDS.text),
			// False for a prefetch while the user types: kept inbox verdicts
			// only, no verifier call. Omitted, the check verifies.
			verifyProposalMatches: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context, signal }) => {
		const user = context.user;
		const projectTenant = await getProjectTenantId(input.projectId);
		const canAccess =
			projectTenant !== null &&
			(await hasProjectAccess(input.projectId, user.id));
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const organizationId = projectTenant?.organizationId ?? undefined;
		const projectId = input.projectId;

		const description = input.description;
		const titleSegment = deriveTitleSegment(description);
		const itemText = buildDetectionText(titleSegment, description);
		const entry = manualEntry(itemText, description);

		const unavailable = (error: string): StoryCheckResult => ({
			decision: "create",
			confidence: 0,
			alternatives: [],
			error,
		});

		// ONE deadline for the whole pipeline below, not just the language
		// judge — see the module doc.
		const deadline = startRequestDeadline();
		// Every abortable step also stops when the caller abandons the
		// request (a newer prefetch, or the dialog closing).
		const pipelineSignal = signal
			? AbortSignal.any([deadline.signal, signal])
			: deadline.signal;
		const startedAt = Date.now();
		const stageTimings: StageTimings = {};
		let timedOut = false;
		const timeoutResult = deadline.expired.then((): StoryCheckResult => {
			timedOut = true;
			return unavailable(UNAVAILABLE_MESSAGE);
		});

		// The inbox items load beside the embedding check. A failed load or
		// match only empties the inbox list; it never changes the ticket
		// result. `inboxMatches` is replaced once the corpus has embedded
		// the inbox texts.
		const noInboxMatches: ManualEntryInboxMatches = {
			matches: [],
			unverified: 0,
		};
		const warnInboxFailed = (error: unknown) => {
			logger.warn(`${LOG_PREFIX} could not check the Proposal Inbox`, {
				projectId,
				error: error instanceof Error ? error.message : String(error),
			});
		};
		const inboxEntries = listInboxMatchEntries(
			projectId,
			pipelineSignal,
		).catch((error: unknown): InboxMatchEntry[] => {
			warnInboxFailed(error);
			return [];
		});
		let inboxMatches = Promise.resolve(noInboxMatches);

		const runCheck = async (): Promise<StoryCheckResult> => {
			// A tenant with no configured embedding provider is not a server
			// error and not this check's private problem — it simply could
			// not run. `resolveModelWithProvider` does NOT throw when
			// nothing resolves; it returns `{ apiKey: null, _error }` (see
			// `semantic-search.ts`), so this has to be checked explicitly
			// rather than left to a downstream throw.
			const embeddingCheckStart = Date.now();
			try {
				const resolved = await resolveModelWithProvider("EMBEDDING", {
					userId: user.id,
					organizationId,
				});
				if (!hasProviderCredentials(resolved)) {
					logger.info(
						`${LOG_PREFIX} no embedding provider configured`,
						{ projectId },
					);
					return unavailable(UNAVAILABLE_MESSAGE);
				}
			} catch (error) {
				logger.warn(`${LOG_PREFIX} embedding model resolution failed`, {
					projectId,
					error:
						error instanceof Error ? error.message : String(error),
				});
				return unavailable(UNAVAILABLE_MESSAGE);
			} finally {
				stageTimings.embeddingCheckMs =
					Date.now() - embeddingCheckStart;
			}

			// Corpus load and judge-model resolution depend on nothing from
			// each other, so they run concurrently rather than one after the
			// other — on the warm path this is most of the request's latency.
			const entries = await inboxEntries;
			const corpusModelsStart = Date.now();
			const corpusPromise = loadRoutingCorpus({
				projectId,
				userId: user.id,
				organizationId,
				itemTexts: manualEntryCorpusTexts(entry, entries),
				logPrefix: LOG_PREFIX,
				maxStaleEmbeds: MAX_INLINE_EMBEDS,
				abortSignal: pipelineSignal,
			}).finally(() => {
				stageTimings.corpusMs = Date.now() - corpusModelsStart;
			});
			const modelsPromise = resolveRoutingModels({
				userId: user.id,
				organizationId,
				projectId,
				logPrefix: LOG_PREFIX,
			}).finally(() => {
				stageTimings.modelMs = Date.now() - corpusModelsStart;
			});
			const [corpusOutcome, modelsOutcome] = await Promise.allSettled([
				corpusPromise,
				modelsPromise,
			]);

			if (corpusOutcome.status === "rejected") {
				const error = corpusOutcome.reason;
				if (error instanceof UnsupportedEmbeddingModelError) {
					return unavailable(error.message);
				}
				if (error instanceof AIProviderNotConfiguredError) {
					return unavailable(UNAVAILABLE_MESSAGE);
				}
				logger.warn(`${LOG_PREFIX} could not load the routing corpus`, {
					projectId,
					error:
						error instanceof Error ? error.message : String(error),
				});
				return unavailable(UNAVAILABLE_MESSAGE);
			}
			const corpus = corpusOutcome.value;
			inboxMatches = findProposalInboxMatches({
				projectId,
				userId: user.id,
				organizationId,
				entry,
				entries,
				corpus,
				verify: input.verifyProposalMatches ?? true,
				abortSignal: pipelineSignal,
			}).catch((error: unknown) => {
				warnInboxFailed(error);
				return noInboxMatches;
			});

			if (corpus.kind === "empty") {
				// A legitimate, fully-evaluated outcome regardless of whether
				// model resolution (run concurrently, for nothing) succeeded
				// — there was never going to be a judge call either way.
				logDecision(
					projectId,
					{ decision: "create", confidence: 1, candidates: 0 },
					{ ...stageTimings, totalMs: Date.now() - startedAt },
				);
				return { decision: "create", confidence: 1, alternatives: [] };
			}

			if (modelsOutcome.status === "rejected") {
				const error = modelsOutcome.reason;
				logger.warn(`${LOG_PREFIX} could not resolve the judge model`, {
					projectId,
					error:
						error instanceof Error ? error.message : String(error),
				});
				return unavailable(UNAVAILABLE_MESSAGE);
			}
			const models = modelsOutcome.value;

			const judgeStart = Date.now();
			const judgement = await judgeRoutingItem({
				itemText,
				// The dialog captures no reasoning of its own; tell the judge
				// how this item was captured through the SAME `reasoning`
				// parameter the judge prompt already renders as "Why it was
				// captured: …" — never forking the prompt for this surface.
				analyzerReasoning:
					"Entered manually as a new roadmap work item.",
				itemEmbedding: corpus.itemEmbeddings[0],
				candidateVectors: corpus.candidateVectors,
				storyById: corpus.storyById,
				textByStoryId: corpus.textByStoryId,
				judge: models.judge,
				decisionModel: models.decisionModel,
				threshold: routingConfidenceThreshold(),
				userId: user.id,
				organizationId,
				projectId,
				logPrefix: LOG_PREFIX,
				abortSignal: pipelineSignal,
			});
			stageTimings.judgeMs = Date.now() - judgeStart;

			if (judgement.kind === "failed") {
				logger.warn(`${LOG_PREFIX} judge failed`, {
					projectId,
					error: judgement.error,
				});
				return {
					decision: "create",
					confidence: 0,
					alternatives: judgement.alternatives,
					error: UNAVAILABLE_MESSAGE,
				};
			}

			if (judgement.kind === "enrich") {
				logDecision(
					projectId,
					{
						decision: "enrich",
						confidence: judgement.confidence,
						candidates: judgement.alternatives.length,
						matchedIdentifier: judgement.target.identifier,
						source: judgement.source,
					},
					{ ...stageTimings, totalMs: Date.now() - startedAt },
				);
				return {
					decision: "enrich",
					confidence: judgement.confidence,
					matchedStoryId: judgement.target.storyId,
					matchedIdentifier: judgement.target.identifier,
					matchedTitle: judgement.target.title,
					reasoning: judgement.reasoning,
					alternatives: judgement.alternatives,
				};
			}

			logDecision(
				projectId,
				{
					decision: "create",
					confidence: judgement.confidence,
					candidates: judgement.alternatives.length,
					source: judgement.source,
				},
				{ ...stageTimings, totalMs: Date.now() - startedAt },
			);
			return {
				decision: "create",
				confidence: judgement.confidence,
				reasoning: judgement.reasoning,
				alternatives: judgement.alternatives,
			};
		};

		const result = await Promise.race([runCheck(), timeoutResult]);
		const inbox = await Promise.race([
			inboxMatches,
			deadline.expired.then(() => noInboxMatches),
		]);
		deadline.clear();
		if (timedOut) {
			logger.warn(`${LOG_PREFIX} request deadline exceeded`, {
				projectId,
				deadlineMs: deadline.ms,
				...stageTimings,
				elapsedMs: Date.now() - startedAt,
			});
		}
		const response: CheckDuplicateResult = {
			...result,
			proposalMatches: inbox.matches,
			unverifiedProposalMatches: inbox.unverified,
		};
		return response;
	});
