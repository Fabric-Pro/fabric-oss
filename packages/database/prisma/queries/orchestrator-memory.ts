/**
 * Orchestrator Memory Queries
 *
 * Database operations for the Orchestrator's hybrid memory system:
 * - Tier 1 (Hot): User preferences - always loaded
 * - Tier 3 (Cold): Episodic memory - searchable past conversations
 *
 * Multi-tenant isolation:
 * - Personal context: organizationId = null
 * - Org context: organizationId = specific org
 * - Project scope: projectId for project-specific episodes
 * - Workspace scope: workspaceId for workspace-specific episodes
 */

import { db } from "../client";
import type { Prisma } from "../generated/client";

// =============================================================================
// TYPES
// =============================================================================

export interface OrchestratorMemoryPreferencesData {
	responseStyle?: string;
	verbosity?: string;
	codeLanguage?: string;
	timezone?: string;
	language?: string;
	preferences: Record<string, unknown>;
	recentProjectIds: string[];
	recentWorkspaceIds: string[];
}

export interface EpisodeSummary {
	id: string;
	conversationId: string;
	title: string;
	summary: string;
	keyTopics: string[];
	userIntents: string[];
	outcome: string;
	messageCount: number;
	turnCount: number;
	toolsUsed: string[];
	agentsUsed: string[];
	conversationStartedAt: Date;
	conversationEndedAt: Date | null;
	projectId: string | null;
	workspaceId: string | null;
	qdrantPointId: string | null;
}

export interface CreateEpisodeInput {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	conversationId: string;
	agentId?: string | null;
	title: string;
	summary: string;
	keyTopics: string[];
	userIntents: string[];
	outcome: string;
	messageCount: number;
	turnCount: number;
	toolsUsed: string[];
	agentsUsed: string[];
	conversationStartedAt: Date;
	conversationEndedAt?: Date | null;
	qdrantPointId?: string | null;
	qdrantCollection?: string | null;
}

// =============================================================================
// PREFERENCES (HOT MEMORY - TIER 1)
// =============================================================================

/**
 * Get orchestrator preferences for a user/org context
 * Creates default preferences if none exist
 */
export async function getOrchestratorMemoryPreferences(
	userId: string,
	organizationId?: string | null,
): Promise<OrchestratorMemoryPreferencesData> {
	// Use findFirst instead of findUnique because compound unique doesn't handle null well
	const existing = await db.orchestratorMemoryPreferences.findFirst({
		where: {
			userId,
			organizationId: organizationId ?? null,
		},
	});

	if (existing) {
		return {
			responseStyle: existing.responseStyle ?? undefined,
			verbosity: existing.verbosity ?? undefined,
			codeLanguage: existing.codeLanguage ?? undefined,
			timezone: existing.timezone ?? undefined,
			language: existing.language ?? undefined,
			preferences: existing.preferences as Record<string, unknown>,
			recentProjectIds: existing.recentProjectIds,
			recentWorkspaceIds: existing.recentWorkspaceIds,
		};
	}

	// Return defaults if no preferences exist
	return {
		preferences: {},
		recentProjectIds: [],
		recentWorkspaceIds: [],
	};
}

/**
 * Update orchestrator preferences (upsert)
 */
