/**
 * Roadmap Recommendation Workflow (Fizzy #2208)
 *
 * Runs on the `ai-chat` task queue with a deterministic per-project id
 * (`roadmap-recommendation-${projectId}`) so a double-click never starts two
 * runs.
 *
 *   1. gatherRoadmapRecommendationContext — RAG + live Roadmap + description
 *   2. analyzeContextAndPropose           — `recommend` intake mode
 *   3. persistRoadmapRecommendations      — ONE ROADMAP_RECOMMENDATION batch
 *
 * Nothing is written to the Roadmap here; Features are created only when a
 * reviewer accepts candidates in the inbox (backlogApplyChangesWorkflow).
 */

import {
	defineQuery,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type { analyzeContextAndPropose as AnalyzeContextAndProposeFn } from "../activities/backlog-context/analyze-context";
import type {
	gatherRoadmapRecommendationContext as GatherRoadmapRecommendationContextFn,
	persistRoadmapRecommendations as PersistRoadmapRecommendationsFn,
	RoadmapRecommendationEntryPoint,
} from "../activities/roadmap-recommendation";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

// =============================================================================
// Types
// =============================================================================

export interface RoadmapRecommendationInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	entryPoint: RoadmapRecommendationEntryPoint;
	requestedAt: string;
}

export type RoadmapRecommendationOutcome =
	| "GENERATED"
	| "NO_RECOMMENDATIONS"
	| "INSUFFICIENT_CONTEXT";

export type RoadmapRecommendationPhase =
	| "gathering"
	| "generating"
	| "persisting"
	| "completed"
	| "failed";

export interface RoadmapRecommendationProgress {
	status: RoadmapRecommendationPhase;
	entryPoint: RoadmapRecommendationEntryPoint;
	outcome?: RoadmapRecommendationOutcome;
	proposalId?: string;
	changeCount?: number;
}

export interface RoadmapRecommendationOutput {
	outcome: RoadmapRecommendationOutcome;
	entryPoint: RoadmapRecommendationEntryPoint;
	proposalId: string | null;
	changeCount: number;
}

// =============================================================================
// Queries
// =============================================================================

export const roadmapRecommendationProgressQuery =
	defineQuery<RoadmapRecommendationProgress>("roadmapRecommendationProgress");

// =============================================================================
// Activity proxies
// =============================================================================

const { gatherRoadmapRecommendationContext } = proxyActivities<{
	gatherRoadmapRecommendationContext: typeof GatherRoadmapRecommendationContextFn;
}>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { analyzeContextAndPropose } = proxyActivities<{
	analyzeContextAndPropose: typeof AnalyzeContextAndProposeFn;
}>({
	// A 25+ item batch takes longer to generate than a regular AI Update.
	startToCloseTimeout: "600 seconds",
	heartbeatTimeout: "120 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

const { persistRoadmapRecommendations } = proxyActivities<{
	persistRoadmapRecommendations: typeof PersistRoadmapRecommendationsFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// =============================================================================
// Workflow
// =============================================================================

const REQUEST_BY_ENTRY_POINT: Record<RoadmapRecommendationEntryPoint, string> =
	{
		EMPTY_ROADMAP:
			"The Roadmap is empty. Recommend the Features this project should start with, grounded in its context.",
		MATURE_ROADMAP:
			"Recommend the Features missing from this project's Roadmap, grounded in its context.",
		DO_BOTH_AFTER_PULL:
			"The Roadmap was just pulled from the team's PM tool. Recommend the Features missing from it, grounded in the project's context.",
	};

export async function roadmapRecommendationWorkflow(
	input: RoadmapRecommendationInput,
): Promise<RoadmapRecommendationOutput> {
	const { projectId, userId, organizationId, entryPoint, requestedAt } =
		input;

	const progress: RoadmapRecommendationProgress = {
		status: "gathering",
		entryPoint,
	};
	setHandler(roadmapRecommendationProgressQuery, () => progress);

	try {
		const gathered = await gatherRoadmapRecommendationContext({
			projectId,
			userId,
			organizationId,
		});

		if (gathered.insufficient) {
			progress.status = "completed";
			progress.outcome = "INSUFFICIENT_CONTEXT";
			return {
				outcome: "INSUFFICIENT_CONTEXT",
				entryPoint,
				proposalId: null,
				changeCount: 0,
			};
		}

		progress.status = "generating";
		const proposal = await analyzeContextAndPropose({
			projectId,
			userId,
			organizationId,
			fetchedContext: gathered.fetchedContext,
			existingBacklog: gathered.existingBacklog,
			userPrompt: REQUEST_BY_ENTRY_POINT[entryPoint],
			intakeMode: "recommend",
			allowUpdates: false,
			allowRouting: false,
			deferDecisionPrecheck: true,
		});

		progress.status = "persisting";
		const { workflowId, runId } = workflowInfo();
		const persisted = await persistRoadmapRecommendations({
			projectId,
			userId,
			organizationId,
			entryPoint,
			requestedAt,
			workflowId,
			runId,
			proposal,
			stats: gathered.stats,
		});

		progress.status = "completed";
		progress.outcome = persisted.outcome;
		progress.changeCount = persisted.changeCount;
		if (persisted.proposalId) {
			progress.proposalId = persisted.proposalId;
		}
		return {
			outcome: persisted.outcome,
			entryPoint,
			proposalId: persisted.proposalId,
			changeCount: persisted.changeCount,
		};
	} catch (error) {
		progress.status = "failed";
		throw error;
	}
}
