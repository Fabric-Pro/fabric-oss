/**
 * Memory Context Activity
 *
 * Handles semantic memory context generation for direct chat.
 */

import { generateMemoryContext } from "@repo/agent-core/backend";

const logger = {
	info: (message: string, data?: Record<string, unknown>) =>
		console.log(`[DirectChat Memory] ${message}`, data || ""),
	warn: (message: string, data?: Record<string, unknown>) =>
		console.warn(`[DirectChat Memory] ${message}`, data || ""),
};

/**
 * Generate semantic memory context for the message
 *
 * SECURITY: Credentials are fetched internally by generateMemoryContext().
 * API keys are NOT passed through Temporal workflow inputs to avoid
 * storing them in workflow history.
 */
export async function generateMemoryContextActivity(
	message: string,
	userId: string,
	organizationId: string | undefined,
): Promise<{ context: string; memoryCount: number }> {
	logger.info("Generating memory context", { userId });

	try {
		// Credentials are fetched internally - no apiKey needed in options
		const memory = await generateMemoryContext(message, {
			userId,
			organizationId,
			topK: 3,
		});

		if (memory.memoryCount > 0) {
			logger.info("Found relevant memories", {
				count: memory.memoryCount,
			});
			return {
				context: `\n\n## Relevant Context from Previous Sessions:\n${memory.contextString}`,
				memoryCount: memory.memoryCount,
			};
		}

		return { context: "", memoryCount: 0 };
	} catch (error) {
		logger.warn("Memory search failed", { error });
		return { context: "", memoryCount: 0 };
	}
}
