import { ORPCError } from "@orpc/server";
import type { AIProvider } from "@repo/database";
import { getAiProviderApiKey, getModelForTask } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
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
]);

const TaskComplexityEnum = z.enum(["SIMPLE", "MEDIUM", "COMPLEX"]);

export const resolveModelProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_EDIT))
	.route({
		method: "POST",
		path: "/ai-config/resolve-model",
		tags: ["AI Config"],
		summary: "Resolve the best model for a task",
		description:
			"Get the recommended model based on task type and user's default provider. " +
			"Uses user override if set, otherwise system default for the provider.",
	})
	.input(
		z.object({
			taskType: AiTaskTypeEnum,
			complexity: TaskComplexityEnum.optional().default("MEDIUM"),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			canonicalName: z.string(),
			displayName: z.string(),
			providerModelId: z.string(),
			provider: z.string(),
			source: z.string(),
			contextWindow: z.number(),
			inputCostPer1M: z.number().nullable(),
			outputCostPer1M: z.number().nullable(),
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

		if (!providerConfig.provider) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"No AI provider configured. Please configure a default provider in settings.",
			});
		}

		const provider = providerConfig.provider as AIProvider;

		// Get model for this task type and provider
		const result = await getModelForTask(
			user.id,
			provider,
			input.taskType,
			organizationId,
			input.complexity,
		);

		if (!result?.model) {
			throw new ORPCError("NOT_FOUND", {
				message: `No model configured for task type ${input.taskType} with provider ${provider}`,
			});
		}

		const model = result.model;
		const providerMapping = model.providerMappings?.find(
			(m) => m.provider === provider,
		);

		return {
			canonicalName: model.canonicalName,
			displayName: model.displayName,
			providerModelId: result.providerModelId ?? model.canonicalName,
			provider,
			source: result.source,
			contextWindow:
				providerMapping?.maxContextWindow ?? model.contextWindow,
			inputCostPer1M:
				providerMapping?.inputCostPer1M ?? model.inputCostPer1M,
			outputCostPer1M:
				providerMapping?.outputCostPer1M ?? model.outputCostPer1M,
		};
	});
