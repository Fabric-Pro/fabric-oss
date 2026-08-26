/**
 * Types for document extraction
 */

/**
 * Thrown when an archive is refused at the inflation ceiling (R14).
 *
 * A distinct class rather than a message: a ceiling refusal is a verdict the
 * upload surface reports to the user, while a parse crash is a pipeline failure
 * it swallows. Callers must tell them apart, and matching on message substrings
 * makes that separation one careless reword away from silently collapsing — a
 * refused decompression bomb would start reporting as a generic extraction
 * failure, with nothing to catch the regression.
 *
 * It lives here rather than beside the extractor that throws it because
 * `local-xlsx.ts` is deliberately absent from the barrel (it pulls exceljs, and
 * Turbopack cannot resolve that at build time). This module has no dependencies,
 * so a caller can discriminate on the class without dragging the parser into its
 * graph.
 */
export class XlsxInflationCeilingError extends Error {
	readonly ceilingBytes: number;
	/**
	 * Bytes measured before the abort, or the archive's own claim when it
	 * over-declared and was refused before any inflation.
	 */
	readonly observedBytes: number;
	/**
	 * True when the archive's declaration alone was over the ceiling, so nothing
	 * was inflated. An archive that lies low is caught by the measured pass
	 * instead — the declaration is a cheap early reject, never the control.
	 */
	readonly refusedBeforeInflating: boolean;

	constructor(args: {
		ceilingBytes: number;
		observedBytes: number;
		refusedBeforeInflating: boolean;
	}) {
		super(
			args.refusedBeforeInflating
				? `Workbook refused before inflating: the archive declares ${args.observedBytes} uncompressed bytes, over the ${args.ceilingBytes} byte ceiling`
				: `Workbook refused: inflating passed the ${args.ceilingBytes} byte ceiling`,
		);
		this.name = "XlsxInflationCeilingError";
		this.ceilingBytes = args.ceilingBytes;
		this.observedBytes = args.observedBytes;
		this.refusedBeforeInflating = args.refusedBeforeInflating;
	}
}

/**
 * Table data structure
 */
export interface TableData {
	rows: string[][];
	headers?: string[];
	caption?: string;
}

/**
 * Result of document extraction
 */
export interface ExtractionResult {
	/** Extracted text content */
	text: string;
	/** Name of the extractor used */
	extractorUsed: string;
	/** Time taken for extraction in milliseconds */
	extractionTime: number;
	/** Cost of extraction in dollars (0 for local extractors) */
	cost: number;
	/** Number of pages in the document */
	pageCount?: number;
	/** Confidence score (0-1) for extraction quality */
	confidence?: number;
	/** Whether the document contains tables */
	hasTables?: boolean;
	/** Whether the document contains images */
	hasImages?: boolean;
	/** Language detected in the document */
	language?: string;
	/** Extracted tables */
	tables?: TableData[];
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Interface for document extractors
 */
export interface IDocumentExtractor {
	/** Name of the extractor */
	name: string;
	/** Supported MIME types */
	supportedMimeTypes: string[];
	/** Extract text from a document buffer */
	extract(
		buffer: Buffer,
		filename: string,
		options?: Record<string, unknown>,
	): Promise<ExtractionResult>;
	/** Check if extractor is available (API key set, service reachable, etc.) */
	isAvailable(): Promise<boolean>;
	/** Get estimated cost for extraction (in USD) */
	estimateCost?(buffer: Buffer): Promise<number>;
}

/**
 * Extraction strategy
 */
export type ExtractionStrategy =
	| "local-only" // Only use local extractors
	| "prefer-external" // Try external services first, fallback to local
	| "external-only" // Only use external services (fail if unavailable)
	| "cost-optimized" // Choose cheapest option
	| "quality-optimized"; // Choose highest quality option
