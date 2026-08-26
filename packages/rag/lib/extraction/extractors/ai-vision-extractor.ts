/**
 * AI Vision-based extractor for images
 * Uses configured AI models (GPT-4o, Claude, etc.) to READ and DESCRIBE images:
 * full OCR of any visible text PLUS a detailed description of the visual content
 * (objects, charts, diagrams, layout, colors). This description is the only
 * representation of the image the downstream chat model receives via RAG, so it
 * must be comprehensive — a bare OCR pass loses everything in a text-light image.
 * Works with any vision-capable model already configured in the system.
 */

import {
	generateText,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { logger } from "@repo/logs";
import type { ExtractionResult, IDocumentExtractor } from "../types";
import { downscaleForVision } from "../utils/downscale-image";

export class AiVisionExtractor implements IDocumentExtractor {
	name = "ai-vision";
	supportedMimeTypes = [
		"image/jpeg",
		"image/jpg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/bmp",
		"image/tiff",
	];

	private static readonly ESTIMATED_COST_PER_IMAGE = 0.005;

	async extract(
		buffer: Buffer,
		filename: string,
		options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		const userId = options?.userId as string | undefined;
		const organizationId = options?.organizationId as string | undefined;
		const projectId = options?.projectId as string | undefined;

		logger.info(
			`[AiVisionExtractor] Extracting text from image: ${filename}`,
			{ userId, organizationId },
		);

		if (!userId) {
			throw new Error(
				"AI Vision extractor requires userId for model resolution",
			);
		}

		const mimeType =
			(options?.mimeType as string) || this.detectMimeType(filename);

		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ userId, organizationId },
		);

		const visionPayload = await downscaleForVision(buffer, mimeType);
		if (visionPayload.downscaled) {
			logger.info(
				`[AiVisionExtractor] Downscaled ${filename} from ${visionPayload.originalBytes} to ${visionPayload.finalBytes} bytes for vision call`,
				{ userId, organizationId },
			);
		}

		const promptText = [
			"Produce a thorough, self-contained description of this image so that someone who cannot see it understands its full content. Cover BOTH of the following:",
			"1) TRANSCRIBE every piece of visible text exactly as it appears, preserving formatting, line breaks, and structure (this is the OCR layer — do not omit or paraphrase any text).",
			"2) DESCRIBE the visual content in detail: objects, people, scene, charts/graphs/diagrams (including their data, axes, and labels), tables, UI elements, layout, colors, and any other notable details.",
			"Be specific and comprehensive — this description is the only representation of the image the downstream assistant will receive. Output plain text only.",
		].join("\n");

		// Maximal mode: the OCR-plus-description output of a dense image can far
		// exceed the short text prompt. Without an explicit budget
		// Databricks/Anthropic-direct truncate the description at their injected
		// defaults, silently dropping content. The image's input tokens aren't
		// counted here (vision token accounting is imprecise), so the context
		// clamp is approximate; `undefined` for providers that don't need the
		// workaround.
		const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
			promptChars: promptText.length,
		});

		const response = await generateText({
			model,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							image: new Uint8Array(visionPayload.buffer),
							mediaType: visionPayload.mimeType,
						},
						{
							type: "text",
							text: promptText,
						},
					],
				},
			],
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		if (response.finishReason === "length") {
			logger.warn(
				`[AiVisionExtractor] Vision description truncated at the model's output-token limit for ${filename}; the extracted text may be incomplete`,
				{ userId, organizationId, maxOutputTokens },
			);
		}

		const extractedText = response.text.trim();
		const extractionTime = Date.now() - startTime;
		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType: "CHAT",
			usage: response.usage,
			latencyMs: extractionTime,
			projectId,
		});

		logger.info(
			`[AiVisionExtractor] Extracted ${extractedText.length} characters in ${extractionTime}ms`,
		);

		return {
			text: extractedText,
			extractorUsed: this.name,
			extractionTime,
			cost: AiVisionExtractor.ESTIMATED_COST_PER_IMAGE,
			pageCount: 1,
			hasImages: true,
			metadata: {
				method: "ai-vision",
			},
		};
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async estimateCost(_buffer: Buffer): Promise<number> {
		return AiVisionExtractor.ESTIMATED_COST_PER_IMAGE;
	}

	private detectMimeType(filename: string): string {
		const ext = filename.toLowerCase().split(".").pop();
		const mimeTypeMap: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			gif: "image/gif",
			webp: "image/webp",
			bmp: "image/bmp",
			tiff: "image/tiff",
			tif: "image/tiff",
		};
		return mimeTypeMap[ext || ""] || "image/png";
	}
}
