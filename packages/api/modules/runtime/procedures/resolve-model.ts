/**
 * Resolve Model Procedure
 *
 * Resolves model configuration for a tenant including the decrypted API key.
 * Used by agents to get the model to use for a specific task.
 */

import { ORPCError } from "@orpc/server";
import { canResolveOrganizationAiModels } from "@repo/database";
import { z } from "zod";
import { publicProcedure } from "../../../orpc/procedures";
import {
	hasScope,
	requireOrganizationKeyPermission,
	validateApiKey,
} from "../lib/api-key-auth";
import {
	modelUnavailableMessage,
	resolveModelForTenant,
} from "../lib/model-resolver";
import { ResolvedModelConfigSchema, TaskTypeSchema } from "../types";

export const resolveModelProcedure = publicProcedure
	.route({
		method: "POST",
		path: "/runtime/resolve-model",
		tags: ["Runtime"],
		summary: "Resolve model configuration for agent",
		description:
			"Gets the model configuration (provider, model ID, API key) for a tenant based on " +
			"their preferences and system defaults. Requires 'ai:models:resolve' scope.",
	})
	.input(
		z.object({
			apiKey: z.string().min(20, "Invalid API key format"),
			taskType: TaskTypeSchema,
		}),
	)
	.output(ResolvedModelConfigSchema)
	.handler(async ({ input }) => {
		// Validate API key
		const tenant = await validateApiKey(input.apiKey);

		if (!tenant) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Invalid or expired API key",
			});
		}

		// Check required scope
		if (!hasScope(tenant, "ai:models:resolve")) {
			throw new ORPCError("FORBIDDEN", {
				message: "API key lacks 'ai:models:resolve' scope",
			});
		}

		await requireOrganizationKeyPermission(
			tenant,
			canResolveOrganizationAiModels,
		);

		// Resolve model
		const modelConfig = await resolveModelForTenant(tenant, input.taskType);

		if (!modelConfig) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: await modelUnavailableMessage(tenant),
			});
		}

		return modelConfig;
	});
