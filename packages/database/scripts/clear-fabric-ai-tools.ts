/**
 * Clear Fabric AI Tools from Qdrant
 *
 * Deletes all Fabric AI tools from the Qdrant capability store.
 * This forces them to be re-indexed with updated descriptions on next search.
 *
 * Usage:
 *   pnpm --filter @repo/database clear:fabric-ai-tools
 */

import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "capabilities";

async function clearFabricAiTools() {
	console.log("[FabricAI] Connecting to Qdrant at", QDRANT_URL);

	const client = new QdrantClient({ url: QDRANT_URL });

	// Check if collection exists
	try {
		const collections = await client.getCollections();
		const exists = collections.collections.some(
			(c) => c.name === COLLECTION_NAME,
		);

		if (!exists) {
			console.log(
				`[FabricAI] Collection '${COLLECTION_NAME}' does not exist`,
			);
			return;
		}
	} catch (error) {
		console.error("[FabricAI] Failed to check collections:", error);
		return;
	}

	// Count Fabric AI tools before deletion
	try {
		const countResult = await client.count(COLLECTION_NAME, {
			filter: {
				must: [
					{
						key: "metadata.serverName",
						match: { value: "Fabric AI" },
					},
				],
			},
			exact: true,
		});
		console.log(
			`[FabricAI] Found ${countResult.count} Fabric AI tools to delete`,
		);

		if (countResult.count === 0) {
			console.log("[FabricAI] No Fabric AI tools to clear");
			return;
		}
	} catch (error) {
		console.error("[FabricAI] Failed to count tools:", error);
	}

	// Delete all Fabric AI tools (system-level, no userId filter)
	try {
		const result = await client.delete(COLLECTION_NAME, {
			wait: true,
			filter: {
				must: [
					{
						key: "metadata.serverName",
						match: { value: "Fabric AI" },
					},
				],
			},
		});

		console.log("[FabricAI] Delete result:", result);
		console.log(
			"[FabricAI] Successfully deleted Fabric AI tools from Qdrant",
		);
		console.log(
			"[FabricAI] Tools will be re-indexed on next orchestrator search",
		);
	} catch (error) {
		console.error("[FabricAI] Failed to delete tools:", error);
	}
}

clearFabricAiTools()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error("[FabricAI] Error:", error);
		process.exit(1);
	});
