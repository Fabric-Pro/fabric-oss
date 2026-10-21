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
import { hasProjectAccess } from "./projects/projects";
import { hasWorkspaceAccess } from "./workspaces/workspaces";

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

	return filterAccessibleEpisodes(
		episodes.map(episodeToSummary),
		userId,
		organizationId,
	);
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

	return filterAccessibleEpisodes(
		episodes.map(episodeToSummary),
		userId,
		organizationId,
	);
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

	return filterAccessibleEpisodes(
		episodes.map(episodeToSummary),
		userId,
		organizationId,
	);
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

	return filterAccessibleEpisodes(
		episodes.map(episodeToSummary),
		userId,
		organizationId,
	);
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
 * Hydrate semantic hits by database episode ID within the requesting tenant.
 */
export async function getEpisodesByIds(
	episodeIds: string[],
	userId: string,
	organizationId?: string | null,
): Promise<EpisodeSummary[]> {
	const episodes = await db.episodicMemory.findMany({
		where: {
			id: { in: episodeIds },
			...(organizationId
				? { organizationId, userId }
				: { organizationId: null, userId }),
		},
	});

	// Preserve order from Qdrant results
	type EpisodeRecord = (typeof episodes)[number];
	const episodeMap = new Map<string, EpisodeRecord>(
		episodes.map((e) => [e.id, e]),
	);
	const orderedEpisodes = episodeIds
		.map((id) => episodeMap.get(id))
		.filter((e): e is EpisodeRecord => e !== undefined)
		.map((e) => episodeToSummary(e));
	return filterAccessibleEpisodes(orderedEpisodes, userId, organizationId);
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
 * Recheck current resource access once per distinct id in this result set.
 * Query limits precede this filter, so revoked access can yield fewer results.
 */
async function filterAccessibleEpisodes(
	episodes: EpisodeSummary[],
	userId: string,
	organizationId?: string | null,
): Promise<EpisodeSummary[]> {
	const projectIds = new Set(
		episodes.flatMap((e) => (e.projectId ? [e.projectId] : [])),
	);
	const workspaceIds = new Set(
		episodes.flatMap((e) => (e.workspaceId ? [e.workspaceId] : [])),
	);
	const check = async (
		ids: Set<string>,
		access: (id: string) => Promise<boolean>,
	) =>
		new Map(
			await Promise.all(
				[...ids].map(async (id) => {
					try {
						return [id, await access(id)] as const;
					} catch {
						// An unavailable permission check cannot authorize recall.
						return [id, false] as const;
					}
				}),
			),
		);
	const [projects, workspaces] = await Promise.all([
		check(projectIds, (id) =>
			hasProjectAccess(id, userId, organizationId ?? undefined),
		),
		check(workspaceIds, (id) => hasWorkspaceAccess(id, userId)),
	]);
	return episodes.filter(
		(episode) =>
			(!episode.projectId || projects.get(episode.projectId) === true) &&
			(!episode.workspaceId ||
				workspaces.get(episode.workspaceId) === true),
	);
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
			? getEpisodesByIds(relevantEpisodeIds, userId, organizationId)
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
 * The facts the `orchestrator_memory_context` prompt is rendered against.
 *
 * Only data: the lines that go in each section and whether a section has any.
 * The wording around them — the headings, and the rule that a recalled
 * conversation is history to check with a tool before reporting it as current —
 * is the prompt's (`ORCHESTRATOR_MEMORY_FALLBACK_BODY` in `@repo/utils`).
 */
export type MemoryContextPromptVariables = {
	has_memory: boolean;
	has_preferences: boolean;
	preferences: string;
	has_learned_patterns: boolean;
	learned_patterns: string;
	has_recalled_conversations: boolean;
	has_recent_conversations: boolean;
	recent_conversations: string;
	has_project_discussions: boolean;
	project_discussions: string;
	has_workspace_discussions: boolean;
	workspace_discussions: string;
	has_relevant_conversations: boolean;
	relevant_conversations: string;
};

export function buildMemoryContextPromptVariables(context: {
	preferences: OrchestratorMemoryPreferencesData;
	recentEpisodes: EpisodeSummary[];
	projectEpisodes: EpisodeSummary[];
	workspaceEpisodes: EpisodeSummary[];
	relevantEpisodes: EpisodeSummary[];
}): MemoryContextPromptVariables {
	const { responseStyle, verbosity, codeLanguage, timezone } =
		context.preferences;
	const preferenceLines = [
		responseStyle && `- Response style: ${responseStyle}`,
		verbosity && `- Verbosity: ${verbosity}`,
		codeLanguage && `- Preferred code language: ${codeLanguage}`,
		timezone && `- Timezone: ${timezone}`,
	].filter((line): line is string => Boolean(line));

	const learnedPatterns = context.preferences.preferences.learnedPatterns;
	const patternLines = (Array.isArray(learnedPatterns) ? learnedPatterns : [])
		.filter((pattern): pattern is string => typeof pattern === "string")
		.slice(-10)
		.map((pattern) => `- ${pattern}`);

	const relevantLines = context.relevantEpisodes.map((episode) =>
		episode.keyTopics.length > 0
			? `${episodeLine(episode)}\n  Topics: ${episode.keyTopics.join(", ")}`
			: episodeLine(episode),
	);

	const hasRecalledConversations =
		context.recentEpisodes.length > 0 ||
		context.projectEpisodes.length > 0 ||
		context.workspaceEpisodes.length > 0 ||
		context.relevantEpisodes.length > 0;

	return {
		has_memory:
			preferenceLines.length > 0 ||
			patternLines.length > 0 ||
			hasRecalledConversations,
		has_preferences: preferenceLines.length > 0,
		preferences: preferenceLines.join("\n"),
		has_learned_patterns: patternLines.length > 0,
		learned_patterns: patternLines.join("\n"),
		has_recalled_conversations: hasRecalledConversations,
		has_recent_conversations: context.recentEpisodes.length > 0,
		recent_conversations: context.recentEpisodes
			.map(episodeLine)
			.join("\n"),
		has_project_discussions: context.projectEpisodes.length > 0,
		project_discussions: context.projectEpisodes
			.map(episodeLine)
			.join("\n"),
		has_workspace_discussions: context.workspaceEpisodes.length > 0,
		workspace_discussions: context.workspaceEpisodes
			.map(episodeLine)
			.join("\n"),
		has_relevant_conversations: relevantLines.length > 0,
		relevant_conversations: relevantLines.join("\n"),
	};
}

/** "- [2026-10-16] title: summary", dated by when the conversation ended. */
function episodeLine(episode: EpisodeSummary): string {
	const date = episode.conversationEndedAt
		? new Date(episode.conversationEndedAt).toISOString().slice(0, 10)
		: "ongoing";
	return `- [${date}] ${episode.title}: ${episode.summary}`;
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
