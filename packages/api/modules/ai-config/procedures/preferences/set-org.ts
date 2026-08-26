import { ORPCError } from "@orpc/server";
import type { AIProvider, AiTaskType } from "@repo/database";
import {
	deleteOrgModelPreference,
	deleteOrgModelPreferencesByTaskType,
	getAiProviderApiKey,
	getModelByCanonicalName,
	isGatewayProvider,
	setOrgModelPreference,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

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

export const setOrgModelPreferenceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/preferences/org",
		tags: ["AI Config"],
		summary: "Set organization model preference",
		description:
			"Set a model override for a specific task type with the org's default provider",
	})
	.input(
		z.object({
			organizationId: z.string(),
			taskType: AiTaskTypeEnum,
			modelCanonicalName: z.string(),
			customParameters: z.record(z.string(), z.unknown()).optional(),
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
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Organization ID is required",
			});
		}

		// Verify user is an admin or owner of the organization
		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["owner", "admin"],
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only organization admins can set model preferences",
			});
		}

		// Get org's default provider
		const providerConfig = await getAiProviderApiKey({
			userId: context.user.id,
			organizationId,
		});

		if (!providerConfig.provider && !input.overrideProvider) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"No AI provider configured. Please configure a default provider first.",
			});
		}

		// Use the override provider if specified (for specialized tasks like IMAGE/AUDIO),
		// otherwise fall back to the org's default provider
		const provider =
			(input.overrideProvider as AIProvider) ||
			(providerConfig.provider as AIProvider);

		// Verify the model exists
		const model = await getModelByCanonicalName(input.modelCanonicalName);

		if (!model) {
			throw new ORPCError("NOT_FOUND", {
				message: `Model ${input.modelCanonicalName} not found in catalog`,
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
		// This prevents duplicates when org switches between providers for the same task
		await deleteOrgModelPreferencesByTaskType(
			organizationId,
			input.taskType as AiTaskType,
		);

		const preference = await setOrgModelPreference({
			organizationId,
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

export const deleteOrgModelPreferenceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "DELETE",
		path: "/ai-config/preferences/org",
		tags: ["AI Config"],
		summary: "Delete organization model preference",
		description:
			"Remove a model override for a task type (reverts to system default)",
	})
	.input(
		z.object({
			organizationId: z.string(),
			taskType: AiTaskTypeEnum,
		}),
	)
	.output(z.object({ success: z.boolean() }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Organization ID is required",
			});
		}

		// Verify user is an admin or owner of the organization
		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["owner", "admin"],
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization admins can delete model preferences",
			});
		}

		// Get org's default provider
		const providerConfig = await getAiProviderApiKey({
			userId: context.user.id,
			organizationId,
		});

		if (!providerConfig.provider) {
			return { success: false };
		}

		const provider = providerConfig.provider as AIProvider;

		try {
			await deleteOrgModelPreference(
				organizationId,
				input.taskType as AiTaskType,
				provider,
			);
			return { success: true };
		} catch {
			return { success: false };
		}
	});
