/**
 * Suggest Skills Procedure
 *
 * Analyzes a user message and suggests relevant skills from the tenant's
 * skill catalog. Uses a lightweight LLM call with SIMPLE task type.
 *
 * TENANT ISOLATION: Uses XOR pattern - SYSTEM skills visible to all,
 * ORG skills isolated to org members, USER skills isolated to owner.
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { listSkills } from "@repo/database";
import { generateObject, zodSchema } from "ai";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const suggestSkillsInputSchema = z.object({
	message: z.string().min(1).max(2000),
	organizationId: z.string().nullable().optional(),
	conversationId: z.string().optional(),
});

export interface SkillSuggestion {
	skillId: string;
	name: string;
	reason: string;
	confidence: number;
}

interface CachedSkills {
	skills: Array<{
		id: string;
		name: string;
		description: string;
		slug: string;
	}>;
	timestamp: number;
}

// Bounded in-memory cache for skill catalogs per tenant (60s TTL).
// Map preserves insertion order, so deleting the first key acts as FIFO
// eviction once we exceed CACHE_MAX_ENTRIES.
const skillCatalogCache = new Map<string, CachedSkills>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

function getCacheKey(
	userId: string,
	organizationId: string | undefined,
): string {
	return organizationId
		? `${userId}:${organizationId}`
		: `${userId}:personal`;
}

function getCachedSkills(
	userId: string,
	organizationId: string | undefined,
): CachedSkills | null {
	const key = getCacheKey(userId, organizationId);
	const cached = skillCatalogCache.get(key);
	if (!cached) {
		return null;
	}
	if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
		skillCatalogCache.delete(key);
		return null;
	}
	return cached;
}

function setCachedSkills(
	userId: string,
	organizationId: string | undefined,
	skills: CachedSkills["skills"],
): void {
	const key = getCacheKey(userId, organizationId);
	if (
		!skillCatalogCache.has(key) &&
		skillCatalogCache.size >= CACHE_MAX_ENTRIES
	) {
		const oldestKey = skillCatalogCache.keys().next().value;
		if (oldestKey !== undefined) {
			skillCatalogCache.delete(oldestKey);
		}
	}
	skillCatalogCache.set(key, { skills, timestamp: Date.now() });
}

const SuggestionsSchema = z.object({
	suggestions: z
		.array(
			z.object({
				skillId: z.string().optional(),
				name: z.string().optional(),
				reason: z.string().default(""),
				confidence: z.number().min(0).max(1).default(0.7),
			}),
		)
		.max(10),
});

function resolveSuggestions(
	parsed: z.infer<typeof SuggestionsSchema>,
	availableSkills: CachedSkills["skills"],
): SkillSuggestion[] {
	const resolved: SkillSuggestion[] = [];
	for (const item of parsed.suggestions) {
		const skill = availableSkills.find(
			(s) => s.id === item.skillId || s.name === item.name,
		);
		if (!skill) {
			continue;
		}
		resolved.push({
			skillId: skill.id,
			name: skill.name,
			reason: item.reason,
			confidence: item.confidence,
		});
	}
	return resolved.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure with XOR pattern.
 * Fetches skills visible to the tenant (SYSTEM + ORG + USER) and
 * uses a lightweight LLM to suggest which skills might help with
 * the user's message.
 */
export const suggestSkillsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.SKILL_READ))
	.route({
		method: "POST",
		path: "/agents/suggest-skills",
		tags: ["Agents"],
		summary: "Suggest relevant skills for a user message",
	})
	.input(suggestSkillsInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Fetch skills from cache or database
		let cached = getCachedSkills(context.user.id, organizationId);
		if (!cached) {
			const { skills } = await listSkills({
				userId: context.user.id,
				organizationId: organizationId ?? null,
				isPublished: true,
				limit: 200,
				sortBy: "useCount",
				sortOrder: "desc",
			});

			const skillList = skills.map((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				slug: s.slug,
			}));

			setCachedSkills(context.user.id, organizationId, skillList);
			cached = { skills: skillList, timestamp: Date.now() };
		}

		// No skills available - return empty
		if (cached.skills.length === 0) {
			return { suggestions: [] as SkillSuggestion[] };
		}

		// Build prompt with skill catalog
		const skillListText = cached.skills
			.map((s, i) => `${i + 1}. ${s.name}: ${s.description}`)
			.join("\n");

		const prompt = `Given this user message, suggest up to 3 skills from the catalog that would be most helpful.

User message: """${input.message.slice(0, 1000)}"""

Available skills:
${skillListText}

For each suggestion, populate skillId from the catalog above, a short reason
why the skill helps, and a confidence between 0 and 1. If no skills are
relevant, return { "suggestions": [] }.`;

		try {
			const { model, trackUsage } = await getAIModelWithMetadata(
				{ taskType: "SIMPLE" },
				{
					userId: context.user.id,
					organizationId: organizationId ?? undefined,
				},
			);

			const { object } = await generateObject({
				model,
				schema: zodSchema(SuggestionsSchema),
				prompt,
			});

			// Track usage fire-and-forget
			trackUsage();

			return { suggestions: resolveSuggestions(object, cached.skills) };
		} catch (error) {
			console.error("[SuggestSkills] LLM error:", error);
			// Graceful fallback: return empty array on any error
			return { suggestions: [] as SkillSuggestion[] };
		}
	});
