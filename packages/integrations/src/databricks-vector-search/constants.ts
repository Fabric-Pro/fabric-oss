/**
 * Shared constants for the Databricks Vector Search integration.
 *
 * Kept in its own leaf module (no node builtins, no @repo/databricks import)
 * so client-side code — e.g. the agent-builder index picker — can import it
 * directly without pulling server-only dependencies into the browser bundle.
 */
export const MAX_QUERY_INDEXES = 16;
