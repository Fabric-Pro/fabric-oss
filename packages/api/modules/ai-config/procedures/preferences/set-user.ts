import { ORPCError } from "@orpc/server";
import type { AIProvider, AiTaskType } from "@repo/database";
import {
	deleteUserModelPreference,
	deleteUserModelPreferencesByTaskType,
	getAiProviderApiKey,
	getModelByCanonicalName,
	isGatewayProvider,
	setUserModelPreference,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

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
]);

export const setUserModelPreferenceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/preferences/user",
		tags: ["AI Config"],
		summary: "Set user model preference",
		description:
			"Set a model override for a specific task type with the current default provider",
	})
	.input(
		z.object({
			taskType: AiTaskTypeEnum,
			modelCanonicalName: z.string(),
			customParameters: z.record(z.string(), z.unknown()).optional(),
			organizationId: z.string().nullable().optional(),
			// Allow specifying a different provider for specialized tasks (IMAGE, AUDIO)
			overrideProvider: z.string().optional(),
		}),
	)
	.output(
		z.object({
			id: z.string(),
			provider: z.string(),
			taskType: z.string(),
			model: z.object({
				canonicalName: z.string(),
				displayName: z.string(),
			}),
		}),
	)
	.handler(async ({ input, context: { user, session } }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Get user's default provider
		const providerConfig = await getAiProviderApiKey({
			userId: user.id,
			organizationId,
		});

		if (!providerConfig.provider && !input.overrideProvider) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"No AI provider configured. Please configure a default provider first.",
			});
		}

		// Use the override provider if specified (for specialized tasks like IMAGE/AUDIO),
		// otherwise fall back to the user's default provider
		const provider =
			(input.overrideProvider as AIProvider) ||
			(providerConfig.provider as AIProvider);

		// Verify the model exists
		const model = await getModelByCanonicalName(input.modelCanonicalName);

		if (!model) {
			throw new ORPCError("NOT_FOUND", {
				message: `Model "${input.modelCanonicalName}" not found in catalog.`,
			});
		}

		// Verify the model has a mapping for this provider
		// Gateway providers can route to any model, so skip mapping check for them
		if (!isGatewayProvider(provider)) {
			const hasMapping = model.providerMappings.some(
				(m) => m.provider === provider,
			);
			if (!hasMapping) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Model "${input.modelCanonicalName}" is not available for provider "${provider}".`,
				});
			}
		}

		// Delete any existing preferences for this task type (regardless of provider)
		// This prevents duplicates when user switches between providers for the same task
		await deleteUserModelPreferencesByTaskType(
			user.id,
			input.taskType as AiTaskType,
		);

		const preference = await setUserModelPreference({
			userId: user.id,
			provider,
			taskType: input.taskType as AiTaskType,
			modelId: model.id,
			customParameters: input.customParameters,
		});

		return {
			id: preference.id,
			provider: preference.provider,
			taskType: preference.taskType,
			model: {
				canonicalName: preference.model.canonicalName,
				displayName: preference.model.displayName,
			},
		};
	});

export const deleteUserModelPreferenceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "DELETE",
		path: "/ai-config/preferences/user",
		tags: ["AI Config"],
		summary: "Delete user model preference",
		description:
			"Remove a model override for a task type (reverts to system default)",
	})
	.input(
		z.object({
			taskType: AiTaskTypeEnum,
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ success: z.boolean() }))
	.handler(async ({ input, context: { user, session } }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Get user's default provider
		const providerConfig = await getAiProviderApiKey({
			userId: user.id,
			organizationId,
		});

		if (!providerConfig.provider) {
			return { success: false };
		}

		const provider = providerConfig.provider as AIProvider;

		try {
			await deleteUserModelPreference(
				user.id,
				input.taskType as AiTaskType,
				provider,
			);
			return { success: true };
		} catch {
			return { success: false };
		}
	});
