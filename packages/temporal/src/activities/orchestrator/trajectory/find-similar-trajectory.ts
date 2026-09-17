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
 * - Tenant-scoped search (user within organization, or personal-only)
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

	// Search for similar trajectories.
	//
	// `saveTrajectory` writes `organizationId` on every row, so a lookup keyed
	// on `userId` alone spans every tenant the user belongs to: a trajectory
	// recorded inside organization A (its step inputs, tool arguments and
	// outputs) would be replayed in organization B or in the user's personal
	// context whenever the task text matched. Strict XOR: in an organization
	// match that organization; otherwise only rows with no organization.
	const tenantWhere = input.organizationId
		? { organizationId: input.organizationId, userId: input.userId }
		: { organizationId: null, userId: input.userId };

	const tasks = await db.agentTask.findMany({
		where: {
			...tenantWhere,
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
