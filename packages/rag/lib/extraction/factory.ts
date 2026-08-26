/**
 * Extraction factory for selecting and executing document extractors
 * Supports database-driven provider configuration with fallback chains
 */

import {
	getEnabledOrganizationRagProviders,
	getEnabledUserRagProviders,
	incrementOrganizationRagProviderUsage,
	incrementUserRagProviderUsage,
} from "@repo/database";
import { logger } from "@repo/logs";
import { decryptApiKey } from "@repo/utils";
import {
	AiVisionExtractor,
	AzureDocumentIntelligenceExtractor,
	HybridPdfExtractor,
	LlamaParseExtractor,
	LocalDocxExtractor,
	LocalPdfExtractor,
	LocalTextExtractor,
	OcrExtractor,
} from "./extractors";
import { LocalHtmlExtractor } from "./extractors/local-html";
import { LocalXlsxExtractor } from "./extractors/local-xlsx";
import type {
	ExtractionResult,
	ExtractionStrategy,
	IDocumentExtractor,
} from "./types";

/**
 * Provider configuration loaded from database
 */
interface ProviderConfig {
	providerName: string;
	apiKey?: string;
	endpoint?: string;
	priority: number;
	isDefault: boolean;
}

/**
 * Extraction context with tenant information
 */
interface ExtractionContext {
	userId?: string;
	organizationId?: string;
	strategy?: ExtractionStrategy;
	maxCost?: number;
	/**
	 * Per-call options forwarded verbatim to the chosen extractor.
	 *
	 * The reach of a bound decides where it lives. Resource bounds are the
	 * extractor's own business — a decompression bomb harms whoever parses it —
	 * but a context budget is the caller's: this factory hands one shared
	 * `LocalXlsxExtractor` to the inline chat path and to four Temporal
	 * ingestion activities alike, so a budget the chat path needs would silently
	 * truncate knowledge-base ingestion if the extractor assumed it. Callers
	 * that supply nothing get the extractor's unbounded default (KTD5).
	 */
	extractionOptions?: Record<string, unknown>;
}

/**
 * Factory for creating and managing document extractors
 * Supports database-driven provider configuration
 */
export class ExtractionFactory {
	private extractors: Map<string, IDocumentExtractor>;

	constructor() {
		// Initialize all available extractors
		this.extractors = new Map([
			["local-pdf", new LocalPdfExtractor()],
			["local-docx", new LocalDocxExtractor()],
			// Ordered before local-text deliberately: both claim text/html, and
			// this is the fallback order. local-text remains the graceful
			// degradation path for HTML the parser cannot handle. #1684.
			["local-html", new LocalHtmlExtractor()],
			["local-text", new LocalTextExtractor()],
			["local-xlsx", new LocalXlsxExtractor()],
			["hybrid-pdf", new HybridPdfExtractor()],
			["ocr", new OcrExtractor()],
			["ai-vision", new AiVisionExtractor()],
		]);
	}

	/**
	 * Extract text from a document using database-driven provider selection
	 *
	 * @param buffer - Document buffer
	 * @param filename - Original filename
	 * @param mimeType - MIME type of the document
	 * @param context - Extraction context with tenant info and strategy
	 * @returns Extraction result
	 */
	async extract(
		buffer: Buffer,
		filename: string,
		mimeType: string,
		context: ExtractionContext = {},
	): Promise<ExtractionResult> {
		const {
			userId,
			organizationId,
			strategy = "local-only",
			maxCost,
			extractionOptions,
		} = context;

		logger.info(
			`[ExtractionFactory] Extracting document: ${filename} (${mimeType}) with strategy: ${strategy}`,
			{ userId, organizationId },
		);

		// Load provider configurations from database
		const providers = await this.loadProviderConfigurations(
			userId,
			organizationId,
		);

		// Select extractors based on strategy and providers
		const extractors = await this.selectExtractors(
			mimeType,
			strategy,
			providers,
			maxCost,
		);

		if (extractors.length === 0) {
			throw new Error(
				`No extractor found for MIME type: ${mimeType}. Supported types: ${this.getSupportedMimeTypes().join(", ")}`,
			);
		}

		// Try extractors in order (fallback chain)
		let lastError: Error | null = null;
		for (const { extractor, providerName } of extractors) {
			try {
				logger.info(
					`[ExtractionFactory] Trying extractor: ${extractor.name} (provider: ${providerName})`,
				);

				// Caller options first, so the tenant identity and MIME the
				// factory resolved always win: a caller cannot reach an
				// extractor under someone else's userId by passing one here.
				const result = await extractor.extract(buffer, filename, {
					...extractionOptions,
					userId,
					organizationId,
					mimeType,
				});

				logger.info(
					`[ExtractionFactory] Extraction successful: ${result.text.length} characters extracted using ${providerName}`,
				);

				// Track usage statistics (skip for built-in extractors without RAG provider records)
				if (
					!providerName.startsWith("local-") &&
					providerName !== "ai-vision"
				) {
					await this.trackUsage(
						userId,
						organizationId,
						providerName,
						result.cost || 0,
					);
				}

				return result;
			} catch (error) {
				lastError = error as Error;
				logger.warn(
					`[ExtractionFactory] Extractor ${extractor.name} failed: ${lastError.message}`,
				);
				// Continue to next extractor in fallback chain
			}
		}

		// All extractors failed
		throw new Error(
			`All extractors failed for ${filename}. Last error: ${lastError?.message}`,
		);
	}

