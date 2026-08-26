/**
 * Image Generation Activity
 *
 * Generates images using multiple providers:
 * - Gateway: Vercel AI Gateway with Nano Banana models (Google Gemini image gen)
 * - FAL: Uses FLUX models via REST API, returns hosted image URLs
 * - Gemini: Uses @google/genai SDK directly, uploads base64 result to S3/R2
 *
 * The provider architecture is extensible - add new providers by:
 * 1. Adding the provider name to ImageGenerationParams.provider union
 * 2. Creating a generateWith<Provider>() function
 * 3. Adding a case in generateImageActivity()
 */

import { fetchCredentialsByProvider, logAiUsageAsync } from "@repo/database";
import { downloadFile, getSignedUrl, uploadFile } from "@repo/storage";

export interface ImageGenerationParams {
	prompt: string;
	provider: "gateway" | "fal" | "gemini";
	aspectRatio?: string;
	quality?: string;
	model?: string;
	userId: string;
	organizationId?: string;
	/** S3 storage path of an input image to modify/edit (for image editing workflows) */
	inputImagePath?: string;
	/** Gateway model ID (e.g., "google/gemini-3.1-flash-image-preview") */
	gatewayModel?: string;
}

export interface ImageGenerationResult {
	success: boolean;
	imageUrl?: string;
	/** S3 storage path of the generated image (for proxy URL construction) */
	storagePath?: string;
	width?: number;
	height?: number;
	provider: string;
	model: string;
	error?: string;
	durationMs: number;
	/** Text response from the model (e.g., Nano Banana returns text alongside images) */
	text?: string;
}

const FAL_ASPECT_RATIO_MAP: Record<string, string> = {
	"1:1": "square_hd",
	"3:2": "landscape_4_3",
	"2:3": "portrait_4_3",
	"3:4": "portrait_4_3",
	"4:3": "landscape_4_3",
	"4:5": "portrait_4_3",
	"5:4": "landscape_4_3",
	"9:16": "portrait_16_9",
	"16:9": "landscape_16_9",
};

const FAL_QUALITY_STEPS: Record<string, number> = {
	low: 20,
	medium: 28,
	high: 50,
};

const DEFAULT_FAL_MODEL = "fal-ai/flux-pro/v1.1";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-preview-image-generation";
const DEFAULT_GATEWAY_MODEL = "google/gemini-3.1-flash-image-preview";
const GENERATED_IMAGES_BUCKET =
	process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME || "chat-documents";

const ASPECT_RATIO_PATTERN = /^\d+:\d+$/;

function parseAspectRatio(
	input: string | undefined,
): `${number}:${number}` | undefined {
	if (!input) {
		return undefined;
	}
	const trimmed = input.trim();
	if (!ASPECT_RATIO_PATTERN.test(trimmed)) {
		console.warn(
			`[ImageGeneration] Ignoring invalid aspectRatio="${input}" (expected "W:H" with positive integers)`,
		);
		return undefined;
	}
	return trimmed as `${number}:${number}`;
}

export async function generateImageActivity(
	params: ImageGenerationParams,
): Promise<ImageGenerationResult> {
	const startTime = Date.now();
	const {
		prompt,
		provider,
		aspectRatio,
		quality,
		model,
		userId,
		organizationId,
		inputImagePath,
		gatewayModel,
	} = params;

	if (!prompt || prompt.trim().length === 0) {
		return {
			success: false,
			provider,
			model: model || "",
			error: "Prompt is required for image generation",
			durationMs: Date.now() - startTime,
		};
	}

	let result: ImageGenerationResult;
	try {
		switch (provider) {
			case "gateway":
				result = await generateWithGateway({
					prompt,
					inputImagePath,
					gatewayModel,
					aspectRatio,
					userId,
					organizationId,
					startTime,
				});
				break;

			case "gemini":
				result = await generateWithGemini({
					prompt,
					aspectRatio,
					quality,
					model,
					userId,
					organizationId,
					startTime,
				});
				break;

			default:
				result = await generateWithFal({
					prompt,
					aspectRatio,
					quality,
					model,
					userId,
					organizationId,
					startTime,
				});
		}
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		console.error(
			`[ImageGeneration] ${provider} generation failed:`,
			error,
		);
		result = {
			success: false,
			provider,
			model: model || getDefaultModel(provider, gatewayModel),
			error: errorMessage,
			durationMs: Date.now() - startTime,
		};
	}

	logImageGenerationUsage(result, userId, organizationId);
	return result;
}

