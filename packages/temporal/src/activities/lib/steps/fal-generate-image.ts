/**
 * fal.ai Generate Image Step
 * Generates images using fal.ai FLUX and other models
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { imageGenerationErrorMessage } from "../image-generation-error";
import { interpolateTemplate } from "./utils";

export async function executeFalGenerateImageStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		model = "fal-ai/flux-pro/v1.1",
		prompt,
		imageSize = "landscape_4_3",
		numInferenceSteps = 28,
		guidanceScale = 3.5,
	} = params.nodeConfig as {
		model?: string;
		prompt?: string;
		imageSize?: string;
		numInferenceSteps?: number | string;
		guidanceScale?: number | string;
	};

	if (!prompt) {
		return { success: false, error: "Prompt is required" };
	}

	const steps = Number(numInferenceSteps);
	const guidance = Number(guidanceScale);
	if (
		!Number.isInteger(steps) ||
		steps < 1 ||
		!Number.isFinite(guidance) ||
		guidance < 0
	) {
		return {
			success: false,
			error: "Inference steps must be a positive integer and guidance must be non-negative",
		};
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

	try {
		const response = await fetch(`https://fal.run/${model}`, {
			method: "POST",
			headers: {
				Authorization: `Key ${credentials.FAL_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prompt: interpolatedPrompt,
				image_size: imageSize,
				num_inference_steps: steps,
				guidance_scale: guidance,
				num_images: 1,
			}),
		});

		const result = await response.json();

		if (!response.ok) {
			console.error(
				"[fal-generate-image] Image generation failed:",
				result,
			);
			return {
				success: false,
				error: imageGenerationErrorMessage(
					{ statusCode: response.status },
					"fal",
				),
			};
		}

		const image = result.images?.[0];

		return {
			success: true,
			output: {
				url: image?.url,
				seed: result.seed,
				width: image?.width,
				height: image?.height,
			},
		};
	} catch (error) {
		console.error("[fal-generate-image] Image generation failed:", error);
		return {
			success: false,
			error: imageGenerationErrorMessage(error, "fal"),
		};
	}
}
