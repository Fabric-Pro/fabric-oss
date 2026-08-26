/**
 * Unstructured.io OCR provider
 * Supports images and scanned PDFs
 */

import { logger } from "@repo/logs";
import type { IOcrProvider, OcrProviderConfig, OcrResult } from "./types";

export class UnstructuredOcrProvider implements IOcrProvider {
	name = "unstructured";
	supportedMimeTypes = [
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/bmp",
		"image/tiff",
		"application/pdf", // For scanned PDFs
	];

	private config: OcrProviderConfig;

	constructor(config: OcrProviderConfig) {
		this.config = {
			endpoint: "https://api.unstructured.io/general/v0/general",
			maxRetries: 3,
			timeout: 120000, // 2 minutes
			...config,
		};
	}

	async extractText(
		buffer: Buffer,
		filename: string,
		mimeType: string,
	): Promise<OcrResult> {
		const startTime = Date.now();
		logger.info(
			`[UnstructuredOcr] Extracting text from ${filename} (${mimeType})`,
		);

		if (!this.config.apiKey) {
			throw new Error("Unstructured.io API key is not configured");
		}

		let lastError: Error | null = null;
		const maxRetries = this.config.maxRetries || 3;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				logger.info(
					`[UnstructuredOcr] Attempt ${attempt}/${maxRetries} for ${filename}`,
				);

				// Create form data
				const formData = new FormData();
				// Convert Buffer to Uint8Array for Blob compatibility
				const uint8Array = new Uint8Array(buffer);
				const blob = new Blob([uint8Array], { type: mimeType });
				formData.append("files", blob, filename);

				// Optional: Add strategy parameter for better OCR
				// "hi_res" uses OCR for images, "fast" is quicker but less accurate
				formData.append("strategy", "hi_res");

				// Make API request
				const controller = new AbortController();
				const timeoutId = setTimeout(
					() => controller.abort(),
					this.config.timeout,
				);

				// biome-ignore lint/style/noNonNullAssertion: endpoint is validated before this call
				const response = await fetch(this.config.endpoint!, {
					method: "POST",
					headers: {
						"unstructured-api-key": this.config.apiKey,
					},
					body: formData,
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`Unstructured.io API error (${response.status}): ${errorText}`,
					);
				}

				const result = await response.json();

				// Extract text from response
				// Unstructured.io returns an array of elements with text
				const text = this.extractTextFromResponse(result);

				const processingTime = Date.now() - startTime;

				// Estimate cost (Unstructured.io pricing varies, using approximate values)
				// Typical cost: ~$0.01 per page for hi_res strategy
				const estimatedPages = Math.ceil(buffer.length / (1024 * 1024)); // Rough estimate
				const cost = estimatedPages * 0.01;

				logger.info(
					`[UnstructuredOcr] Successfully extracted ${text.length} characters in ${processingTime}ms`,
				);

				return {
					text,
					processingTime,
					cost,
					pageCount: estimatedPages,
					metadata: {
						provider: this.name,
						strategy: "hi_res",
						attempt,
					},
				};
			} catch (error) {
				lastError =
					error instanceof Error ? error : new Error(String(error));
				logger.warn(
					`[UnstructuredOcr] Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`,
				);

				// Don't retry on certain errors
				if (
					lastError.message.includes("401") ||
					lastError.message.includes("403")
				) {
					throw new Error(
						`Unstructured.io authentication failed: ${lastError.message}`,
					);
				}

				// Wait before retrying (exponential backoff)
				if (attempt < maxRetries) {
					const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
					logger.info(
						`[UnstructuredOcr] Waiting ${delay}ms before retry...`,
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		// All retries failed
		throw new Error(
			`Unstructured.io OCR failed after ${maxRetries} attempts: ${lastError?.message || "Unknown error"}`,
		);
	}

	/**
	 * Extract text from Unstructured.io API response
	 */
	private extractTextFromResponse(response: any): string {
		if (!Array.isArray(response)) {
			throw new Error("Invalid response format from Unstructured.io");
		}

		// Unstructured.io returns an array of elements
		// Each element has a "text" field
		const textParts: string[] = [];

		for (const element of response) {
			if (element.text && typeof element.text === "string") {
				textParts.push(element.text);
			}
		}

		if (textParts.length === 0) {
			logger.warn("[UnstructuredOcr] No text extracted from document");
			return "";
		}

		// Join with double newlines to preserve paragraph structure
		return textParts.join("\n\n");
	}

	/**
	 * Check if the provider is available (API key is set)
	 */
	async isAvailable(): Promise<boolean> {
		return !!this.config.apiKey;
	}
}
