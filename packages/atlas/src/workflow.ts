/**
 * Shared contract for the background analysis workflow. Lives in the package so
 * the facade (which builds the start plan) and the Temporal workflow/activities
 * (which consume it) reference one source of truth.
 */
import type { AtlasStatus } from "./types";

/**
 * Dedicated task queue (and worker) for Atlas. Kept separate from
 * the shared `code-indexing` queue so the heavy clone/parse runs on its own
 * concurrency-capped worker AND so a foreign/stale worker polling a shared queue
 * can never grab (and fail) these activities. Must match the worker registered
 * in `@repo/temporal`'s `worker.ts`.
 */
export const ATLAS_TASK_QUEUE = "atlas";
export const ATLAS_WORKFLOW = "atlasWorkflow";

export interface AtlasWorkflowInput {
	analysisId: string;
	projectId: string;
	repositoryIntegrationId: string | null;
	userId: string;
	organizationId: string | null;
	incremental: boolean;
	/**
	 * "From fresh" (B5): when true the AI re-derives independently — user
	 * overrides are NOT fed into the prompts and `appliedUserOverrides` is set
	 * false. Optional for replay-safety (old histories omit it → treated as
	 * false / default behaviour).
	 */
	fresh?: boolean;
}

export interface StartAnalysisPlan {
	analysisId: string;
	workflowId: string;
	taskQueue: string;
	workflowName: string;
	workflowArgs: AtlasWorkflowInput;
	status: AtlasStatus;
}
