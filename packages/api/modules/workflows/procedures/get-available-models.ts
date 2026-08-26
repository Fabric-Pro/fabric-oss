/**
 * Get Available AI Models from Vercel AI Gateway
 * Fetches the list of models available via the public Vercel AI Gateway API
 */

import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const ModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	provider: z.string(),
	type: z.string(),
	contextWindow: z.number().optional(),
	maxTokens: z.number().optional(),
	description: z.string().optional(),
});

const GetAvailableModelsOutputSchema = z.object({
	models: z.array(ModelSchema),
});

// Allowed providers - restrict to OpenAI and Anthropic only
const ALLOWED_PROVIDERS = ["openai", "anthropic"];

export const getAvailableModels = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.input(
		z.object({
			// Filter by model type (language, embedding, image)
			type: z
				.enum(["language", "embedding", "image", "all"])
				.default("language"),
		}),
	)
	.output(GetAvailableModelsOutputSchema)
	.handler(async ({ input }) => {
		const { type } = input;

		try {
			// Fetch models from Vercel AI Gateway public API
			const response = await fetch(
				"https://ai-gateway.vercel.sh/v1/models",
				{
					method: "GET",
					headers: {
						"Content-Type": "application/json",
					},
				},
			);

			if (!response.ok) {
				console.error(
					"[Get Available Models] API error:",
					response.statusText,
				);
				throw new Error(
					`Failed to fetch models: ${response.statusText}`,
				);
			}

			const data = await response.json();

			// Transform and filter the response
			// Only include models from allowed providers (OpenAI and Anthropic)
			const models = (data.data || [])
				.filter((model: any) => {
					const matchesType = type === "all" || model.type === type;
					const matchesProvider = ALLOWED_PROVIDERS.includes(
						model.owned_by,
					);
					return matchesType && matchesProvider;
				})
				.map((model: any) => ({
					id: model.id,
					name: model.name || model.id,
					provider: model.owned_by || "unknown",
					type: model.type || "language",
					contextWindow: model.context_window,
					maxTokens: model.max_tokens,
					description: model.description,
				}));

			console.log(
				`[Get Available Models] Found ${models.length} ${type} models (filtered to OpenAI and Anthropic)`,
			);

			return { models };
		} catch (error) {
			console.error("[Get Available Models] Error:", error);
			throw new Error("Failed to fetch available models from AI Gateway");
		}
	});