export async function updateOrchestratorMemoryPreferences(
	userId: string,
	organizationId: string | null | undefined,
	updates: Partial<OrchestratorMemoryPreferencesData>,
): Promise<OrchestratorMemoryPreferencesData> {
	const normalizedOrgId = organizationId ?? null;

	// Check if record exists (compound unique doesn't handle null well in Prisma)
	const existing = await db.orchestratorMemoryPreferences.findFirst({
		where: {
			userId,
			organizationId: normalizedOrgId,
		},
	});

	let result: Awaited<
		ReturnType<typeof db.orchestratorMemoryPreferences.create>
	>;

	if (existing) {
		// Update existing record
		result = await db.orchestratorMemoryPreferences.update({
			where: { id: existing.id },
			data: {
				...(updates.responseStyle !== undefined && {
					responseStyle: updates.responseStyle,
				}),
				...(updates.verbosity !== undefined && {
					verbosity: updates.verbosity,
				}),
				...(updates.codeLanguage !== undefined && {
					codeLanguage: updates.codeLanguage,
				}),
				...(updates.timezone !== undefined && {
					timezone: updates.timezone,
				}),
				...(updates.language !== undefined && {
					language: updates.language,
				}),
				...(updates.preferences !== undefined && {
					preferences: updates.preferences as Prisma.InputJsonValue,
				}),
				...(updates.recentProjectIds !== undefined && {
					recentProjectIds: updates.recentProjectIds,
				}),
				...(updates.recentWorkspaceIds !== undefined && {
					recentWorkspaceIds: updates.recentWorkspaceIds,
				}),
				lastActiveAt: new Date(),
			},
		});
	} else {
		// Create new record
		result = await db.orchestratorMemoryPreferences.create({
			data: {
				userId,
				organizationId: normalizedOrgId,
				responseStyle: updates.responseStyle,
				verbosity: updates.verbosity,
				codeLanguage: updates.codeLanguage,
				timezone: updates.timezone,
				language: updates.language,
				preferences: (updates.preferences ??
					{}) as Prisma.InputJsonValue,
				recentProjectIds: updates.recentProjectIds ?? [],
				recentWorkspaceIds: updates.recentWorkspaceIds ?? [],
				lastActiveAt: new Date(),
			},
		});
	}

	return {
		responseStyle: result.responseStyle ?? undefined,
		verbosity: result.verbosity ?? undefined,
		codeLanguage: result.codeLanguage ?? undefined,
		timezone: result.timezone ?? undefined,
		language: result.language ?? undefined,
		preferences: result.preferences as Record<string, unknown>,
		recentProjectIds: result.recentProjectIds,
		recentWorkspaceIds: result.recentWorkspaceIds,
	};
}

/**
 * Update recent activity (projects/workspaces)
 * Keeps only the last 5 items
 */
export async function updateRecentActivity(
	userId: string,
	organizationId: string | null | undefined,
	activity: {
		projectId?: string;
		workspaceId?: string;
	},
): Promise<void> {
	const current = await getOrchestratorMemoryPreferences(
		userId,
		organizationId,
	);

	const updates: Partial<OrchestratorMemoryPreferencesData> = {};

	if (activity.projectId) {
		const recentProjects = [
			activity.projectId,
			...current.recentProjectIds.filter(
				(id) => id !== activity.projectId,
			),
		].slice(0, 5);
		updates.recentProjectIds = recentProjects;
	}

	if (activity.workspaceId) {
		const recentWorkspaces = [
			activity.workspaceId,
			...current.recentWorkspaceIds.filter(
				(id) => id !== activity.workspaceId,
			),
		].slice(0, 5);
		updates.recentWorkspaceIds = recentWorkspaces;
	}

	if (Object.keys(updates).length > 0) {
		await updateOrchestratorMemoryPreferences(
			userId,
			organizationId,
			updates,
		);
	}
}

/**
 * Learn a new pattern from conversation
 * Adds to the learnedPatterns array in preferences
 */
export async function learnPattern(
	userId: string,
	organizationId: string | null | undefined,
	pattern: string,
): Promise<void> {
	const current = await getOrchestratorMemoryPreferences(
		userId,
		organizationId,
	);
	const learnedPatterns =
		(current.preferences.learnedPatterns as string[]) || [];

	// Avoid duplicates and limit to 20 patterns
	if (!learnedPatterns.includes(pattern)) {
		const updatedPatterns = [...learnedPatterns, pattern].slice(-20);
		await updateOrchestratorMemoryPreferences(userId, organizationId, {
			preferences: {
				...current.preferences,
				learnedPatterns: updatedPatterns,
			},
		});
	}
}

/**
 * Remove a specific learned pattern
 */
export async function removeLearnedPattern(
	userId: string,
	organizationId: string | null | undefined,
	pattern: string,
): Promise<void> {
	const current = await getOrchestratorMemoryPreferences(
		userId,
		organizationId,
	);
	const learnedPatterns =
		(current.preferences.learnedPatterns as string[]) || [];

	const updatedPatterns = learnedPatterns.filter((p) => p !== pattern);

	if (updatedPatterns.length !== learnedPatterns.length) {
		await updateOrchestratorMemoryPreferences(userId, organizationId, {
			preferences: {
				...current.preferences,
				learnedPatterns: updatedPatterns,
			},
		});
	}
}

// =============================================================================
// EPISODIC MEMORY (COLD MEMORY - TIER 3)
// =============================================================================

/**
 * Create an episodic memory entry from a conversation
 */
