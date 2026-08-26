/**
 * Resolve Model Procedure
 *
 * Resolves model configuration for a tenant including the decrypted API key.
 * Used by agents to get the model to use for a specific task.
 */

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";
import { hasScope, validateApiKey } from "../lib/api-key-auth";
import { resolveModelForTenant } from "../lib/model-resolver";
import { ResolvedModelConfigSchema, TaskTypeSchema } from "../types";

export const resolveModelProcedure = publicProcedure
	.use(requirePermission(Permissions.AGENT_EXECUTE))
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
		if (!hasScope(tenant, "ai:models:resolve") && !hasScope(tenant, "*")) {
			throw new ORPCError("FORBIDDEN", {
				message: "API key lacks 'ai:models:resolve' scope",
			});
		}

		// Resolve model
		const modelConfig = await resolveModelForTenant(tenant, input.taskType);

		if (!modelConfig) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"No AI provider configured. Please configure at least one provider in settings.",
			});
		}

		return modelConfig;
	});