	/**
	 * Load provider configurations from database
	 * User-level configs override organization-level configs
	 */
	private async loadProviderConfigurations(
		userId?: string,
		organizationId?: string,
	): Promise<ProviderConfig[]> {
		const configs: ProviderConfig[] = [];

		// Load organization-level providers
		if (organizationId) {
			const orgProviders =
				await getEnabledOrganizationRagProviders(organizationId);
			for (const provider of orgProviders) {
				configs.push({
					providerName: provider.providerName,
					apiKey: provider.encryptedApiKey
						? decryptApiKey(provider.encryptedApiKey)
						: undefined,
					endpoint: provider.endpoint || undefined,
					priority: provider.priority,
					isDefault: provider.isDefault,
				});
			}
		}

		// Load user-level providers (override organization)
		if (userId) {
			const userProviders = await getEnabledUserRagProviders(userId);
			for (const provider of userProviders) {
				// Remove organization config for this provider if exists
				const existingIndex = configs.findIndex(
					(c) => c.providerName === provider.providerName,
				);
				if (existingIndex >= 0) {
					configs.splice(existingIndex, 1);
				}

				// Add user config
				configs.push({
					providerName: provider.providerName,
					apiKey: provider.encryptedApiKey
						? decryptApiKey(provider.encryptedApiKey)
						: undefined,
					endpoint: provider.endpoint || undefined,
					priority: provider.priority,
					isDefault: provider.isDefault,
				});
			}
		}

		// Sort by priority (lower number = higher priority)
		configs.sort((a, b) => a.priority - b.priority);

		return configs;
	}

	/**
	 * Select extractors based on strategy and provider configurations
	 */
	private async selectExtractors(
		mimeType: string,
		strategy: ExtractionStrategy,
		providers: ProviderConfig[],
		maxCost?: number,
	): Promise<Array<{ extractor: IDocumentExtractor; providerName: string }>> {
		const selected: Array<{
			extractor: IDocumentExtractor;
			providerName: string;
		}> = [];

		// Strategy: local-only - only use local extractors
		if (strategy === "local-only") {
			const localExtractors = this.getLocalExtractors(mimeType);
			return localExtractors.map((extractor) => ({
				extractor,
				providerName: extractor.name,
			}));
		}

		// Strategy: external-only - only use external providers
		if (strategy === "external-only") {
			for (const config of providers) {
				const extractor = await this.createExtractor(config, mimeType);
				if (extractor) {
					selected.push({
						extractor,
						providerName: config.providerName,
					});
				}
			}
			return selected;
		}

		// Strategy: prefer-external - try external first, fallback to local
		if (strategy === "prefer-external") {
			// Add external providers first
			for (const config of providers) {
				const extractor = await this.createExtractor(config, mimeType);
				if (extractor) {
					selected.push({
						extractor,
						providerName: config.providerName,
					});
				}
			}
			// Add local extractors as fallback
			const localExtractors = this.getLocalExtractors(mimeType);
			for (const extractor of localExtractors) {
				selected.push({ extractor, providerName: extractor.name });
			}
			return selected;
		}

		// Strategy: cost-optimized - prefer cheaper options
		if (strategy === "cost-optimized") {
			// Start with free local extractors
			const localExtractors = this.getLocalExtractors(mimeType);
			for (const extractor of localExtractors) {
				selected.push({ extractor, providerName: extractor.name });
			}

			// Add external providers sorted by cost
			const externalWithCost: Array<{
				extractor: IDocumentExtractor;
				providerName: string;
				cost: number;
			}> = [];

			for (const config of providers) {
				const extractor = await this.createExtractor(config, mimeType);
				if (extractor?.estimateCost) {
					const estimatedCost = await extractor.estimateCost(
						Buffer.alloc(0),
					);
					if (!maxCost || estimatedCost <= maxCost) {
						externalWithCost.push({
							extractor,
							providerName: config.providerName,
							cost: estimatedCost,
						});
					}
				}
			}

			// Sort by cost and add to selected
			externalWithCost.sort((a, b) => a.cost - b.cost);
			for (const item of externalWithCost) {
				selected.push({
					extractor: item.extractor,
					providerName: item.providerName,
				});
			}

			return selected;
		}

		// Strategy: quality-optimized - prefer higher quality providers
		if (strategy === "quality-optimized") {
			// Add external providers first (higher quality)
			for (const config of providers) {
				const extractor = await this.createExtractor(config, mimeType);
				if (extractor) {
					selected.push({
						extractor,
						providerName: config.providerName,
					});
				}
			}
			// Add local extractors as last resort
			const localExtractors = this.getLocalExtractors(mimeType);
			for (const extractor of localExtractors) {
				selected.push({ extractor, providerName: extractor.name });
			}
			return selected;
		}

		// Default: use configured providers with local fallback
		for (const config of providers) {
			const extractor = await this.createExtractor(config, mimeType);
			if (extractor) {
				selected.push({ extractor, providerName: config.providerName });
			}
		}

		// Always add local extractors as final fallback
		const localExtractors = this.getLocalExtractors(mimeType);
		for (const extractor of localExtractors) {
			selected.push({ extractor, providerName: extractor.name });
		}

		return selected;
	}

