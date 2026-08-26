/**
 * Agent Memory Activities
 *
 * Temporal activities for loading, initializing, and updating agent memory.
 */

import {
	type AgentMemoryEditOperation,
	type AgentMemoryFile,
	approveMemoryEdit,
	createMemoryEdit,
	initializeMemoryFromTemplate,
	loadAgentMemoryContext,
	readMemoryFile,
} from "@repo/database";
import { logger } from "@repo/logs";

// ============================================================================
// Types
// ============================================================================

export interface LoadAgentMemoryInput {
	agentInstanceId: string;
	userId: string;
	organizationId?: string;
}

export interface LoadAgentMemoryOutput {
	agentsMd: string | null;
	mcpJson: Record<string, unknown> | null;
	skills: Array<{ path: string; content: string }>;
	knowledge: Array<{ path: string; content: string }>;
	recentConversations: Array<{ path: string; content: string }>;
	systemPromptAddition: string;
}

export interface InitializeAgentMemoryInput {
	agentInstanceId: string;
	templateId: string;
	userId: string;
	organizationId?: string;
}

export interface ProposeMemoryUpdateInput {
	agentInstanceId: string;
	userId: string;
	organizationId?: string;
	path: string;
	content: string;
	reason?: string;
	autoApprove?: boolean;
}

export interface ApplyMemoryEditInput {
	editId: string;
	approvedBy: string;
}

// ============================================================================
// Activities
// ============================================================================

/**
 * Load all agent memory context for execution
 * Returns structured memory that can be injected into the agent's context
 */
export async function loadAgentMemoryActivity(
	input: LoadAgentMemoryInput,
): Promise<LoadAgentMemoryOutput> {
	const { agentInstanceId, userId, organizationId } = input;

	logger.info("[AgentMemory] Loading memory context", {
		agentInstanceId,
		userId,
	});

	try {
		const memoryContext = await loadAgentMemoryContext({
			agentInstanceId,
			userId,
			organizationId,
		});

		// Build system prompt addition from AGENTS.md
		let systemPromptAddition = "";
		if (memoryContext.agentsMd) {
			systemPromptAddition = `\n\n## Agent Memory (AGENTS.md)\n\n${memoryContext.agentsMd}`;
		}

		// Add relevant skills
		if (memoryContext.skills.length > 0) {
			systemPromptAddition +=
				"\n\n## Loaded Skills\nYou have the following skills loaded. When the user's request matches a skill's purpose, you MUST follow that skill's instructions exactly, including its output format (e.g., generating HTML pages, diagrams, etc.).\n";
			for (const skill of memoryContext.skills) {
				const skillName = skill.path
					.replace("skills/", "")
					.replace("/SKILL.md", "");
				systemPromptAddition += `\n### Skill: ${skillName}\n${skill.content}\n`;
			}
		}

		// Add knowledge context
		if (memoryContext.knowledge.length > 0) {
			systemPromptAddition += "\n\n## Knowledge Context\n";
			for (const knowledge of memoryContext.knowledge) {
				const knowledgeName = knowledge.path.replace("knowledge/", "");
				systemPromptAddition += `\n### ${knowledgeName}\n${knowledge.content}\n`;
			}
		}

		logger.info("[AgentMemory] Memory loaded successfully", {
			agentInstanceId,
			hasAgentsMd: !!memoryContext.agentsMd,
			skillsCount: memoryContext.skills.length,
			knowledgeCount: memoryContext.knowledge.length,
			conversationsCount: memoryContext.recentConversations.length,
		});

		return {
			...memoryContext,
			systemPromptAddition,
		};
	} catch (error) {
		logger.error("[AgentMemory] Failed to load memory", {
			agentInstanceId,
			error: error instanceof Error ? error.message : "Unknown error",
		});

		// Return empty memory on error (graceful degradation)
		return {
			agentsMd: null,
			mcpJson: null,
			skills: [],
			knowledge: [],
			recentConversations: [],
			systemPromptAddition: "",
		};
	}
}

/**
 * Initialize memory files from a template
 * Called when creating a new agent instance
 */
export async function initializeAgentMemoryActivity(
	input: InitializeAgentMemoryInput,
): Promise<AgentMemoryFile[]> {
	const { agentInstanceId, templateId, userId, organizationId } = input;

	logger.info("[AgentMemory] Initializing memory from template", {
		agentInstanceId,
		templateId,
	});

	try {
		const files = await initializeMemoryFromTemplate({
			agentInstanceId,
			templateId,
			userId,
			organizationId,
		});

		logger.info("[AgentMemory] Memory initialized successfully", {
			agentInstanceId,
			filesCreated: files.length,
			paths: files.map((f) => f.path),
		});

		return files;
	} catch (error) {
		logger.error("[AgentMemory] Failed to initialize memory", {
			agentInstanceId,
			templateId,
			error: error instanceof Error ? error.message : "Unknown error",
		});
		throw error;
	}
}

/**
 * Propose a memory update (creates a pending edit for HITL approval)
 * If autoApprove is true, the edit is applied immediately
 */
export async function proposeMemoryUpdateActivity(
	input: ProposeMemoryUpdateInput,
): Promise<{
	editId: string;
	applied: boolean;
	file?: AgentMemoryFile;
}> {
	const {
		agentInstanceId,
		userId,
		organizationId,
		path,
		content,
		reason,
		autoApprove = false,
	} = input;

	logger.info("[AgentMemory] Proposing memory update", {
		agentInstanceId,
		path,
		autoApprove,
		reason,
	});

	try {
		// Determine operation type
		const existingFile = await readMemoryFile(
			{ agentInstanceId, userId, organizationId },
			path,
		);
		const operation: AgentMemoryEditOperation = existingFile
			? "UPDATE"
			: "CREATE";

		const edit = await createMemoryEdit({
			ctx: { agentInstanceId, userId, organizationId },
			path,
			operation,
			newContent: content,
			reason,
			autoApprove,
		});

		logger.info("[AgentMemory] Memory update proposed", {
			editId: edit.id,
			operation,
			status: edit.status,
			autoApproved: autoApprove,
		});

		// If auto-approved, the file was already created/updated
		if (autoApprove) {
			const file = await readMemoryFile(
				{ agentInstanceId, userId, organizationId },
				path,
			);
			return {
				editId: edit.id,
				applied: true,
				file: file ?? undefined,
			};
		}

		return {
			editId: edit.id,
			applied: false,
		};
	} catch (error) {
		logger.error("[AgentMemory] Failed to propose memory update", {
			agentInstanceId,
			path,
			error: error instanceof Error ? error.message : "Unknown error",
		});
		throw error;
	}
}

/**
 * Apply a memory edit (approve and execute)
 * Called when a user approves a pending edit
 */
export async function applyMemoryEditActivity(
	input: ApplyMemoryEditInput,
): Promise<{
	success: boolean;
	file?: AgentMemoryFile;
}> {
	const { editId, approvedBy } = input;

	logger.info("[AgentMemory] Applying memory edit", { editId, approvedBy });

	try {
		const { file } = await approveMemoryEdit(editId, approvedBy);

		logger.info("[AgentMemory] Memory edit applied", {
			editId,
			filePath: file?.path,
		});

		return {
			success: true,
			file: file ?? undefined,
		};
	} catch (error) {
		logger.error("[AgentMemory] Failed to apply memory edit", {
			editId,
			error: error instanceof Error ? error.message : "Unknown error",
		});
		return { success: false };
	}
}
