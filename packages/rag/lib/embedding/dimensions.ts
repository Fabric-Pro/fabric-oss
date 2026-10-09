/**
 * Embedding model sizes, free of any client or provider import so the API's
 * settings procedures can check a model against the vector store before it
 * is saved.
 */

/** The width every Qdrant collection is created with. */
export const VECTOR_STORE_DIMENSIONS = 1536;

// Unknown models are assumed to produce this many dimensions.
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export const EMBEDDING_MODEL_CONFIG: Record<
	string,
	{ dimensions: number; costPerMillion: number }
> = {
	"text-embedding-3-small": { dimensions: 1536, costPerMillion: 0.02 },
	"text-embedding-3-large": { dimensions: 3072, costPerMillion: 0.13 },
	"text-embedding-ada-002": { dimensions: 1536, costPerMillion: 0.1 },
};

/** The model name without a provider prefix (`openai/…`). */
export function embeddingBaseModelName(modelName: string): string {
	return modelName.includes("/")
		? (modelName.split("/").pop() ?? modelName)
		: modelName;
}

/**
 * Get the dimensions for an embedding model
 *
 * Exported so a caller that has to know whether a model's vectors fit a
 * fixed-size collection (company context, Fizzy #2719) reads the same table
 * the embedding calls size their requests from.
 */
export function getEmbeddingDimensions(modelName: string): number {
	return (
		EMBEDDING_MODEL_CONFIG[embeddingBaseModelName(modelName)]?.dimensions ??
		DEFAULT_EMBEDDING_DIMENSIONS
	);
}

/**
 * Whether a model's vectors fit the store's collections. Vectors of another
 * width are refused by every write and search (Fizzy #2770).
 */
export function embeddingModelFitsVectorStore(modelName: string): boolean {
	return getEmbeddingDimensions(modelName) === VECTOR_STORE_DIMENSIONS;
}