function getDefaultModel(provider: string, gatewayModel?: string): string {
	switch (provider) {
		case "gateway":
			return gatewayModel || DEFAULT_GATEWAY_MODEL;
		case "gemini":
			return DEFAULT_GEMINI_MODEL;
		default:
			return DEFAULT_FAL_MODEL;
	}
}

/**
 * Best-effort usage row for one image-generation call (Fizzy #1894).
 *
 * Image APIs are billed per image, not per token, and neither the gateway
 * multimodal path nor the dedicated image/FAL APIs expose token counts — so
 * this is an invocation marker (zero tokens, zero cost), not a spend figure.
 * It exists so image generation shows up in the AI usage ledger at all.
 * Fire-and-forget: a logging failure must never break the generation itself.
 */
function logImageGenerationUsage(
	result: ImageGenerationResult,
	userId: string,
	organizationId?: string,
): void {
	try {
		logAiUsageAsync({
			userId,
			organizationId,
			// The provider enum has no values for the FAL or Google-AI-Studio
			// image APIs; their model string carries the real identity, so they
			// land under CUSTOM rather than a misattributed provider.
			provider:
				result.provider === "gateway" ? "VERCEL_GATEWAY" : "CUSTOM",
			providerModelId: result.model,
			taskType: "IMAGE",
			jobType: "image-generation",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			latencyMs: result.durationMs,
			success: result.success,
			errorMessage: result.error,
		});
	} catch {
		/* never propagate a logging failure */
	}
}

// =============================================================================
// Gateway Provider (Vercel AI Gateway + Nano Banana)
// =============================================================================

async function generateWithGateway(params: {
	prompt: string;
	inputImagePath?: string;
	gatewayModel?: string;
	aspectRatio?: string;
	userId: string;
	organizationId?: string;
	startTime: number;
}): Promise<ImageGenerationResult> {
	const {
		prompt,
		inputImagePath,
		aspectRatio,
		userId,
		organizationId,
		startTime,
	} = params;
	// If no explicit gatewayModel, resolve from user's IMAGE model preference
	let model: string;
	if (params.gatewayModel) {
		model = params.gatewayModel;
	} else {
		try {
			const { resolveModel } = await import("@repo/database");
			const resolved = await resolveModel({
				userId,
				organizationId,
				taskType: "IMAGE",
				provider: "VERCEL_GATEWAY",
			});
			model = resolved.providerModelId;
		} catch {
			model = DEFAULT_GATEWAY_MODEL;
		}
	}

	// Get gateway API key via centralized config
	const { getRAGProviderConfig } = await import("@repo/ai");
	const providerConfig = await getRAGProviderConfig({
		userId,
		organizationId,
	});

	if (!providerConfig.apiKey) {
		return {
			success: false,
			provider: "gateway",
			model,
			error: "AI Gateway API key not configured. Please configure it in Settings > AI Providers.",
			durationMs: Date.now() - startTime,
		};
	}

	const { createGateway, experimental_generateImage, generateText } =
		await import("@repo/ai");
	const gateway = createGateway({ apiKey: providerConfig.apiKey });

	// Nano Banana (Gemini multimodal image) models emit images through the chat
	// completions API with responseModalities=[TEXT,IMAGE] and support image
	// editing via input-image content parts. Pure image models (OpenAI gpt-image,
	// DALL-E, Google Imagen, etc.) must go through the dedicated image API.
	const isNanoBanana = /^google\/gemini[\w.-]*image/i.test(model);

	if (isNanoBanana) {
		const contentParts: Array<
			| { type: "text"; text: string }
			| { type: "image"; image: URL }
			| { type: "image"; image: Uint8Array; mediaType: string }
		> = [];

		// Download input image from S3 storage (for editing workflows)
		// SECURITY: Images are resolved from S3 storage paths, never from arbitrary URLs.
		// Tenant prefix check prevents cross-tenant object reads.
		if (inputImagePath) {
			const expectedPrefix = organizationId || userId;
			const pathPrefix = inputImagePath.split("/")[0];
			if (pathPrefix !== expectedPrefix) {
				return {
					success: false,
					provider: "gateway",
					model,
					error: `Input image path does not belong to the current tenant (path=${pathPrefix}, expected=${expectedPrefix}, orgId=${organizationId}, userId=${userId})`,
					durationMs: Date.now() - startTime,
				};
			}

			try {
				const { data: imageBuffer, contentType } = await downloadFile(
					inputImagePath,
					{ bucket: GENERATED_IMAGES_BUCKET },
				);
				contentParts.push({
					type: "image",
					image: new Uint8Array(imageBuffer),
					mediaType: contentType || "image/png",
				});
			} catch (downloadError) {
				console.error(
					`[ImageGeneration] Failed to download input image from S3: ${inputImagePath}`,
					downloadError,
				);
				return {
					success: false,
					provider: "gateway",
					model,
					error: `Failed to download input image from storage: ${inputImagePath}`,
					durationMs: Date.now() - startTime,
				};
			}
		}

		const aspectHint = aspectRatio
			? ` The image should have a ${aspectRatio} aspect ratio.`
			: "";
		contentParts.push({ type: "text", text: `${prompt}${aspectHint}` });

		console.log(
			`[ImageGeneration] Gateway (multimodal) request: model=${model}, hasInputImage=${!!inputImagePath}`,
		);

		const result = await generateText({
			model: gateway(model),
			messages: [{ role: "user", content: contentParts }],
			providerOptions: {
				google: { responseModalities: ["TEXT", "IMAGE"] },
			},
		});

		const imageFiles =
			result.files?.filter((f) => f.mediaType?.startsWith("image/")) ??
			[];

		if (imageFiles.length === 0) {
			return {
				success: false,
				provider: "gateway",
				model,
				error:
					result.text ||
					"No image generated. The model may not support image generation for this prompt.",
				durationMs: Date.now() - startTime,
			};
		}

		const imageFile = imageFiles[0];
		return await uploadGatewayImage({
			buffer: Buffer.from(imageFile.uint8Array),
			mediaType: imageFile.mediaType || "image/png",
			model,
			userId,
			organizationId,
			startTime,
			text: result.text || undefined,
		});
	}

	// Pure image models (OpenAI gpt-image-*, DALL-E, Imagen, etc.):
	// route through the dedicated image generation API.
	if (inputImagePath) {
		return {
			success: false,
			provider: "gateway",
			model,
			error: `Model '${model}' does not support input-image editing via the gateway image API. Use a Nano Banana model (e.g., google/gemini-3.1-flash-image-preview) for image editing.`,
			durationMs: Date.now() - startTime,
		};
	}

	const validatedAspectRatio = parseAspectRatio(aspectRatio);

	console.log(
		`[ImageGeneration] Gateway (image API) request: model=${model}, aspectRatio=${validatedAspectRatio ?? "default"}`,
	);

	const imageResult = await experimental_generateImage({
		model: gateway.imageModel(model),
		prompt,
		...(validatedAspectRatio ? { aspectRatio: validatedAspectRatio } : {}),
	});

	if (!imageResult.image) {
		return {
			success: false,
			provider: "gateway",
			model,
			error: "Gateway image API returned no image data",
			durationMs: Date.now() - startTime,
		};
	}

	return await uploadGatewayImage({
		buffer: Buffer.from(imageResult.image.uint8Array),
		mediaType: imageResult.image.mediaType || "image/png",
		model,
		userId,
		organizationId,
		startTime,
	});
}

