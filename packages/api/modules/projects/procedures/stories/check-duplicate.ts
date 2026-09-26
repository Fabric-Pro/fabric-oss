import { ORPCError } from "@orpc/client";
import {
	AIProviderNotConfiguredError,
	hasProviderCredentials,
	resolveModelWithProvider,
} from "@repo/ai";
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
 *   - the language judge carries an overall time budget so a slow provider
 *     degrades this into an unchecked create rather than stalling the dialog;
 *   - THIS CHECK NEVER BLOCKS CREATION: any failure, timeout, or usage-limit
 *     rejection returns a "create" decision with `error` set, distinguishing
 *     "checked, found nothing" from "could not check" for the UI. Only an
 *     auth failure (no project access) still throws.
 */

const LOG_PREFIX = "[Duplicate Check]";

/** Cap on inline back-fill embedding per request, mirroring
 * `semantic-search.ts`'s `MAX_INLINE_EMBEDS` — bounds latency on a cold
 * backlog rather than blocking the dialog on it. */
const MAX_INLINE_EMBEDS = 200;

/** Overall budget for the language judge. The decision fast path already
 * carries its own fixed 10s timeout inside the shared core; this bounds the
 * COMPLEX `generateObject` fallback so a slow provider degrades the dialog
 * into an unchecked create rather than stalling it. */
const LANGUAGE_JUDGE_TIMEOUT_MS = 20_000;

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

export type CheckDuplicateResult = {
	decision: "create" | "enrich";
	confidence: number;
	matchedStoryId?: string;
	matchedIdentifier?: string;
	matchedTitle?: string;
	reasoning?: string | null;
	alternatives: CheckDuplicateAlternative[];
	error?: string;
};

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

function logDecision(
	projectId: string,
	detail: {
		decision: "create" | "enrich";
		confidence: number;
		candidates: number;
		matchedIdentifier?: string;
		source?: "decision_evaluation" | "language_model";
	},
): void {
	logger.info(`${LOG_PREFIX} decision`, {
		projectId,
		surface: "manual-create",
		...detail,
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
		}),
	)
	.handler(async ({ input, context }): Promise<CheckDuplicateResult> => {
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

		const unavailable = (error: string): CheckDuplicateResult => ({
			decision: "create",
			confidence: 0,
			alternatives: [],
			error,
		});

		// A tenant with no configured embedding provider is not a server
		// error and not this check's private problem — it simply could not
		// run. `resolveModelWithProvider` does NOT throw when nothing
		// resolves; it returns `{ apiKey: null, _error }` (see
		// `semantic-search.ts`), so this has to be checked explicitly rather
		// than left to a downstream throw.
		try {
			const resolved = await resolveModelWithProvider("EMBEDDING", {
				userId: user.id,
				organizationId,
			});
			if (!hasProviderCredentials(resolved)) {
				logger.info(`${LOG_PREFIX} no embedding provider configured`, {
					projectId,
				});
				return unavailable(UNAVAILABLE_MESSAGE);
			}
		} catch (error) {
			logger.warn(`${LOG_PREFIX} embedding model resolution failed`, {
				projectId,
				error: error instanceof Error ? error.message : String(error),
			});
			return unavailable(UNAVAILABLE_MESSAGE);
		}

		let corpus: Awaited<ReturnType<typeof loadRoutingCorpus>>;
		try {
			corpus = await loadRoutingCorpus({
				projectId,
				userId: user.id,
				organizationId,
				itemTexts: [itemText],
				logPrefix: LOG_PREFIX,
				maxStaleEmbeds: MAX_INLINE_EMBEDS,
			});
		} catch (error) {
			if (error instanceof AIProviderNotConfiguredError) {
				return unavailable(UNAVAILABLE_MESSAGE);
			}
			logger.warn(`${LOG_PREFIX} could not load the routing corpus`, {
				projectId,
				error: error instanceof Error ? error.message : String(error),
			});
			return unavailable(UNAVAILABLE_MESSAGE);
		}

		if (corpus.kind === "empty") {
			logDecision(projectId, {
				decision: "create",
				confidence: 1,
				candidates: 0,
			});
			return { decision: "create", confidence: 1, alternatives: [] };
		}

		let models: Awaited<ReturnType<typeof resolveRoutingModels>>;
		try {
			models = await resolveRoutingModels({
				userId: user.id,
				organizationId,
				projectId,
				logPrefix: LOG_PREFIX,
			});
		} catch (error) {
			logger.warn(`${LOG_PREFIX} could not resolve the judge model`, {
				projectId,
				error: error instanceof Error ? error.message : String(error),
			});
			return unavailable(UNAVAILABLE_MESSAGE);
		}

		const judgement = await judgeRoutingItem({
			itemText,
			// The dialog captures no reasoning of its own; tell the judge how
			// this item was captured through the SAME `reasoning` parameter
			// the judge prompt already renders as "Why it was captured: …" —
			// never forking the prompt for this surface.
			analyzerReasoning: "Entered manually as a new roadmap work item.",
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
			abortSignal: AbortSignal.timeout(LANGUAGE_JUDGE_TIMEOUT_MS),
		});

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
			logDecision(projectId, {
				decision: "enrich",
				confidence: judgement.confidence,
				candidates: judgement.alternatives.length,
				matchedIdentifier: judgement.target.identifier,
				source: judgement.source,
			});
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

		logDecision(projectId, {
			decision: "create",
			confidence: judgement.confidence,
			candidates: judgement.alternatives.length,
			source: judgement.source,
		});
		return {
			decision: "create",
			confidence: judgement.confidence,
			reasoning: judgement.reasoning,
			alternatives: judgement.alternatives,
		};
	});