export async function createEpisodicMemory(
	input: CreateEpisodeInput,
): Promise<EpisodeSummary> {
	const episode = await db.episodicMemory.create({
		data: {
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			projectId: input.projectId ?? null,
			workspaceId: input.workspaceId ?? null,
			conversationId: input.conversationId,
			agentId: input.agentId ?? null,
			title: input.title,
			summary: input.summary,
			keyTopics: input.keyTopics,
			userIntents: input.userIntents,
			outcome: input.outcome,
			messageCount: input.messageCount,
			turnCount: input.turnCount,
			toolsUsed: input.toolsUsed,
			agentsUsed: input.agentsUsed,
			conversationStartedAt: input.conversationStartedAt,
			conversationEndedAt: input.conversationEndedAt ?? null,
			qdrantPointId: input.qdrantPointId ?? null,
			qdrantCollection: input.qdrantCollection ?? null,
		},
	});

	return episodeToSummary(episode);
}

/**
 * Get episodic memory by conversation ID
 */
export async function getEpisodeByConversationId(
	conversationId: string,
): Promise<EpisodeSummary | null> {
	const episode = await db.episodicMemory.findUnique({
		where: { conversationId },
	});

	return episode ? episodeToSummary(episode) : null;
}

/**
 * Delete an episodic memory by ID
 * Enforces tenant isolation - user must own the episode
 */
export async function deleteEpisodicMemory(
	episodeId: string,
	userId: string,
	organizationId: string | null | undefined,
): Promise<boolean> {
	const normalizedOrgId = organizationId ?? null;

	// Verify ownership before deleting
	const episode = await db.episodicMemory.findFirst({
		where: {
			id: episodeId,
			userId,
			organizationId: normalizedOrgId,
		},
	});

	if (!episode) {
		return false;
	}

	await db.episodicMemory.delete({
		where: { id: episodeId },
	});

	return true;
}

/**
 * Search episodic memories with access control
 * Returns episodes the user has access to based on their permissions
 */
export async function searchEpisodicMemories(params: {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	agentId?: string | null;
	keyTopics?: string[];
	limit?: number;
	offset?: number;
	startDate?: Date;
	endDate?: Date;
}): Promise<EpisodeSummary[]> {
	const {
		userId,
		organizationId,
		projectId,
		workspaceId,
		agentId,
		keyTopics,
		limit = 10,
		offset = 0,
		startDate,
		endDate,
	} = params;

	// Build the where clause with proper tenant isolation
	const where: Prisma.EpisodicMemoryWhereInput = {
		userId,
		// XOR pattern: either personal (null) or specific org
		organizationId: organizationId ?? null,
	};

	// Optional filters
	if (projectId) {
		where.projectId = projectId;
	}
	if (workspaceId) {
		where.workspaceId = workspaceId;
	}
	if (agentId) {
		where.agentId = agentId;
	}
	if (keyTopics && keyTopics.length > 0) {
		where.keyTopics = { hasSome: keyTopics };
	}
	if (startDate || endDate) {
		where.conversationStartedAt = {};
		if (startDate) {
			where.conversationStartedAt.gte = startDate;
		}
		if (endDate) {
			where.conversationStartedAt.lte = endDate;
		}
	}

	const episodes = await db.episodicMemory.findMany({
		where,
		orderBy: { conversationEndedAt: "desc" },
		take: limit,
		skip: offset,
	});

	return episodes.map(episodeToSummary);
}

/**
 * Get recent episodes for context loading
 * Fetches the most recent episodes for the user/org context
 */
export async function getRecentEpisodes(
	userId: string,
	organizationId: string | null | undefined,
	limit = 5,
): Promise<EpisodeSummary[]> {
	const episodes = await db.episodicMemory.findMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
		},
		orderBy: { conversationEndedAt: "desc" },
		take: limit,
	});

	return episodes.map(episodeToSummary);
}

/**
 * Get episodes related to a specific project
 * Used for project context loading
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only org episodes for this project
 * - PERSONAL CONTEXT (userId only, no organizationId): Only personal episodes for this project
 */
export async function getProjectEpisodes(
	projectId: string,
	userId: string,
	organizationId?: string | null,
	limit = 10,
): Promise<EpisodeSummary[]> {
	const episodes = await db.episodicMemory.findMany({
		where: {
			projectId,
			userId,
			organizationId: organizationId ?? null, // XOR: enforce tenant isolation
		},
		orderBy: { conversationEndedAt: "desc" },
		take: limit,
	});

	return episodes.map(episodeToSummary);
}

