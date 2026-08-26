/**
 * Resolve Model for External Agents
 *
 * This endpoint allows external agents to get model configuration via API key
 * authentication. Unlike internal endpoints, this doesn't require session auth -
 * instead it uses the API key to identify the user/organization context.
 *
 * Features:
 * - API key authentication (user or organization keys)
 * - Model resolution based on task type
 * - Uses the user's configured default provider
 * - Returns cached-friendly response with TTL hint
 *
 * Agents should cache the response and refresh based on the cacheTtlSeconds hint.
 */

import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AIProvider, AiTaskType } from "@repo/database";
import { db, getAiProviderApiKey, getModelForTask } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../../orpc/procedures";

const TaskTypeSchema = z.enum([
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EMBEDDING",
	"IMAGE",
	"AUDIO",
]);

/**
 * Verify API key and return context
 */
async function verifyApiKey(apiKey: string): Promise<{
	userId: string;
	organizationId?: string;
	scopes: string[];
}> {
	const keyHash = createHash("sha256").update(apiKey).digest("hex");

	// Try user API key first
	const userApiKey = await db.userApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: { id: true, userId: true, scopes: true },
	});

	if (userApiKey) {
		await db.userApiKey.update({
			where: { id: userApiKey.id },
			data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
		});
		return { userId: userApiKey.userId, scopes: userApiKey.scopes };
	}

	// Try organization API key
	const orgApiKey = await db.organizationApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: {
			id: true,
			organizationId: true,
			createdByUserId: true,
			scopes: true,
		},
	});

	if (orgApiKey) {
		await db.organizationApiKey.update({
			where: { id: orgApiKey.id },
			data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
		});
		return {
			userId: orgApiKey.createdByUserId,
			organizationId: orgApiKey.organizationId,
			scopes: orgApiKey.scopes,
		};
	}

	throw new ORPCError("UNAUTHORIZED", {
		message: "Invalid or expired API key",
	});
}

function hasScope(scopes: string[], requiredScope: string): boolean {
	return scopes.includes(requiredScope) || scopes.includes("*");
}

export const resolveModelForAgentProcedure = publicProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/resolve-for-agent",
		tags: ["AI Config", "Agents"],
		summary: "Resolve AI model for external agents",
		description:
			"Get model configuration for a task type using API key authentication. " +
			"Uses the user's configured default provider. " +
			"Agents should cache the response and refresh based on cacheTtlSeconds.",
	})
	.input(
		z.object({
			apiKey: z.string().min(1, "API key is required"),
			taskType: TaskTypeSchema,
		}),
	)
	.output(
		z.object({
			provider: z.string(),
			providerModelId: z.string(),
			modelString: z.string(),
			userId: z.string(),
			organizationId: z.string().nullable(),
			selectionSource: z.enum([
				"user_override",
				"org_override",
				"system_default",
			]),
			cacheTtlSeconds: z.number(),
		}),
	)
	.handler(async ({ input }) => {
		// Verify API key and get context
		const context = await verifyApiKey(input.apiKey);

		// Check scope
		if (
			!hasScope(context.scopes, "ai:models:resolve") &&
			!hasScope(context.scopes, "ai:models:read")
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"API key does not have ai:models:resolve or ai:models:read scope",
			});
		}

		const { userId, organizationId } = context;

		// Get user's default provider
		const providerConfig = await getAiProviderApiKey({
			userId,
			organizationId,
		});

		if (!providerConfig.provider) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"No AI provider configured. Please configure a default provider in settings.",
			});
		}

		const provider = providerConfig.provider as AIProvider;

		// Use simplified model resolution
		const result = await getModelForTask(
			userId,
			provider,
			input.taskType as AiTaskType,
			organizationId,
		);

		if (!result?.model) {
			throw new ORPCError("NOT_FOUND", {
				message: `No model available for task type ${input.taskType} with provider ${provider}.`,
			});
		}

		// Get providerModelId, fallback to canonical name if not available
		const providerModelId =
			result.providerModelId ?? result.model.canonicalName;

		// Build provider prefix for model string
		const providerPrefix = provider
			.toLowerCase()
			.replace("_direct", "")
			.replace("_gateway", "");

		return {
			provider,
			providerModelId,
			modelString: `${providerPrefix}/${providerModelId}`,
			userId,
			organizationId: organizationId ?? null,
			selectionSource: result.source,
			cacheTtlSeconds: result.source === "system_default" ? 600 : 300,
		};
	});
