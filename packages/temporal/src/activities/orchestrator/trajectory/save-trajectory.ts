/**
 * Trajectory Save Activity
 *
 * Saves execution trajectories for learning and replay.
 */

import crypto from "node:crypto";
import { db } from "@repo/database";
import type { SaveTrajectoryInput, Trajectory } from "../types";

/**
 * Saves a trajectory record for future reference and learning.
 *
 * Features:
 * - Creates a task hash for similarity matching
 * - Stores steps with outcomes
 * - Includes final workspace state for replay
 */
export async function saveTrajectory(
	input: SaveTrajectoryInput,
): Promise<Trajectory> {
	console.log("[Orchestrator] Saving trajectory");

	// Create hash for similarity matching
	const taskHash = crypto
		.createHash("sha256")
		.update(input.taskDescription.toLowerCase().trim())
		.digest("hex")
		.substring(0, 16);

	const trajectory: Trajectory = {
		id: `traj-${Date.now()}`,
		taskDescription: input.taskDescription,
		taskHash,
		steps: input.steps,
		outcome: input.outcome,
		totalDurationMs: input.totalDurationMs,
		reuseCount: 0,
		reuseSuccessRate: input.outcome === "success" ? 1 : 0,
		createdAt: new Date().toISOString(),
		userId: input.userId,
		organizationId: input.organizationId,
		// Include workspace for replay
		finalWorkspace: input.finalWorkspace,
	};

	// Store in database (would need a Trajectory table)
	// For now, store in AgentTask as metadata
	await db.agentTask.create({
		data: {
			userId: input.userId,
			organizationId: input.organizationId,
			agentId: "orchestrator",
			status: input.outcome === "success" ? "completed" : "failed",
			stage: "trajectory",
			input: { taskDescription: input.taskDescription },
			result: JSON.parse(JSON.stringify(trajectory)),
			framework: "temporal",
		},
	});

	console.log(
		`[Orchestrator] Saved trajectory ${trajectory.id} with ${input.steps.length} steps` +
			(input.finalWorkspace
				? `, workspace: ${input.finalWorkspace.files.length} files, ${input.finalWorkspace.codeExecutions.length} code executions`
				: ""),
	);

	return trajectory;
}