/**
 * Get episodes related to a specific workspace
 * Used for workspace context loading
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only org episodes for this workspace
 * - PERSONAL CONTEXT (userId only, no organizationId): Only personal episodes for this workspace
 */
export async function getWorkspaceEpisodes(
	workspaceId: string,
	userId: string,
	organizationId?: string | null,
	limit = 10,
): Promise<EpisodeSummary[]> {
	const episodes = await db.episodicMemory.findMany({
		where: {
			workspaceId,
			userId,
			organizationId: organizationId ?? null, // XOR: enforce tenant isolation
		},
		orderBy: { conversationEndedAt: "desc" },
		take: limit,
	});

	return episodes.map(episodeToSummary);
}

/**
 * Update episode with Qdrant reference after embedding
 */
export async function updateEpisodeQdrantReference(
	episodeId: string,
	qdrantPointId: string,
	qdrantCollection: string,
): Promise<void> {
	await db.episodicMemory.update({
		where: { id: episodeId },
		data: {
			qdrantPointId,
			qdrantCollection,
		},
	});
}

/**
 * Get episodes by Qdrant point IDs (after semantic search)
 */
export async function getEpisodesByQdrantIds(
	qdrantPointIds: string[],
): Promise<EpisodeSummary[]> {
	const episodes = await db.episodicMemory.findMany({
		where: {
			qdrantPointId: { in: qdrantPointIds },
		},
	});

	// Preserve order from Qdrant results
	type EpisodeRecord = (typeof episodes)[number];
	const episodeMap = new Map<string | null, EpisodeRecord>(
		episodes.map((e) => [e.qdrantPointId, e]),
	);
	return qdrantPointIds
		.map((id) => episodeMap.get(id))
		.filter((e): e is EpisodeRecord => e !== undefined)
		.map((e) => episodeToSummary(e));
}

/**
 * Delete episode by ID
 */
export async function deleteEpisode(episodeId: string): Promise<void> {
	await db.episodicMemory.delete({
		where: { id: episodeId },
	});
}

/**
 * Delete all episodes for a conversation
 */
export async function deleteEpisodeByConversationId(
	conversationId: string,
): Promise<void> {
	await db.episodicMemory.deleteMany({
		where: { conversationId },
	});
}

// =============================================================================
// ACCESS CONTROL HELPERS
// =============================================================================

/**
 * Check if user has access to a project
 * Used for filtering project-scoped episodes
 */
export async function hasProjectAccessForMemory(
	projectId: string,
	userId: string,
	organizationId?: string | null,
): Promise<boolean> {
	const project = await db.project.findFirst({
		where: {
			id: projectId,
			OR: [
				// Owner
				{ userId },
				// Organization member (if org project)
				...(organizationId
					? [
							{
								organizationId,
								organization: {
									members: { some: { userId } },
								},
							},
						]
					: []),
				// Project member
				{
					members: { some: { userId } },
				},
			],
		},
	});

	return project !== null;
}

/**
 * Check if user has access to a workspace
 * Used for filtering workspace-scoped episodes
 */
export async function hasWorkspaceAccessForMemory(
	workspaceId: string,
	userId: string,
): Promise<boolean> {
	const workspace = await db.workspace.findFirst({
		where: {
			id: workspaceId,
			OR: [
				// Creator
				{ userId },
				// Administrator
				{ administrators: { some: { userId } } },
				// Contributor
				{ contributors: { some: { userId } } },
				// Stakeholder
				{ stakeholders: { some: { userId } } },
			],
		},
	});

	return workspace !== null;
}

/**
 * Get accessible project IDs for a user
 */
export async function getAccessibleProjectIds(
	userId: string,
	organizationId?: string | null,
): Promise<string[]> {
	const projects = await db.project.findMany({
		where: {
			OR: [
				// Owner
				{ userId, organizationId: organizationId ?? null },
				// Organization member (if org context)
				...(organizationId
					? [
							{
								organizationId,
								organization: {
									members: { some: { userId } },
								},
							},
						]
					: []),
				// Project member
				{
					members: { some: { userId } },
					organizationId: organizationId ?? null,
				},
			],
		},
		select: { id: true },
	});

	return projects.map((p: { id: string }) => p.id);
}

/**
 * Get accessible workspace IDs for a user
 */
