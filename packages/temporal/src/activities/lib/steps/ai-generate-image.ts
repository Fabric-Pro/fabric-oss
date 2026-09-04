/**
 * AI Generate Image Step
 * Generates images using AI models via Vercel AI Gateway
 *
 * Features:
 * - Fabric AI enrichment for prompt enhancement
 * - Auto-detection or explicit strategy/context/pattern for better prompts
 *
 * Fabric AI Integration:
 * Node config can include:
 * - fabricStrategy: Reasoning for prompt enhancement
 * - fabricContext: Expertise context (e.g., graphic_designer)
 * - fabricPattern: Pattern for prompt crafting
 * - fabricAutoDetect: Enable auto-detection (default: true)
 */

import {
	createGateway,
	experimental_generateImage as generateImage,
	generateText,
	getAIModelWithMetadata,
	getRAGProviderConfig,
} from "@repo/ai";
import { logAiUsageAsync } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	applyFabricEnrichment,
	extractFabricConfig,
} from "./fabric-enrichment";
import { interpolateTemplate } from "./utils";

export async function executeAiGenerateImageStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		imagePrompt,
		imageModel = "google/imagen-4.0-generate-001",
		imageSize = "1024x1024",
		enhancePrompt = false,
	} = params.nodeConfig as {
		imagePrompt?: string;
		imageModel?: string;
		imageSize?: string;
		enhancePrompt?: boolean;
	};

	if (!imagePrompt) {
		return { success: false, error: "Image prompt is required" };
	}

	let interpolatedPrompt = interpolateTemplate(imagePrompt, params.inputs);

	try {
		// TENANT resolver: a workflow-builder image step runs because someone
		// executed the workflow, so this is not the background work the system
		// half is reserved for. Same rule as `image-generation.ts`.
		const providerConfig = await getRAGProviderConfig({
			userId: params.userId,
			organizationId: params.organizationId,
		});

		const apiKey = providerConfig.apiKey;

		// If prompt enhancement is enabled, use Fabric AI to improve the prompt
		let enhancedPrompt: string | undefined;
		if (enhancePrompt) {
			const fabricConfig = extractFabricConfig(params.nodeConfig);
			const enrichment = await applyFabricEnrichment(
				interpolatedPrompt,
				fabricConfig,
				"You are an expert image prompt engineer. Enhance the following image generation prompt to be more detailed and descriptive while preserving the original intent. Output only the enhanced prompt, nothing else.",
			);

			if (enrichment.fabricUsed && enrichment.systemPrompt) {
				// Use centralized AI model for prompt enhancement
				const { model } = await getAIModelWithMetadata(
					{ taskType: "SIMPLE" },
					{
						userId: params.userId,
						organizationId: params.organizationId,
						projectId: params.projectId,
						jobType: params.jobType,
					},
				);

				const enhanceResult = await generateText({
					model,
					prompt: `Enhance this image prompt: "${interpolatedPrompt}"`,
					system: enrichment.systemPrompt,
				});

				enhancedPrompt = enhanceResult.text.trim();
				interpolatedPrompt = enhancedPrompt;
				console.log("[ai-generate-image] Enhanced prompt:", {
					original: imagePrompt,
					enhanced: enhancedPrompt,
				});
			}
		}

		const gateway = createGateway({ apiKey });

		const generationStart = Date.now();
		// Image APIs bill per image and expose no token counts, so every
		// outcome records a zero-token invocation marker (Fizzy #1894). The
		// label is the pipeline that issued the step (workflow-builder runs
		// tag workflow-builder, not image-generation).
		const recordMarker = (success: boolean, errorMessage?: string) =>
			logAiUsageAsync({
				userId: params.userId,
				organizationId: params.organizationId,
				projectId: params.projectId,
				provider: "VERCEL_GATEWAY",
				providerModelId: imageModel,
				taskType: "IMAGE",
				jobType: params.jobType,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				latencyMs: Date.now() - generationStart,
				success,
				errorMessage,
			});

		let imageResult: Awaited<ReturnType<typeof generateImage>>;
		try {
			imageResult = await generateImage({
				model: gateway.imageModel(imageModel),
				prompt: interpolatedPrompt,
				size: imageSize as
					| "1024x1024"
					| "256x256"
					| "512x512"
					| "1024x1792"
					| "1792x1024",
			});
		} catch (error) {
			recordMarker(
				false,
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}

		if (!imageResult.image) {
			recordMarker(false, "No image generated");
			return { success: false, error: "No image generated" };
		}

		recordMarker(true);

		return {
			success: true,
			output: {
				base64: imageResult.image.base64,
				url: null,
				prompt: interpolatedPrompt,
				enhancedPrompt: enhancedPrompt || null,
				revisedPrompt: null,
			},
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Image generation failed";
		return {
			success: false,
			error: `Image generation failed: ${errorMessage}`,
		};
	}
}