async function uploadGatewayImage(params: {
	buffer: Buffer;
	mediaType: string;
	model: string;
	userId: string;
	organizationId?: string;
	startTime: number;
	text?: string;
}): Promise<ImageGenerationResult> {
	const {
		buffer,
		mediaType,
		model,
		userId,
		organizationId,
		startTime,
		text,
	} = params;
	const extension = mediaType.split("/")[1] || "png";
	const timestamp = Date.now();
	const hash = Math.random().toString(36).substring(2, 10);
	const ownerPrefix = organizationId || userId;
	const storagePath = `${ownerPrefix}/generated-images/${timestamp}-${hash}.${extension}`;

	console.log(
		`[ImageGeneration] Uploading gateway image to storage: ${storagePath}`,
	);

	await uploadFile(storagePath, buffer, {
		bucket: GENERATED_IMAGES_BUCKET,
		contentType: mediaType,
	});

	const imageUrl = await getSignedUrl(storagePath, {
		bucket: GENERATED_IMAGES_BUCKET,
		expiresIn: 3600,
	});

	return {
		success: true,
		imageUrl,
		storagePath,
		provider: "gateway",
		model,
		text,
		durationMs: Date.now() - startTime,
	};
}

// =============================================================================
// FAL Provider (FLUX models)
// =============================================================================

