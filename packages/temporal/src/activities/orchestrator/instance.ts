/**
 * Instance Memory Activity
 *
 * Loads agent instance memory files (skills, knowledge, AGENTS.md)
 * and formats them for injection into the system prompt.
 */

import { listMemoryFiles } from "@repo/database";
import { logger } from "@repo/logs";

export interface LoadInstanceMemoryInput {
	instanceId: string;
	userId: string;
	organizationId?: string;
}

export interface LoadInstanceMemoryOutput {
	/** Formatted prompt section with skill/knowledge content */
	memoryPrompt: string;
	/** Number of memory files loaded */
	fileCount: number;
}

/**
 * Load agent instance memory files (skills, AGENTS.md, knowledge) and
 * format them as a prompt section for injection into the system prompt.
 *
 * Called during orchestrator initialization when an instanceId is provided,
 * so the agent has access to its procedural memory and skills.
 */
export async function loadInstanceMemoryActivity(
	input: LoadInstanceMemoryInput,
): Promise<LoadInstanceMemoryOutput> {
	logger.info("[InstanceMemory] Loading instance memory files", {
		instanceId: input.instanceId,
	});

	try {
		const { files } = await listMemoryFiles({
			agentInstanceId: input.instanceId,
			userId: input.userId,
			organizationId: input.organizationId,
			limit: 50,
		});

		if (files.length === 0) {
			return { memoryPrompt: "", fileCount: 0 };
		}

		// Include AGENTS_MD, SKILL, and KNOWLEDGE files (not CONVERSATION)
		const relevantFiles = files.filter(
			(f) =>
				f.fileType === "AGENTS_MD" ||
				f.fileType === "SKILL" ||
				f.fileType === "KNOWLEDGE",
		);

		if (relevantFiles.length === 0) {
			return { memoryPrompt: "", fileCount: 0 };
		}

		// Format memory files into a prompt section
		const sections = relevantFiles.map((file) => {
			const heading =
				file.fileType === "AGENTS_MD"
					? "## Agent Identity & Instructions (AGENTS.md)"
					: `## ${file.path}`;
			return `${heading}\n\n${file.content}`;
		});

		const memoryPrompt = `\n\n---\n## Agent Memory\n\nThe following are your procedural memory, skills, and knowledge files. Follow these guidelines and use these skills:\n\n${sections.join("\n\n---\n\n")}`;

		logger.info("[InstanceMemory] Loaded instance memory files", {
			instanceId: input.instanceId,
			fileCount: relevantFiles.length,
			types: relevantFiles.map((f) => f.fileType),
		});

		return {
			memoryPrompt,
			fileCount: relevantFiles.length,
		};
	} catch (error) {
		logger.warn("[InstanceMemory] Failed to load instance memory", {
			instanceId: input.instanceId,
			error: error instanceof Error ? error.message : String(error),
		});
		// Non-fatal: return empty if loading fails
		return { memoryPrompt: "", fileCount: 0 };
	}
}
