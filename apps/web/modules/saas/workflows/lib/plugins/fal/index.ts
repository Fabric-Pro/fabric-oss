/**
 * fal.ai Integration Plugin
 * AI image, video, and audio generation
 *
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { FalIcon } from "./icon";

const falPlugin: IntegrationPlugin = {
	type: "FAL",
	category: "tool",
	label: "fal.ai",
	description: "AI image, video, and audio generation",
	icon: FalIcon,
	color: "text-pink-500",
	brandColor: "#181818",

	formFields: [
		{
			id: "apiKey",
			label: "fal.ai API Key",
			type: "password",
			placeholder: "Your fal.ai API key",
			configKey: "apiKey",
			envVar: "FAL_API_KEY",
			helpText: "Get your API key from fal.ai dashboard",
			helpLink: {
				text: "fal.ai/dashboard/keys",
				url: "https://fal.ai/dashboard/keys",
			},
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testFalConnection } = await import("./test");
			return testFalConnection;
		},
	},

	actions: [
		{
			slug: "generate-image",
			label: "Generate Image (FLUX)",
			description: "Generate images using FLUX models",
			category: "AI",
			stepFunction: "executeFalGenerateImageStep",
			stepImportPath: "fal-generate-image",
			outputFields: [
				{ field: "url", description: "Generated image URL" },
				{ field: "seed", description: "Generation seed" },
				{ field: "width", description: "Image width" },
				{ field: "height", description: "Image height" },
			],
			outputConfig: { type: "image", field: "url" },
			configFields: [
				{
					key: "model",
					label: "Model",
					type: "select",
					defaultValue: "fal-ai/flux-pro/v1.1",
					options: [
						{
							value: "fal-ai/flux-pro/v1.1",
							label: "FLUX Pro 1.1",
						},
						{ value: "fal-ai/flux/dev", label: "FLUX.1 Dev" },
						{
							value: "fal-ai/flux/schnell",
							label: "FLUX.1 Schnell",
						},
						{
							value: "fal-ai/flux-pro/v1.1-ultra",
							label: "FLUX Pro 1.1 Ultra",
						},
						{ value: "fal-ai/recraft-v3", label: "Recraft V3" },
					],
				},
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder: "Describe the image you want to generate",
					rows: 4,
					required: true,
					example: "A serene mountain landscape at sunset",
				},
				{
					key: "imageSize",
					label: "Image Size",
					type: "select",
					defaultValue: "landscape_4_3",
					options: [
						{ value: "square", label: "Square (1:1)" },
						{ value: "square_hd", label: "Square HD (1:1)" },
						{ value: "portrait_4_3", label: "Portrait (4:3)" },
						{ value: "portrait_16_9", label: "Portrait (16:9)" },
						{ value: "landscape_4_3", label: "Landscape (4:3)" },
						{ value: "landscape_16_9", label: "Landscape (16:9)" },
					],
				},
				{
					key: "numInferenceSteps",
					label: "Inference Steps",
					type: "number",
					defaultValue: "28",
					min: 1,
				},
				{
					key: "guidanceScale",
					label: "Guidance Scale",
					type: "number",
					defaultValue: "3.5",
					min: 0,
				},
			],
		},
		{
			slug: "generate-video",
			label: "Generate Video",
			description: "Generate videos from text or images",
			category: "AI",
			stepFunction: "executeFalGenerateVideoStep",
			stepImportPath: "fal-generate-video",
			outputFields: [
				{ field: "url", description: "Generated video URL" },
				{ field: "seed", description: "Generation seed" },
			],
			outputConfig: { type: "video", field: "url" },
			configFields: [
				{
					key: "model",
					label: "Model",
					type: "select",
					defaultValue:
						"fal-ai/kling-video/v1.6/standard/text-to-video",
					options: [
						{
							value: "fal-ai/kling-video/v1.6/standard/text-to-video",
							label: "Kling 1.6 Text to Video",
						},
						{
							value: "fal-ai/kling-video/v1.6/standard/image-to-video",
							label: "Kling 1.6 Image to Video",
						},
						{
							value: "fal-ai/minimax-video/image-to-video",
							label: "MiniMax Image to Video",
						},
						{
							value: "fal-ai/hunyuan-video",
							label: "Hunyuan Video",
						},
					],
				},
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder: "Describe the video you want to generate",
					rows: 4,
					required: true,
				},
				{
					key: "imageUrl",
					label: "Image URL (for image-to-video)",
					type: "template-input",
					placeholder: "https://example.com/image.jpg",
				},
				{
					key: "duration",
					label: "Duration",
					type: "select",
					defaultValue: "5",
					options: [
						{ value: "5", label: "5 seconds" },
						{ value: "10", label: "10 seconds" },
					],
				},
				{
					key: "aspectRatio",
					label: "Aspect Ratio",
					type: "select",
					defaultValue: "16:9",
					options: [
						{ value: "16:9", label: "16:9 (Landscape)" },
						{ value: "9:16", label: "9:16 (Portrait)" },
						{ value: "1:1", label: "1:1 (Square)" },
					],
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(falPlugin);
