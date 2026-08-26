/**
 * Clear Orchestrator Trajectories
 *
 * Clears all orchestrator trajectory records from the AgentTask table.
 * Use this when trajectory replay is causing incorrect tool selection.
 *
 * Usage:
 *   pnpm --filter @repo/database clear:trajectories
 *
 * Optional: Clear for specific user
 *   npx dotenv -c -e ../../.env.local -- npx tsx scripts/clear-orchestrator-trajectories.ts <userId>
 */

import { db } from "../prisma/client";

async function clearOrchestratorTrajectories(userId?: string) {
	console.log("[Trajectories] Clearing orchestrator trajectory records...");

	const where = {
		agentId: "orchestrator",
		stage: "trajectory",
		...(userId ? { userId } : {}),
	};

	// Count before deletion
	const countBefore = await db.agentTask.count({ where });
	console.log(
		`[Trajectories] Found ${countBefore} trajectory record(s) to delete`,
	);

	if (countBefore === 0) {
		console.log("[Trajectories] No trajectories to clear");
		return;
	}

	// Delete trajectories
	const deleted = await db.agentTask.deleteMany({ where });

	console.log(`[Trajectories] Deleted ${deleted.count} trajectory record(s)`);
	console.log("[Trajectories] Done. New tasks will create fresh plans.");
}

// Run if called directly
const userId = process.argv[2];
if (userId) {
	console.log(`[Trajectories] Filtering by userId: ${userId}`);
}

clearOrchestratorTrajectories(userId)
	.then(() => process.exit(0))
	.catch((error) => {
		console.error("[Trajectories] Error:", error);
		process.exit(1);
	});