async function generateWithFal(params: {
	prompt: string;
	aspectRatio?: string;
	quality?: string;
	model?: string;
	userId: string;
	organizationId?: string;
	startTime: number;
}): Promise<ImageGenerationResult> {
	const {
		prompt,
		aspectRatio,
		quality,
		model,
		userId,
		organizationId,
		startTime,
	} = params;
	const falModel = model || DEFAULT_FAL_MODEL;

	const credentials = await fetchCredentialsByProvider(
		"FAL",
		userId,
		organizationId,
	);
	if (!credentials?.FAL_API_KEY) {
		return {
			success: false,
			provider: "fal",
			model: falModel,
			error: "FAL API key not configured. Please configure it in Settings > Integrations.",
			durationMs: Date.now() - startTime,
		};
	}

	const imageSize = FAL_ASPECT_RATIO_MAP[aspectRatio || "1:1"] || "square_hd";
	const numInferenceSteps = FAL_QUALITY_STEPS[quality || "medium"] || 28;

	console.log(
		`[ImageGeneration] FAL request: model=${falModel}, size=${imageSize}, steps=${numInferenceSteps}`,
	);

	const response = await fetch(`https://fal.run/${falModel}`, {
		method: "POST",
		headers: {
			Authorization: `Key ${credentials.FAL_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			prompt,
			image_size: imageSize,
			num_inference_steps: numInferenceSteps,
			guidance_scale: 3.5,
			num_images: 1,
		}),
	});

	const result = await response.json();

	if (!response.ok) {
		return {
			success: false,
			provider: "fal",
			model: falModel,
			error:
				result.detail ||
				result.message ||
				`FAL API error: HTTP ${response.status}`,
			durationMs: Date.now() - startTime,
		};
	}

	const image = result.images?.[0];
	if (!image?.url) {
		return {
			success: false,
			provider: "fal",
			model: falModel,
			error: "FAL returned no image data",
			durationMs: Date.now() - startTime,
		};
	}

	return {
		success: true,
		imageUrl: image.url,
		width: image.width,
		height: image.height,
		provider: "fal",
		model: falModel,
		durationMs: Date.now() - startTime,
	};
}

// =============================================================================
// Gemini Direct Provider (@google/genai SDK)
// =============================================================================

async function generateWithGemini(params: {
	prompt: string;
	aspectRatio?: string;
	quality?: string;
	model?: string;
	userId: string;
	organizationId?: string;
	startTime: number;
}): Promise<ImageGenerationResult> {
	const { prompt, aspectRatio, model, userId, organizationId, startTime } =
		params;
	const geminiModel = model || DEFAULT_GEMINI_MODEL;

	const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
	if (!apiKey) {
		return {
			success: false,
			provider: "gemini",
			model: geminiModel,
			error: "GOOGLE_AI_STUDIO_API_KEY environment variable is not configured",
			durationMs: Date.now() - startTime,
		};
	}

	const { GoogleGenAI } = await import("@google/genai");
	const ai = new GoogleGenAI({ apiKey });

	console.log(`[ImageGeneration] Gemini request: model=${geminiModel}`);

	const aspectPrompt = aspectRatio
		? ` The image should have a ${aspectRatio} aspect ratio.`
		: "";
	const fullPrompt = `${prompt}${aspectPrompt}`;

	const response = await ai.models.generateContent({
		model: geminiModel,
		contents: fullPrompt,
		config: {
			responseModalities: ["IMAGE", "TEXT"],
		},
	});

	// Extract image from response parts
	const parts = response.candidates?.[0]?.content?.parts;
	if (!parts) {
		return {
			success: false,
			provider: "gemini",
			model: geminiModel,
			error: "Gemini returned no content",
			durationMs: Date.now() - startTime,
		};
	}

	const imagePart = parts.find((part) =>
		part.inlineData?.mimeType?.startsWith("image/"),
	);

	if (!imagePart?.inlineData?.data) {
		return {
			success: false,
			provider: "gemini",
			model: geminiModel,
			error: "Gemini returned no image data in response",
			durationMs: Date.now() - startTime,
		};
	}

	// Upload base64 image to S3/R2
	const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
	const mimeType = imagePart.inlineData.mimeType || "image/png";
	const extension = mimeType.split("/")[1] || "png";
	const timestamp = Date.now();
	const hash = Math.random().toString(36).substring(2, 10);
	const ownerPrefix = organizationId || userId;
	const storagePath = `${ownerPrefix}/generated-images/${timestamp}-${hash}.${extension}`;

	console.log(
		`[ImageGeneration] Uploading Gemini image to storage: ${storagePath}`,
	);

	await uploadFile(storagePath, imageBuffer, {
		bucket: GENERATED_IMAGES_BUCKET,
		contentType: mimeType,
	});

	// Get a signed download URL (1 hour expiry) for immediate use
	const imageUrl = await getSignedUrl(storagePath, {
		bucket: GENERATED_IMAGES_BUCKET,
		expiresIn: 3600,
	});

	return {
		success: true,
		imageUrl,
		storagePath,
		provider: "gemini",
		model: geminiModel,
		durationMs: Date.now() - startTime,
	};
}
