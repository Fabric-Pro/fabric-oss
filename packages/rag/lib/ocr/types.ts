/**
 * Types for OCR (Optical Character Recognition) services
 */

/**
 * Result of OCR extraction
 */
export interface OcrResult {
	/** Extracted text content */
	text: string;
	/** Confidence score (0-1) */
	confidence?: number;
	/** Number of pages processed */
	pageCount?: number;
	/** Time taken for OCR in milliseconds */
	processingTime: number;
	/** Cost of OCR in dollars */
	cost: number;
	/** Additional metadata from OCR provider */
	metadata?: Record<string, unknown>;
}

/**
 * Interface for OCR providers
 */
export interface IOcrProvider {
	/** Name of the OCR provider */
	name: string;
	/** Supported MIME types */
	supportedMimeTypes: string[];
	/** Extract text from an image or scanned document */
	extractText(
		buffer: Buffer,
		filename: string,
		mimeType: string,
	): Promise<OcrResult>;
}

/**
 * OCR provider configuration
 */
export interface OcrProviderConfig {
	/** API key for the OCR provider */
	apiKey: string;
	/** Optional API endpoint override */
	endpoint?: string;
	/** Maximum retries on failure */
	maxRetries?: number;
	/** Timeout in milliseconds */
	timeout?: number;
}
