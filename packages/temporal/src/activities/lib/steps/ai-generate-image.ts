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
	generateImage,
	generateText,
	getAIModelWithMetadata,
	isVercelGatewayKey,
} from "@repo/ai";
import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";
import {
	getLocalImageModel,
	getLocalModelConfig,
	localImageSize,
} from "@repo/ai/local-models";
import { logAiUsageAsync } from "@repo/database";
import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { ChatMediaPersistenceError } from "../../chat-media";
import { rethrowIfTurnStopped } from "../../orchestrator/turn-dispatch";
import type { NodeExecutionResult, StepParams } from "../../types";
import { resolveImageGatewayProviderConfig } from "../image-gateway-provider";
import {
	imageCredentialErrorMessage,
	imageGenerationErrorMessage,
} from "../image-generation-error";
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
		// Local development only: a local image server draws the image
		// (packages/ai/lib/local-models.ts). Null outside NODE_ENV=development.
		const localImages = getLocalModelConfig("IMAGE");
		const provider = localImages ? "local" : "gateway";

		// TENANT resolver: a workflow-builder image step runs because someone
		// executed the workflow, so this is not the background work the system
		// half is reserved for. Same rule as `image-generation.ts`.
		let providerConfig: Awaited<
			ReturnType<typeof resolveImageGatewayProviderConfig>
		> = null;
		try {
			if (!localImages) {
				providerConfig = await resolveImageGatewayProviderConfig({
					userId: params.userId,
					organizationId: params.organizationId,
				});
			}
		} catch (error) {
			if (error instanceof ChatMediaPersistenceError) {
				throw error;
			}
			rethrowIfTurnStopped(error);
			rethrowIfDispatchStopped(error);
			console.error(
				"[ai-generate-image] Credential resolution failed:",
				error,
			);
			return {
				success: false,
				error: imageCredentialErrorMessage(error),
			};
		}

		if (
			!localImages &&
			(!providerConfig?.apiKey ||
				(providerConfig.provider !== "VERCEL_GATEWAY" &&
					!isVercelGatewayKey(providerConfig.apiKey)))
		) {
			return {
				success: false,
				error: "This image generation path requires a VERCEL_GATEWAY connection or a Vercel gateway key. Configure one in Settings → AI Providers.",
			};
		}

		// If prompt enhancement is enabled, use Fabric AI to improve the prompt
		let enhancedPrompt: string | undefined;
		if (enhancePrompt) {
			try {
				const fabricConfig = extractFabricConfig(params.nodeConfig);
				const enrichment = await applyFabricEnrichment(
					interpolatedPrompt,
					fabricConfig,
					"You are an expert image prompt engineer. Enhance the following image generation prompt to be more detailed and descriptive while preserving the original intent. Output only the enhanced prompt, nothing else.",
				);

				if (enrichment.fabricUsed && enrichment.systemPrompt) {
					enhancedPrompt = await enhanceImagePrompt(
						params,
						interpolatedPrompt,
						enrichment.systemPrompt,
					);
					if (enhancedPrompt) {
						interpolatedPrompt = enhancedPrompt;
						console.log("[ai-generate-image] Enhanced prompt:", {
							original: imagePrompt,
							enhanced: enhancedPrompt,
						});
					}
				}
			} catch (error) {
				if (error instanceof ChatMediaPersistenceError) {
					throw error;
				}
				rethrowIfTurnStopped(error);
				rethrowIfDispatchStopped(error);
				// A hard usage limit stops the node: skipping enhancement here
				// would go on to the image call, the costliest one the limit
				// exists to refuse. Its message is written by Fabric.
				const usageLimit = findAiUsageLimitError(error);
				if (usageLimit) {
					console.warn(
						"[ai-generate-image] Usage limit reached during prompt enhancement:",
						usageLimit.limitId,
					);
					return { success: false, error: usageLimit.message };
				}
				console.warn(
					"[ai-generate-image] Prompt enhancement skipped:",
					error,
				);
			}
		}

		const model = localImages
			? getLocalImageModel(localImages)
			: createGateway({ apiKey: providerConfig?.apiKey }).imageModel(
					imageModel,
				);

		const generationStart = Date.now();
		// Image APIs bill per image and expose no token counts, so the image
		// call records a zero-token invocation marker (Fizzy #1894). The
		// label is the pipeline that issued the step (workflow-builder runs
		// tag workflow-builder, not image-generation).
		const recordMarker = (success: boolean, errorMessage?: string) =>
			logAiUsageAsync({
				userId: params.userId,
				organizationId: params.organizationId,
				projectId: params.projectId,
				provider: localImages ? "CUSTOM" : "VERCEL_GATEWAY",
				providerModelId: localImages?.model ?? imageModel,
				taskType: "IMAGE",
				jobType: params.jobType,
				featureKey: "workflow",
				workflowExecutionId: params.executionId,
				...(params.frameId ? { frameId: params.frameId } : {}),
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
				model,
				prompt: interpolatedPrompt,
				size: localImages
					? localImageSize({ size: imageSize })
					: (imageSize as
							| "1024x1024"
							| "256x256"
							| "512x512"
							| "1024x1792"
							| "1792x1024"),
			});
		} catch (error) {
			if (error instanceof ChatMediaPersistenceError) {
				throw error;
			}
			rethrowIfTurnStopped(error);
			rethrowIfDispatchStopped(error);
			const message = imageGenerationErrorMessage(error, provider);
			console.error(
				"[ai-generate-image] Image generation failed:",
				error,
			);
			recordMarker(false, message);
			return { success: false, error: message };
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
		if (error instanceof ChatMediaPersistenceError) {
			throw error;
		}
		rethrowIfTurnStopped(error);
		rethrowIfDispatchStopped(error);
		console.error("[ai-generate-image] Image preparation failed:", error);
		return {
			success: false,
			error: "Couldn't prepare image generation. Try again.",
		};
	}
}

/** Enhancement is optional; its caller falls back to the original prompt on failure. */
async function enhanceImagePrompt(
	params: StepParams,
	prompt: string,
	instructions: string,
): Promise<string> {
	const { model } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{
			userId: params.userId,
			organizationId: params.organizationId,
			projectId: params.projectId,
			jobType: params.jobType,
			featureKey: "workflow",
			workflowExecutionId: params.executionId,
			...(params.frameId ? { frameId: params.frameId } : {}),
		},
	);
	const result = await generateText({
		model,
		prompt: `Enhance this image prompt: "${prompt}"`,
		instructions,
	});
	return result.text.trim();
}