	/**
	 * Get local extractors that support the given MIME type
	 */
	private getLocalExtractors(mimeType: string): IDocumentExtractor[] {
		const local: IDocumentExtractor[] = [];

		// Check each local extractor (includes ocr and ai-vision for image support)
		for (const [name, extractor] of this.extractors) {
			if (
				extractor.supportedMimeTypes.includes(mimeType) &&
				(name.startsWith("local-") ||
					name === "hybrid-pdf" ||
					name === "ocr" ||
					name === "ai-vision")
			) {
				local.push(extractor);
			}
		}

		return local;
	}

	/**
	 * Create an extractor instance from provider configuration
	 */
	private async createExtractor(
		config: ProviderConfig,
		mimeType: string,
	): Promise<IDocumentExtractor | null> {
		const { providerName, apiKey, endpoint } = config;

		// Check if provider supports this MIME type
		let extractor: IDocumentExtractor | null = null;

		switch (providerName) {
			case "unstructured":
				if (apiKey) {
					const ocrExtractor = this.extractors.get(
						"ocr",
					) as OcrExtractor;
					if (ocrExtractor?.supportedMimeTypes.includes(mimeType)) {
						extractor = ocrExtractor;
					}
				}
				break;

			case "llamaparse":
				if (apiKey) {
					extractor = new LlamaParseExtractor(apiKey, { endpoint });
					if (!extractor.supportedMimeTypes.includes(mimeType)) {
						extractor = null;
					}
				}
				break;

			case "azure-document-intelligence":
				if (apiKey && endpoint) {
					extractor = new AzureDocumentIntelligenceExtractor(
						apiKey,
						endpoint,
					);
					if (!extractor.supportedMimeTypes.includes(mimeType)) {
						extractor = null;
					}
				}
				break;

			case "local-pdf":
			case "local-docx":
			case "local-text":
			case "local-xlsx":
			case "hybrid-pdf":
				extractor = this.extractors.get(providerName) || null;
				if (
					extractor &&
					!extractor.supportedMimeTypes.includes(mimeType)
				) {
					extractor = null;
				}
				break;
		}

		// Check if extractor is available
		if (extractor) {
			const isAvailable = await extractor.isAvailable();
			if (!isAvailable) {
				logger.warn(
					`[ExtractionFactory] Provider ${providerName} is not available`,
				);
				return null;
			}
		}

		return extractor;
	}

	/**
	 * Track usage statistics in database
	 */
	private async trackUsage(
		userId: string | undefined,
		organizationId: string | undefined,
		providerName: string,
		cost: number,
	): Promise<void> {
		try {
			// Track organization usage
			if (organizationId) {
				await incrementOrganizationRagProviderUsage({
					organizationId,
					providerName,
					cost,
				});
			}

			// Track user usage
			if (userId) {
				await incrementUserRagProviderUsage({
					userId,
					providerName,
					cost,
				});
			}
		} catch (error) {
			logger.error(
				`[ExtractionFactory] Failed to track usage: ${error instanceof Error ? error.message : String(error)}`,
			);
			// Don't throw - tracking is non-critical
		}
	}

	/**
	 * Get all supported MIME types
	 */
	getSupportedMimeTypes(): string[] {
		const mimeTypes = new Set<string>();

		// Add MIME types from all extractors
		for (const extractor of this.extractors.values()) {
			for (const mimeType of extractor.supportedMimeTypes) {
				mimeTypes.add(mimeType);
			}
		}

		// Add MIME types from external providers not in the local extractors map
		mimeTypes.add("application/pdf"); // LlamaParse, Azure

		return Array.from(mimeTypes);
	}

	/**
	 * Check if a MIME type is supported
	 */
	isSupported(mimeType: string): boolean {
		return this.getSupportedMimeTypes().includes(mimeType);
	}
}

// Export singleton instance
export const extractionFactory = new ExtractionFactory();

/**
 * Convenience function to extract document using the singleton factory
 * Supports both old signature (for backward compatibility) and new signature with context
 *
 * @param buffer - Document buffer
 * @param filename - Original filename
 * @param mimeType - MIME type of the document
 * @param strategyOrContext - Extraction strategy (string) or full context object
 * @returns Extraction result
 */
export async function extractDocument(
	buffer: Buffer,
	filename: string,
	mimeType: string,
	strategyOrContext: ExtractionStrategy | ExtractionContext = "local-only",
): Promise<ExtractionResult> {
	// Backward compatibility: if string is passed, convert to context
	const context: ExtractionContext =
		typeof strategyOrContext === "string"
			? { strategy: strategyOrContext }
			: strategyOrContext;

	return extractionFactory.extract(buffer, filename, mimeType, context);
}