export async function getAccessibleWorkspaceIds(
	userId: string,
	organizationId?: string | null,
): Promise<string[]> {
	const workspaces = await db.workspace.findMany({
		where: {
			organizationId: organizationId ?? null,
			OR: [
				// Creator
				{ userId },
				// Administrator
				{ administrators: { some: { userId } } },
				// Contributor
				{ contributors: { some: { userId } } },
				// Stakeholder
				{ stakeholders: { some: { userId } } },
			],
		},
		select: { id: true },
	});

	return workspaces.map((w: { id: string }) => w.id);
}

// =============================================================================
// CONTEXT BUILDING
// =============================================================================

/**
 * Build the orchestrator memory context for a conversation
 * Combines hot preferences + recent episodes + relevant episodes
 */
export async function buildOrchestratorMemoryContext(params: {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	currentQuery?: string;
	relevantEpisodeIds?: string[];
}): Promise<{
	preferences: OrchestratorMemoryPreferencesData;
	recentEpisodes: EpisodeSummary[];
	projectEpisodes: EpisodeSummary[];
	workspaceEpisodes: EpisodeSummary[];
	relevantEpisodes: EpisodeSummary[];
}> {
	const {
		userId,
		organizationId,
		projectId,
		workspaceId,
		relevantEpisodeIds,
	} = params;

	// Fetch all data in parallel
	const [
		preferences,
		recentEpisodes,
		projectEpisodes,
		workspaceEpisodes,
		relevantEpisodes,
	] = await Promise.all([
		getOrchestratorMemoryPreferences(userId, organizationId),
		getRecentEpisodes(userId, organizationId, 3),
		projectId
			? getProjectEpisodes(projectId, userId, organizationId, 5)
			: Promise.resolve([]),
		workspaceId
			? getWorkspaceEpisodes(workspaceId, userId, organizationId, 5)
			: Promise.resolve([]),
		relevantEpisodeIds && relevantEpisodeIds.length > 0
			? getEpisodesByQdrantIds(relevantEpisodeIds)
			: Promise.resolve([]),
	]);

	return {
		preferences,
		recentEpisodes,
		projectEpisodes,
		workspaceEpisodes,
		relevantEpisodes,
	};
}

/**
 * Format memory context as a system prompt addition
 */
export function formatMemoryContextPrompt(context: {
	preferences: OrchestratorMemoryPreferencesData;
	recentEpisodes: EpisodeSummary[];
	projectEpisodes: EpisodeSummary[];
	workspaceEpisodes: EpisodeSummary[];
	relevantEpisodes: EpisodeSummary[];
}): string {
	const sections: string[] = [];

	// User preferences section
	if (
		context.preferences.responseStyle ||
		context.preferences.verbosity ||
		context.preferences.codeLanguage ||
		Object.keys(context.preferences.preferences).length > 0
	) {
		const prefLines: string[] = ["## User Preferences"];
		if (context.preferences.responseStyle) {
			prefLines.push(
				`- Response style: ${context.preferences.responseStyle}`,
			);
		}
		if (context.preferences.verbosity) {
			prefLines.push(`- Verbosity: ${context.preferences.verbosity}`);
		}
		if (context.preferences.codeLanguage) {
			prefLines.push(
				`- Preferred code language: ${context.preferences.codeLanguage}`,
			);
		}
		if (context.preferences.timezone) {
			prefLines.push(`- Timezone: ${context.preferences.timezone}`);
		}

		sections.push(prefLines.join("\n"));
	}

	// Learned patterns section - separate and prominent
	const learnedPatterns = context.preferences.preferences
		.learnedPatterns as string[];
	if (learnedPatterns && learnedPatterns.length > 0) {
		const patternLines: string[] = [
			"## MANDATORY User Learned Patterns",
			"**These are explicit user preferences that MUST be followed:**",
		];
		for (const pattern of learnedPatterns.slice(-10)) {
			patternLines.push(`- ${pattern}`);
		}
		patternLines.push("");
		patternLines.push(
			"Apply these patterns to your response format and behavior.",
		);
		sections.push(patternLines.join("\n"));
	}

	// Recent conversations section
	if (context.recentEpisodes.length > 0) {
		const recentLines: string[] = ["## Recent Conversations"];
		for (const episode of context.recentEpisodes) {
			const date = episode.conversationEndedAt
				? new Date(episode.conversationEndedAt).toLocaleDateString()
				: "ongoing";
			recentLines.push(
				`- [${date}] ${episode.title}: ${episode.summary}`,
			);
		}
		sections.push(recentLines.join("\n"));
	}

	// Project context section
	if (context.projectEpisodes.length > 0) {
		const projectLines: string[] = ["## Related Project Discussions"];
		for (const episode of context.projectEpisodes) {
			projectLines.push(`- ${episode.title}: ${episode.summary}`);
		}
		sections.push(projectLines.join("\n"));
	}

	// Workspace context section
	if (context.workspaceEpisodes.length > 0) {
		const workspaceLines: string[] = ["## Related Workspace Discussions"];
		for (const episode of context.workspaceEpisodes) {
			workspaceLines.push(`- ${episode.title}: ${episode.summary}`);
		}
		sections.push(workspaceLines.join("\n"));
	}

	// Semantically relevant episodes
	if (context.relevantEpisodes.length > 0) {
		const relevantLines: string[] = ["## Relevant Past Conversations"];
		relevantLines.push(
			"(These may be relevant to the current request based on semantic similarity)",
		);
		for (const episode of context.relevantEpisodes) {
			relevantLines.push(`- ${episode.title}: ${episode.summary}`);
			if (episode.keyTopics.length > 0) {
				relevantLines.push(`  Topics: ${episode.keyTopics.join(", ")}`);
			}
		}
		sections.push(relevantLines.join("\n"));
	}

	if (sections.length === 0) {
		return getLibrarianAndPushbackPrompt();
	}

	return `
# Orchestrator Memory Context

${sections.join("\n\n")}

${getLibrarianAndPushbackPrompt()}
`;
}

