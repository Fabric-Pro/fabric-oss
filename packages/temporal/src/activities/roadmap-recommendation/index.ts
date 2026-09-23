/**
 * Roadmap recommendation activities (Fizzy #2208).
 *
 * `gatherRoadmapRecommendationContext` reads what grounds a batch: the
 * project's RAG corpus, its live Roadmap and its description.
 * `persistRoadmapRecommendations` stores the analyzer's Feature-only output as
 * ONE `PendingBacklogProposal` row (source ROADMAP_RECOMMENDATION) in the
 * existing inbox. The row's id is the batch id stamped on every Feature
 * accepted from it.
 */

import {
	createRoadmapRecommendationBatchOnce,
	db,
	normalizeBacklogTitle,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type AnalyzeContextInput,
	type ChangeProposal,
	ROADMAP_RECOMMEND_PROMPT_VERSION,
} from "../backlog-context/analyze-context";
import { fetchBacklogSnapshot } from "../backlog-context/fetch-backlog-snapshot";
import { retrieveProjectRagContext } from "../backlog-context/fetch-context";

/**
 * Mirrors `MIN_GROUNDING_DESCRIPTION_LENGTH` in
 * `packages/api/modules/capabilities/thresholds.ts`, which the capability
 * gate uses for the same question; temporal cannot import from the API.
 */
const MIN_GROUNDING_DESCRIPTION_LENGTH = 250;

const RAG_QUERY = "product goals, users, requirements, features, roadmap";

export type RoadmapRecommendationEntryPoint =
	| "EMPTY_ROADMAP"
	| "MATURE_ROADMAP"
	| "DO_BOTH_AFTER_PULL";

export interface RoadmapRecommendationStats {
	ragChunkCount: number;
	roadmapItemCount: number;
	descriptionChars: number;
}

export interface GatherRoadmapRecommendationContextInput {
	projectId: string;
	userId: string;
	organizationId?: string;
}

export interface GatherRoadmapRecommendationContextOutput {
	fetchedContext: { ragContext?: string };
	existingBacklog: AnalyzeContextInput["existingBacklog"];
	stats: RoadmapRecommendationStats;
	/** True when nothing grounds a batch: no model call is made. */
	insufficient: boolean;
}

function isRecommendationContextInsufficient(
	stats: RoadmapRecommendationStats,
): boolean {
	return (
		stats.ragChunkCount === 0 &&
		stats.roadmapItemCount === 0 &&
		stats.descriptionChars < MIN_GROUNDING_DESCRIPTION_LENGTH
	);
}

export async function gatherRoadmapRecommendationContext(
	input: GatherRoadmapRecommendationContextInput,
): Promise<GatherRoadmapRecommendationContextOutput> {
	const { projectId, userId, organizationId } = input;

	const [rag, snapshot, project] = await Promise.all([
		retrieveProjectRagContext({
			projectId,
			query: RAG_QUERY,
			userId,
			organizationId,
			topK: 20,
		}),
		fetchBacklogSnapshot({ projectId }),
		db.project.findUnique({
			where: { id: projectId },
			select: { description: true },
		}),
	]);

	const description = project?.description?.trim() ?? "";
	const stats: RoadmapRecommendationStats = {
		ragChunkCount: rag.chunkCount,
		roadmapItemCount: snapshot.orphanStories.length,
		descriptionChars: description.length,
	};

	const ragContext = [
		description ? `### Project description\n\n${description}` : "",
		rag.formattedContext,
	]
		.filter((part) => part.length > 0)
		.join("\n\n");

	const insufficient = isRecommendationContextInsufficient(stats);
	logger.info("[RoadmapRecommendation] Context gathered", {
		projectId,
		...stats,
		insufficient,
	});

	return {
		fetchedContext: ragContext ? { ragContext } : {},
		existingBacklog: {
			stories: snapshot.orphanStories.map((s) => ({
				id: s.id,
				identifier: s.identifier,
				title: s.title,
				description: s.description,
				externalId: s.externalId,
			})),
		},
		stats,
		insufficient,
	};
}

export interface PersistRoadmapRecommendationsInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	entryPoint: RoadmapRecommendationEntryPoint;
	requestedAt: string;
	workflowId: string;
	runId: string;
	proposal: ChangeProposal;
	stats: RoadmapRecommendationStats;
}

export type PersistRoadmapRecommendationsOutput =
	| { outcome: "GENERATED"; proposalId: string; changeCount: number }
	| { outcome: "NO_RECOMMENDATIONS"; proposalId: null; changeCount: 0 };

/**
 * Keep only new Features and strip every field that would let a candidate
 * skip the Clean Spec draft at accept time. The prompt asks for exactly this;
 * the filter makes it hold whatever the model returns.
 *
 * Two candidates with the same title collapse to the first. Accept resolves a
 * change back to its stored index, and two identical titles would both
 * resolve to the first one, so the second could never be recorded and the
 * batch could never close. Each survivor is keyed `${runId}:${i}` so that
 * resolution never falls back to the title at all.
 */
function toRecommendedFeatures(
	changes: ChangeProposal["changes"],
	runId: string,
): ChangeProposal["changes"] {
	const seenTitles = new Set<string>();
	return changes
		.filter((c) => c.type === "feature" && c.action === "create")
		.filter((c) => {
			const title = normalizeBacklogTitle(c.title.to);
			if (seenTitles.has(title)) {
				return false;
			}
			seenTitles.add(title);
			return true;
		})
		.map(
			(
				{
					sourceRef: _sourceRef,
					predrafted: _predrafted,
					kindOverride: _kindOverride,
					deliveryTrack: _deliveryTrack,
					...change
				},
				i,
			) => ({
				...change,
				sourceContext: "multiple" as const,
				sourceChangeKey: `${runId}:${i}`,
			}),
		);
}

export async function persistRoadmapRecommendations(
	input: PersistRoadmapRecommendationsInput,
): Promise<PersistRoadmapRecommendationsOutput> {
	// Deterministic in the activity input, so a retry of an empty batch is
	// empty too and never needs the run's existing row.
	const changes = toRecommendedFeatures(input.proposal.changes, input.runId);
	if (changes.length === 0) {
		logger.info("[RoadmapRecommendation] No recommendations to persist", {
			projectId: input.projectId,
			proposedCount: input.proposal.changes.length,
		});
		return {
			outcome: "NO_RECOMMENDATIONS",
			proposalId: null,
			changeCount: 0,
		};
	}

	// Idempotent on the workflow run, and race-safe across overlapping
	// attempts: a retry after the row was written gets that row back instead
	// of creating a second batch.
	const proposal = JSON.parse(JSON.stringify({ ...input.proposal, changes }));
	const batch = await createRoadmapRecommendationBatchOnce({
		workflowRunId: input.runId,
		projectId: input.projectId,
		proposal,
		summary: `${changes.length} features recommended from project context`,
		changeCount: changes.length,
		sourceMetadata: {
			entryPoint: input.entryPoint,
			requestedByUserId: input.userId,
			requestedAt: input.requestedAt,
			workflowId: input.workflowId,
			workflowRunId: input.runId,
			generation: {
				generator: "analyzeContextAndPropose/recommend",
				promptVersion: ROADMAP_RECOMMEND_PROMPT_VERSION,
				flagKey: "ROADMAP_RECOMMENDATIONS",
			},
			contextSummary: input.proposal.contextSummary ?? null,
			contextSources: { ...input.stats },
			// FR43: an accepted batch is not pushed to PM unless the reviewer
			// opts in at accept time.
			syncToPM: false,
		},
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!batch.created) {
		return {
			outcome: "GENERATED",
			proposalId: batch.id,
			changeCount: batch.changeCount,
		};
	}

	logger.info("[RoadmapRecommendation] Batch persisted", {
		projectId: input.projectId,
		proposalId: batch.id,
		changeCount: changes.length,
		entryPoint: input.entryPoint,
	});

	return {
		outcome: "GENERATED",
		proposalId: batch.id,
		changeCount: changes.length,
	};
}
