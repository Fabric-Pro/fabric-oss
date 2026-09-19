import { ORPCError } from "@orpc/server";
import type { AIProvider, AiTaskType } from "@repo/database";
import {
	deleteOrgModelPreferencesByTaskType,
	getAiProviderApiKey,
	getAiProviderApiKeyByProvider,
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
	"DECISION",
]);

export const setOrgModelPreferenceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/preferences/org",
		tags: ["AI Config"],
		summary: "Set organization model preference",
		description:
			"Set a model override for a specific task type with the org's default provider, or switch a DECISION task off with a null model",
	})
	.input(
		z.object({
			organizationId: z.string(),
			taskType: AiTaskTypeEnum,
			// null = switch this task's model off. Only DECISION accepts it;
			// every other task type falls back to the system default, so
			// "off" there would have no coherent meaning. Removing a
			// preference entirely is `deleteOrg`, which restores the default.
			modelCanonicalName: z.string().nullable(),
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
			model: z
				.object({
					canonicalName: z.string(),
					displayName: z.string(),
				})
				.nullable(),
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

		// Use the override provider if specified (for specialized tasks like IMAGE, AUDIO, or DECISION),
		// otherwise fall back to the org's default provider
		const provider =
			(input.overrideProvider as AIProvider) ||
			(providerConfig.provider as AIProvider);
		const taskType = input.taskType as AiTaskType;
		const requestedModelCanonicalName = input.modelCanonicalName;
		const isDisableRequest = requestedModelCanonicalName === null;

		// Checked before the gateway precondition so the caller is told the
		// real problem: asking to switch off a task that has no off switch.
		if (isDisableRequest && taskType !== "DECISION") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Only decision tasks can be switched off. Remove the preference to use the default model for this task.",
			});
		}

		if (taskType === "DECISION") {
			const decisionProviderConfig = await getAiProviderApiKeyByProvider({
				userId: context.user.id,
				organizationId,
				provider: "VERCEL_GATEWAY",
			});

			if (
				provider !== "VERCEL_GATEWAY" ||
				decisionProviderConfig?.source !== "organization" ||
				!decisionProviderConfig.apiKey
			) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message:
						"Decision models require an organization Vercel AI Gateway configuration",
				});
			}
		}

		// Switching decisions off. The organization-owned Vercel gateway
		// precondition above already ran, so this is an admin of an org that
		// could have chosen a decision model deciding not to use one. Stored
		// as a row with no model rather than as an absent row, because an
		// absent row means "use the seeded default".
		if (isDisableRequest) {
			await deleteOrgModelPreferencesByTaskType(organizationId, taskType);

			const preference = await setOrgModelPreference({
				organizationId,
				provider,
				taskType,
				modelId: null,
				customParameters: input.customParameters,
			});

			return {
				id: preference.id,
				provider: preference.provider,
				taskType: preference.taskType,
				model: null,
			};
		}

		// Verify the model exists
		const model = await getModelByCanonicalName(
			requestedModelCanonicalName,
		);

		if (!model) {
			throw new ORPCError("NOT_FOUND", {
				message: `Model ${requestedModelCanonicalName} not found in catalog`,
			});
		}

		if (taskType === "DECISION") {
			if (
				!model.suitableForTasks.includes("DECISION") ||
				provider !== "VERCEL_GATEWAY" ||
				!model.capabilities.includes("EVALUATION") ||
				!model.providerMappings.some(
					(mapping) => mapping.provider === "VERCEL_GATEWAY",
				)
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Decision tasks require an evaluation model through Vercel AI Gateway.",
				});
			}
		} else if (model.capabilities.includes("EVALUATION")) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Evaluation models can only be configured for DECISION tasks.",
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
					message: `Model "${requestedModelCanonicalName}" is not available for provider "${provider}".`,
				});
			}
		}

		// Delete any existing preferences for this task type (regardless of provider)
		// This prevents duplicates when org switches between providers for the same task
		await deleteOrgModelPreferencesByTaskType(organizationId, taskType);

		const preference = await setOrgModelPreference({
			organizationId,
			provider,
			taskType,
			modelId: model.id,
			customParameters: input.customParameters,
		});

		return {
			id: preference.id,
			provider: preference.provider,
			taskType: preference.taskType,
			// `preference.model` is nullable now that a row can carry no
			// model, but this branch just wrote `model.id`, so fall back to
			// the catalog row rather than reporting a null the caller would
			// read as "switched off".
			model: {
				canonicalName:
					preference.model?.canonicalName ?? model.canonicalName,
				displayName: preference.model?.displayName ?? model.displayName,
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

		try {
			await deleteOrgModelPreferencesByTaskType(
				organizationId,
				input.taskType as AiTaskType,
			);
			return { success: true };
		} catch {
			return { success: false };
		}
	});
