/**
 * Trajectory Search Activity
 *
 * Finds similar trajectories for task learning and optimization.
 */

import crypto from "node:crypto";
import { db } from "@repo/database";
import type { FindSimilarTrajectoryInput, Trajectory } from "../types";

/**
 * Finds a similar trajectory based on task description.
 *
 * Features:
 * - Hash-based matching for efficiency
 * - User-scoped search
 * - Returns most recent successful trajectory
 */
export async function findSimilarTrajectory(
	input: FindSimilarTrajectoryInput,
): Promise<Trajectory | null> {
	console.log("[Orchestrator] Finding similar trajectory");

	// Create hash for matching
	const taskHash = crypto
		.createHash("sha256")
		.update(input.taskDescription.toLowerCase().trim())
		.digest("hex")
		.substring(0, 16);

	// Search for similar trajectories
	const tasks = await db.agentTask.findMany({
		where: {
			userId: input.userId,
			agentId: "orchestrator",
			stage: "trajectory",
			status: "completed",
		},
		orderBy: { createdAt: "desc" },
		take: 100,
	});

	for (const task of tasks) {
		const trajectory = task.result as unknown as Trajectory;
		if (trajectory?.taskHash === taskHash) {
			return trajectory;
		}
	}

	return null;
}
