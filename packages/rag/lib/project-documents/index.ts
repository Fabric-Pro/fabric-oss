/**
 * Project Documents RAG Module
 *
 * Handles embedding and retrieval of generated project documents
 * (PRD, Proposal, etc.) for use as context in document generation.
 */

export {
	type DocumentEmbedProviderConfig,
	type DocumentEmbedResult,
	type EmbedDocumentOptions,
	embedProjectDocument,
	generateContentHash,
	reembedProjectDocument,
	removeDocumentEmbedding,
} from "./embed";
