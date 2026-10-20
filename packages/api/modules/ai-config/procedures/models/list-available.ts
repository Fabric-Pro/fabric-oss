/**
 * List Available Models for User
 *
 * Returns models available through the user's configured AI providers.
 *
 * Behavior varies by task type:
 * - GENERAL tasks (CHAT, TOOL_CALLING, etc.): Only DEFAULT provider's models
 *   This prevents routing confusion between multiple providers.
 * - SPECIALIZED tasks (IMAGE, AUDIO, EMBEDDING): ALL capable configured providers
 *   This allows users to use OpenAI for images even when default is Azure/Anthropic.
 *
 * Flow:
 * 1. Query configured providers from user_cloud_provider_config or cloud_provider_config
 * 2. Find the DEFAULT provider
 * 3. For specialized tasks: find all configured providers that support the capability
 * 4. Query models from effective providers
 * 5. Return models grouped by vendor (for UI organization)
 */

import { AiProviderPurposeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { listAvailableModels } from "../../lib/available-models";

const AiTaskTypeEnum = z.enum([
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EMBEDDING",
	"IMAGE",
	"AUDIO",
	"EVAL",
	"DECISION",
]);

// Gateway providers can have sub-providers configured (e.g., Vercel Gateway -> Groq, OpenAI)
// Cloud platforms like Azure/AWS/GCP are treated as direct providers in the database
export const listAvailableModelsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/models/available",
		tags: ["AI Config"],
		summary: "List available AI models for user",
		description:
			"Get AI models available through the user's configured gateways and their enabled providers",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			taskType: AiTaskTypeEnum.optional(),
			// The work the ChatGPT plan answer is for, when it differs from
			// the provider listing's: Advisor lists chat models but runs tool
			// calling, so its plan "Default" must be that task's (F13).
			planTaskType: AiTaskTypeEnum.optional(),
		}),
	)
	.output(
		z.object({
			// Configured gateways with their enabled providers
			configuredProviders: z.array(
				z.object({
					id: z.string(),
					provider: z.string(),
					displayName: z.string().nullable(),
					isDefault: z.boolean(),
					priority: z.number(),
					enabledProviders: z.array(z.string()),
					purpose: AiProviderPurposeSchema,
					source: z.string(),
				}),
			),
			// Default gateway/provider
			defaultProvider: z.string().nullable(),
			// All enabled provider IDs (for filtering models)
			providerIds: z.array(z.string()),
			// Models list
			models: z.array(
				z.object({
					id: z.string(),
					canonicalName: z.string(),
					displayName: z.string(),
					description: z.string().nullable(),
					family: z.string(),
					vendor: z.string(),
					contextWindow: z.number(),
					speedTier: z.string(),
					qualityTier: z.string(),
					suitableForTasks: z.array(z.string()),
					providerMappings: z.array(
						z.object({
							provider: z.string(),
							providerModelId: z.string(),
							isAvailable: z.boolean(),
						}),
					),
				}),
			),
			// Grouped by provider for UI
			modelsByProvider: z.record(
				z.string(),
				z.array(
					z.object({
						id: z.string(),
						canonicalName: z.string(),
						displayName: z.string(),
						providerModelId: z.string(),
						speedTier: z.string(),
						qualityTier: z.string(),
						// Extended data for hover submenu
						description: z.string().nullable().optional(),
						family: z.string().optional(),
						vendor: z.string().optional(),
						contextWindow: z.number().optional(),
						capabilities: z.array(z.string()).optional(),
						inputCostPer1M: z.number().nullable().optional(),
						outputCostPer1M: z.number().nullable().optional(),
					}),
				),
			),
			// The ChatGPT plan that runs the caller's own work of this task
			// instead of any provider below (Fizzy #2770): the member's own
			// plan or one the organization shares.
			chatgptPlan: z
				.object({
					model: z.string(),
					source: z.enum(["own", "shared"]),
					// What a chat may pick instead (Fizzy #2770 F13): the
					// models the serving plan lists.
					models: z.array(
						z.object({
							canonicalName: z.string(),
							slug: z.string(),
							displayName: z.string(),
							isDefault: z.boolean(),
							newest: z.boolean(),
						}),
					),
					// Every plan serving the member is spent: nothing runs
					// until the reset, and no provider model stands in.
					spent: z.object({ until: z.date().nullable() }).optional(),
				})
				.nullable()
				.optional(),
			// Hierarchical: Gateway → Provider → Models (for route selection UI)
			modelsByGatewayAndProvider: z.record(
				z.string(), // Gateway provider (e.g., VERCEL_GATEWAY, OPENAI_DIRECT)
				z.object({
					gatewayDisplayName: z.string(),
					isDefault: z.boolean(),
					providers: z.record(
						z.string(), // Sub-provider (e.g., GROQ, OPENAI_DIRECT)
						z.object({
							providerDisplayName: z.string(),
							models: z.array(
								z.object({
									id: z.string(),
									canonicalName: z.string(),
									displayName: z.string(),
									providerModelId: z.string(),
									speedTier: z.string(),
									qualityTier: z.string(),
									capabilities: z
										.array(z.string())
										.optional(),
								}),
							),
						}),
					),
				}),
			),
		}),
	)
	.handler(async ({ context: { user, session }, input }) =>
		listAvailableModels({
			...input,
			userId: user.id,
			organizationId: resolveOrganizationId(
				input.organizationId,
				session,
			),
			sessionOrganizationId: resolveOrganizationId(undefined, session),
		}),
	);
