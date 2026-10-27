/**
 * Orchestrator Memory Queries
 *
 * Database operations for the Orchestrator's hybrid memory system:
 * - Tier 1 (Hot): User preferences - loaded with context
 * - Tier 3 (Cold): Episodic memory - searchable past conversations
 *
 * Multi-tenant isolation:
 * - Personal context: organizationId = null
 * - Org context: organizationId = specific org
 * - Project scope: projectId for project-specific episodes
 * - Workspace scope: workspaceId for workspace-specific episodes
 */

import { ORCHESTRATOR_MEMORY_FALLBACK_BODY } from "@repo/utils/orchestrator-memory-prompt";
import { renderTemplate } from "@repo/utils/template-renderer";
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
	/** Count from tenant-scoped ConversationTurn rows, populated on memory load. */
	recordedTurnCount?: number;
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
 * Create a conversation episode or replace its latest turn for the same owner.
 * Preserve the original start/creation timestamps and existing vector reference.
 * Reject owner mismatches, including null versus non-null organizations.
 */
export async function createEpisodicMemory(
	input: CreateEpisodeInput,
): Promise<EpisodeSummary> {
	const where = {
		conversationId: input.conversationId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
	};
	const update = {
		projectId: input.projectId ?? null,
		workspaceId: input.workspaceId ?? null,
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
		conversationEndedAt: input.conversationEndedAt ?? null,
	};
	const episode = await db.episodicMemory.upsert({
		where,
		create: {
			...where,
			...update,
			conversationStartedAt: input.conversationStartedAt,
			qdrantPointId: input.qdrantPointId ?? null,
			qdrantCollection: input.qdrantCollection ?? null,
		},
		update,
	});
	// Prisma runs this as INSERT ... ON CONFLICT DO UPDATE WHERE <owner>; when the
	// conversation belongs to another owner nothing is written and it returns null.
	if (!episode) {
		throw new Error("Episodic memory owner mismatch");
	}
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

	return filterAccessibleMemoryScopes(
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

	return filterAccessibleMemoryScopes(
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

	return filterAccessibleMemoryScopes(
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

	return filterAccessibleMemoryScopes(
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
	return filterAccessibleMemoryScopes(
		orderedEpisodes,
		userId,
		organizationId,
	);
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
export async function filterAccessibleMemoryScopes<
	T extends {
		projectId?: string | null;
		workspaceId?: string | null;
		workspaceIds?: string[];
	},
>(memories: T[], userId: string, organizationId?: string | null): Promise<T[]> {
	const projectIds = new Set(
		memories.flatMap((memory) =>
			memory.projectId ? [memory.projectId] : [],
		),
	);
	const workspaceIds = new Set(
		memories.flatMap((memory) => [
			...(memory.workspaceId ? [memory.workspaceId] : []),
			...(memory.workspaceIds ?? []),
		]),
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
	return memories.filter(
		(memory) =>
			(!memory.projectId || projects.get(memory.projectId) === true) &&
			(!memory.workspaceId ||
				workspaces.get(memory.workspaceId) === true) &&
			(memory.workspaceIds ?? []).every(
				(id) => workspaces.get(id) === true,
			),
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

	const context = {
		preferences,
		recentEpisodes,
		projectEpisodes,
		workspaceEpisodes,
		relevantEpisodes,
	};
	const conversationIds = [
		...new Set(
			[...repeatGroups(context).values()]
				.filter((group) => group.length > 1)
				.flatMap((group) =>
					group.map((episode) => episode.conversationId),
				),
		),
	].sort(compareText);
	// No record is evidence of unknown history, not a single-turn conversation.
	// ConversationTurn has a required organization; absent tenant scope fails closed.
	const counts =
		organizationId && conversationIds.length > 0
			? await db.conversationTurn.groupBy({
					by: ["conversationId"],
					where: {
						conversationId: { in: conversationIds },
						userId,
						organizationId,
					},
					_count: { _all: true },
				})
			: [];
	const countByConversation = new Map(
		counts.map((row) => [row.conversationId, row._count._all]),
	);
	for (const section of MEMORY_SECTION_PRIORITY) {
		context[section] = context[section].map((episode) => ({
			...episode,
			recordedTurnCount:
				countByConversation.get(episode.conversationId) ?? 0,
		}));
	}
	return context;
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

export type OrchestratorMemoryContext = {
	preferences: OrchestratorMemoryPreferencesData;
	recentEpisodes: EpisodeSummary[];
	projectEpisodes: EpisodeSummary[];
	workspaceEpisodes: EpisodeSummary[];
	relevantEpisodes: EpisodeSummary[];
};

// Query relevance, then scoped context, then general recency.
const MEMORY_SECTION_PRIORITY = [
	"relevantEpisodes",
	"projectEpisodes",
	"workspaceEpisodes",
	"recentEpisodes",
] as const;

// Between the observed 7.3 KB and 13.2 KB prompts; measured in UTF-8 bytes.
export const MAX_ORCHESTRATOR_MEMORY_BYTES = 8192;

// Short replies are not task identities; require a longer question to collapse.
const MIN_REPEAT_TITLE_WORDS = 5;

function normalizedText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function repeatTaskKey(episode: EpisodeSummary): string | null {
	const title = normalizedText(episode.title);
	if (title.split(" ").length < MIN_REPEAT_TITLE_WORDS) {
		return null;
	}
	return JSON.stringify([
		episode.projectId ?? null,
		episode.workspaceId ?? null,
		title,
	]);
}

function repeatGroups(context: OrchestratorMemoryContext) {
	const groups = new Map<string, EpisodeSummary[]>();
	const ids = new Set<string>();
	for (const section of MEMORY_SECTION_PRIORITY) {
		for (const episode of context[section]) {
			if (ids.has(episode.id)) {
				continue;
			}
			ids.add(episode.id);
			const key = repeatTaskKey(episode);
			if (key !== null) {
				const group = groups.get(key) ?? [];
				group.push(episode);
				groups.set(key, group);
			}
		}
	}
	return groups;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function episodeOrder(a: EpisodeSummary, b: EpisodeSummary): number {
	const time = (episode: EpisodeSummary) =>
		new Date(
			episode.conversationEndedAt ?? episode.conversationStartedAt,
		).getTime();
	return (
		time(b) - time(a) ||
		compareText(a.id, b.id) ||
		compareText(a.title, b.title) ||
		compareText(a.summary, b.summary) ||
		compareText(JSON.stringify(a.keyTopics), JSON.stringify(b.keyTopics))
	);
}

function deduplicateMemoryContext(
	input: OrchestratorMemoryContext,
): OrchestratorMemoryContext {
	const context: OrchestratorMemoryContext = {
		...input,
		relevantEpisodes: [],
		projectEpisodes: [],
		workspaceEpisodes: [],
		recentEpisodes: [],
	};
	const collapsibleTasks = new Set(
		[...repeatGroups(input)]
			.filter(
				([, group]) =>
					group.length > 1 &&
					group.every((episode) => episode.recordedTurnCount === 1),
			)
			.map(([key]) => key),
	);
	const ids = new Set<string>();
	const tasks = new Map<
		string,
		{ section: (typeof MEMORY_SECTION_PRIORITY)[number]; index: number }
	>();
	for (const section of MEMORY_SECTION_PRIORITY) {
		// Relevant episodes arrive in vector-search rank order. Other sections use
		// newest-first order with explicit tie-breaks, independent of query row order.
		const episodes =
			section === "relevantEpisodes"
				? input[section]
				: [...input[section]].sort(episodeOrder);
		for (const episode of episodes) {
			// Preserve ID precedence for copies of the same retrieved episode.
			if (ids.has(episode.id)) {
				continue;
			}
			ids.add(episode.id);
			const task = repeatTaskKey(episode);
			if (task === null || !collapsibleTasks.has(task)) {
				context[section].push(episode);
				continue;
			}
			const placement = tasks.get(task);
			if (placement) {
				const entries = context[placement.section];
				if (episodeOrder(episode, entries[placement.index]) < 0) {
					entries[placement.index] = episode;
				}
			} else {
				// First occurrence owns the best section and relevant search rank;
				// later attempts can replace its content without moving that slot.
				tasks.set(task, { section, index: context[section].length });
				context[section].push(episode);
			}
		}
	}
	for (const section of MEMORY_SECTION_PRIORITY) {
		if (section !== "relevantEpisodes") {
			context[section].sort(episodeOrder);
		}
	}
	return context;
}

/**
 * Bound the resolved text, including template headings, by removing complete
 * entries from the lowest-priority section. Preferences and template-only
 * text are preserved if they alone exceed the budget.
 */
export async function renderOrchestratorMemoryContext(
	input: OrchestratorMemoryContext,
	render: (
		variables: MemoryContextPromptVariables,
	) => Promise<string> = async (variables) => {
		const result = await renderTemplate({
			format: "HANDLEBARS",
			template: ORCHESTRATOR_MEMORY_FALLBACK_BODY,
			variables,
			escape: false,
		});
		if (result.error) {
			throw new Error(result.error);
		}
		return result.rendered.trim();
	},
): Promise<{ text: string; context: OrchestratorMemoryContext }> {
	const context = deduplicateMemoryContext(input);
	let text = await render(memoryContextPromptVariables(context));
	for (const section of [...MEMORY_SECTION_PRIORITY].reverse()) {
		while (
			Buffer.byteLength(text, "utf8") > MAX_ORCHESTRATOR_MEMORY_BYTES &&
			context[section].length > 0
		) {
			// The tail is the lowest search rank, or the oldest scoped/recent entry.
			context[section].pop();
			text = await render(memoryContextPromptVariables(context));
		}
	}
	// A bound template can intentionally omit a section. Count only lines present
	// in the resolved prompt, rather than retrieved rows or hidden variables.
	for (const section of MEMORY_SECTION_PRIORITY) {
		const line =
			section === "relevantEpisodes" ? relevantEpisodeLine : episodeLine;
		context[section] = context[section].filter((episode) =>
			text.includes(line(episode)),
		);
	}
	return { text, context };
}

export function buildMemoryContextPromptVariables(
	input: OrchestratorMemoryContext,
): MemoryContextPromptVariables {
	return memoryContextPromptVariables(deduplicateMemoryContext(input));
}

function memoryContextPromptVariables(
	context: OrchestratorMemoryContext,
): MemoryContextPromptVariables {
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

	const relevantLines = context.relevantEpisodes.map(relevantEpisodeLine);

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

function relevantEpisodeLine(episode: EpisodeSummary): string {
	const line = episodeLine(episode);
	return episode.keyTopics.length > 0
		? `${line}\n  Topics: ${episode.keyTopics.join(", ")}`
		: line;
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
