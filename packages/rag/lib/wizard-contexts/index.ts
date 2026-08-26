/**
 * Wizard Contexts Module
 *
 * Provides RAG (Retrieval-Augmented Generation) functionality for the project
 * creation wizard. Handles temporary context storage and retrieval until
 * the project is created, then binds embeddings to the project.
 */

// Retrieval operations
export {
	formatWizardContextsForPrompt,
	retrieveWizardContexts,
} from "./retrieval";

// Store operations
export {
	bindWizardEmbeddingsToProject,
	type DeleteAllWizardContextsOptions,
	deleteAllWizardContextsForSession,
	deleteWizardContext,
	searchWizardContexts,
	storeWizardContext,
} from "./store";
// Types
export * from "./types";
