/** Embedding widths keyed by catalog canonical name; safe for client imports. */

/** Collection creation uses this fixed Qdrant vector width. */
export const VECTOR_STORE_DIMENSIONS = 1536;

// Request-size hint only. Compatibility checks use recorded widths instead.
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export const EMBEDDING_MODEL_CONFIG: Record<
	string,
	{ dimensions: number; costPerMillion?: number }
> = {
	"text-embedding-3-small": { dimensions: 1536, costPerMillion: 0.02 },
	"text-embedding-3-large": { dimensions: 3072, costPerMillion: 0.13 },
	"text-embedding-ada-002": { dimensions: 1536, costPerMillion: 0.1 },
	"databricks-gte-large-en": { dimensions: 1024 },
	"databricks-bge-large-en": { dimensions: 1024 },
	"mistral-embed": { dimensions: 1024 },
	"cohere-embed-english": { dimensions: 1024 },
	"cohere-embed-multilingual": { dimensions: 1024 },
	"cohere-embed-v4": { dimensions: 1536 },
};

/** The model name without a provider prefix (`openai/…`). */
export function embeddingBaseModelName(modelName: string): string {
	return modelName.includes("/")
		? (modelName.split("/").pop() ?? modelName)
		: modelName;
}

/** Recorded output width, or null when the canonical name is unknown. */
export function getKnownEmbeddingDimensions(
	canonicalName: string,
): number | null {
	return Object.hasOwn(EMBEDDING_MODEL_CONFIG, canonicalName)
		? EMBEDDING_MODEL_CONFIG[canonicalName].dimensions
		: null;
}

/** Provider-string request-size hint; its fallback does not establish support. */
export function getEmbeddingDimensions(modelName: string): number {
	return (
		getKnownEmbeddingDimensions(embeddingBaseModelName(modelName)) ??
		DEFAULT_EMBEDDING_DIMENSIONS
	);
}

/** Only recorded canonical names with the collection width fit the store. */
export function embeddingModelFitsVectorStore(canonicalName: string): boolean {
	return (
		getKnownEmbeddingDimensions(canonicalName) === VECTOR_STORE_DIMENSIONS
	);
}

/** Configuration refusal raised before an incompatible embedding model is built. */
export class UnsupportedEmbeddingModelError extends Error {
	readonly dimensions: number | null;
	constructor(readonly canonicalName: string) {
		const dimensions = getKnownEmbeddingDimensions(canonicalName);
		super(
			`Embedding model "${canonicalName}" has ${dimensions === null ? "unknown vector width" : `${dimensions}-dimension vectors`}; the document index requires ${VECTOR_STORE_DIMENSIONS}-dimension vectors. Choose a compatible embedding model in Settings → AI Models.`,
		);
		this.name = "UnsupportedEmbeddingModelError";
		this.dimensions = dimensions;
	}
}
