/**
 * Trajectory Types
 *
 * Defines trajectory types for the save & reuse feature.
 * Trajectories capture execution history for replay and learning.
 */

import type { OrchestratorWorkspace } from "./workspace.types";

// =============================================================================
// Trajectory Step
// =============================================================================

export interface TrajectoryStep {
	stepId: string;
	agentId: string;
	toolName?: string;
	input: unknown;
	output: unknown;
	durationMs: number;
	success: boolean;
	timestamp: string;
	/** Workspace state at this step (for replay) */
	workspaceSnapshot?: {
		files: string[]; // File IDs
		variables: Record<string, unknown>;
	};
}

// =============================================================================
// Trajectory
// =============================================================================

export interface Trajectory {
	id: string;
	/** Original task description */
	taskDescription: string;
	/** Task hash for similarity matching */
	taskHash: string;
	/** Execution steps */
	steps: TrajectoryStep[];
	/** Final outcome */
	outcome: "success" | "partial" | "failure";
	/** Total duration */
	totalDurationMs: number;
	/** Number of times reused */
	reuseCount: number;
	/** Success rate when reused */
	reuseSuccessRate: number;
	/** Created at */
	createdAt: string;
	/** Last used at */
	lastUsedAt?: string;
	/** User who created this */
	userId: string;
	/** Organization */
	organizationId?: string;
	/** Workspace snapshot at end of execution */
	finalWorkspace?: OrchestratorWorkspace;
}
