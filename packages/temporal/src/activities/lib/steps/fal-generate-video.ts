/**
 * fal.ai Generate Video Step
 * Generates videos using fal.ai Kling and other models
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeFalGenerateVideoStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		model = "fal-ai/kling-video/v1.6/standard/text-to-video",
		prompt,
		imageUrl,
		duration = "5",
		aspectRatio = "16:9",
	} = params.nodeConfig as {
		model?: string;
		prompt?: string;
		imageUrl?: string;
		duration?: string;
		aspectRatio?: string;
	};

	if (!prompt) {
		return { success: false, error: "Prompt is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"FAL",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.FAL_API_KEY) {
		return {
			success: false,
			error: "fal.ai API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedPrompt = interpolateTemplate(prompt, params.inputs);
	const interpolatedImageUrl = imageUrl
		? interpolateTemplate(imageUrl, params.inputs)
		: undefined;

	try {
		const requestBody: Record<string, unknown> = {
			prompt: interpolatedPrompt,
			duration: Number.parseInt(duration, 10),
			aspect_ratio: aspectRatio,
		};

		if (interpolatedImageUrl) {
			requestBody.image_url = interpolatedImageUrl;
		}

		const response = await fetch(`https://fal.run/${model}`, {
			method: "POST",
			headers: {
				Authorization: `Key ${credentials.FAL_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		});

		const result = await response.json();

		if (!response.ok) {
			return {
				success: false,
				error:
					result.detail ||
					result.message ||
					`HTTP ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				url: result.video?.url,
				seed: result.seed,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "fal.ai video generation failed",
		};
	}
}
