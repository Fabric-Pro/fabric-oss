/**
 * Project contexts RAG module
 * Exports all project context-related functionality
 *
 * Key components:
 * - client: Qdrant connection and collection management
 * - store: Vector store operations (store, search, delete)
 * - types: TypeScript interfaces for project contexts
 * - auto-embed: Automatic embedding service for context changes
 * - retrieval: RAG retrieval with project settings
 */

export * from "./auto-embed";
export * from "./client";
export * from "./code-search";
export * from "./document-intents";
export * from "./retrieval";
export * from "./retrieve-for-spec";
export * from "./store";
export * from "./summary-injection";
export * from "./types";
// live-integration-context is NOT re-exported here to avoid requiring
// @repo/integrations as a transitive dependency for all @repo/rag consumers.
// Import directly: import { ... } from "@repo/rag/lib/project-contexts/live-integration-context"
