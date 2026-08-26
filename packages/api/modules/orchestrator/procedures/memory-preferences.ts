/**
 * Orchestrator Memory Preferences API
 *
 * Endpoints for managing user preferences for the Orchestrator:
 * - Get preferences (with defaults)
 * - Update preferences
 * - Clear learned patterns
 * - Get episodic memory history
 */

import {
	deleteEpisodicMemory,
	getOrchestratorMemoryPreferences,
	getRecentEpisodes,
	removeLearnedPattern,
	searchEpisodicMemories,
	updateOrchestratorMemoryPreferences,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// =============================================================================
// SCHEMAS
// =============================================================================

const preferencesUpdateSchema = z.object({
	organizationId: z.string().nullable().optional(),
	responseStyle: z
		.enum(["detailed", "concise", "bullet_points", "conversational"])
		.optional(),
	verbosity: z
		.enum(["minimal", "concise", "standard", "detailed"])
		.optional(),
	codeLanguage: z.string().optional(),
	timezone: z.string().optional(),
	preferences: z.record(z.string(), z.unknown()).optional(),
});

const episodesQuerySchema = z.object({
	organizationId: z.string().nullable().optional(),
	projectId: z.string().optional(),
	workspaceId: z.string().optional(),
	limit: z.number().min(1).max(50).default(20),
	offset: z.number().min(0).default(0),
});

const searchEpisodesSchema = z.object({
	organizationId: z.string().nullable().optional(),
	query: z.string().min(3),
	projectId: z.string().optional(),
	workspaceId: z.string().optional(),
	limit: z.number().min(1).max(20).default(10),
});

// =============================================================================
// PROCEDURES
// =============================================================================

/**
 * Get orchestrator memory preferences for the current user
 */
export const getPreferences = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/orchestrator/memory/preferences",
		tags: ["Orchestrator Memory"],
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const preferences = await getOrchestratorMemoryPreferences(
			context.user.id,
			orgId,
		);

		return {
			preferences,
			isDefault: !preferences.responseStyle && !preferences.verbosity,
		};
	});

/**
 * Update orchestrator memory preferences
 */
export const updatePreferences = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/orchestrator/memory/preferences",
		tags: ["Orchestrator Memory"],
	})
	.input(preferencesUpdateSchema)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const updated = await updateOrchestratorMemoryPreferences(
			context.user.id,
			orgId,
			{
				responseStyle: input.responseStyle,
				verbosity: input.verbosity,
				codeLanguage: input.codeLanguage,
				timezone: input.timezone,
				preferences: input.preferences as Record<string, unknown>,
			},
		);

		return {
			success: true,
			preferences: updated,
		};
	});

/**
 * Clear all learned patterns (reset to defaults)
 */
export const clearLearnedPatterns = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/orchestrator/memory/preferences/clear-patterns",
		tags: ["Orchestrator Memory"],
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const _updated = await updateOrchestratorMemoryPreferences(
			context.user.id,
			orgId,
			{
				preferences: { learnedPatterns: [] },
			},
		);

		return {
			success: true,
			message: "Learned patterns cleared",
		};
	});

/**
 * Get recent episodic memories (conversation history)
 */
export const getEpisodes = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/orchestrator/memory/episodes",
		tags: ["Orchestrator Memory"],
	})
	.input(episodesQuerySchema)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const episodes = await getRecentEpisodes(
			context.user.id,
			orgId,
			input.limit,
		);

		return {
			episodes,
			total: episodes.length,
		};
	});

/**
 * Search episodic memories by keyword
 */
export const searchEpisodes = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "POST",
		path: "/orchestrator/memory/episodes/search",
		tags: ["Orchestrator Memory"],
	})
	.input(searchEpisodesSchema)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const episodes = await searchEpisodicMemories({
			userId: context.user.id,
			organizationId: orgId,
			projectId: input.projectId,
			workspaceId: input.workspaceId,
			keyTopics: [input.query],
			limit: input.limit,
		});

		return {
			episodes,
			query: input.query,
		};
	});

/**
 * Delete a specific learned pattern
 */
export const deletePattern = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "DELETE",
		path: "/orchestrator/memory/preferences/patterns",
		tags: ["Orchestrator Memory"],
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			pattern: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		await removeLearnedPattern(context.user.id, orgId, input.pattern);

		return {
			success: true,
			message: "Pattern deleted",
		};
	});

/**
 * Delete a specific episode from conversation memory
 */
export const deleteEpisode = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "DELETE",
		path: "/orchestrator/memory/episodes",
		tags: ["Orchestrator Memory"],
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			episodeId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const deleted = await deleteEpisodicMemory(
			input.episodeId,
			context.user.id,
			orgId,
		);

		if (!deleted) {
			return {
				success: false,
				message: "Episode not found or access denied",
			};
		}

		return {
			success: true,
			message: "Episode deleted",
		};
	});