/**
 * Get the Librarian and Pushback capability prompts
 * These instruct the Orchestrator to proactively cross-reference sources
 * and challenge incomplete requirements
 */
function getLibrarianAndPushbackPrompt(): string {
	return `
---
## Memory-Enhanced Capabilities

### Librarian Capability
You have access to the user's conversation history, workspace documents, and project context.
When responding:
- **Proactively cross-reference** related discussions from memory
- If you find relevant past conversations, mention them: "By the way, we discussed something related to this on [date]..."
- Connect dots between different sources: "In your workspace documents, I found X which relates to what you're asking about Y"
- If team members discussed implementation details that affect the current task, surface them: "I noticed the team made a decision about X that may affect this..."
- When you find conflicting information across sources, highlight it

### Pushback Capability  
You should challenge incomplete or ambiguous requirements:
- If critical details are missing, ask clarifying questions BEFORE proceeding
- Reference past patterns: "In previous projects, you typically wanted X. Should I include that here?"
- If the request conflicts with past decisions, point it out: "This seems to conflict with the decision made in [past conversation]. Should I proceed anyway?"
- Validate completeness: "Before I create this, let me confirm: [list key assumptions]. Is this correct?"

### Learning Capability
When the user expresses a preference or correction:
- Acknowledge it: "Got it, I'll remember that you prefer X"
- Apply it immediately in the current response
- The system will save this preference for future conversations

Use this context to provide personalized, context-aware assistance that demonstrates
understanding of the user's history, preferences, and ongoing work.
`;
}

// =============================================================================
// HELPERS
// =============================================================================

function episodeToSummary(episode: {
	id: string;
	conversationId: string;
	title: string;
	summary: string;
	keyTopics: string[];
	userIntents: string[];
	outcome: string;
	messageCount: number;
	turnCount: number;
	toolsUsed: string[];
	agentsUsed: string[];
	conversationStartedAt: Date;
	conversationEndedAt: Date | null;
	projectId: string | null;
	workspaceId: string | null;
	qdrantPointId: string | null;
}): EpisodeSummary {
	return {
		id: episode.id,
		conversationId: episode.conversationId,
		title: episode.title,
		summary: episode.summary,
		keyTopics: episode.keyTopics,
		userIntents: episode.userIntents,
		outcome: episode.outcome,
		messageCount: episode.messageCount,
		turnCount: episode.turnCount,
		toolsUsed: episode.toolsUsed,
		agentsUsed: episode.agentsUsed,
		conversationStartedAt: episode.conversationStartedAt,
		conversationEndedAt: episode.conversationEndedAt,
		projectId: episode.projectId,
		workspaceId: episode.workspaceId,
		qdrantPointId: episode.qdrantPointId,
	};
}
