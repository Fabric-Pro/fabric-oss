/**
 * Agent Core Services
 *
 * This module exports only services that don't have database dependencies,
 * making them safe to use in ESM-only contexts (standalone agents).
 *
 * For database-dependent services (AI Gateway, MCP Tools, Semantic Memory),
 * import from "@repo/agent-core/backend" instead.
 */

export * from "./agent-loader";
export * from "./langchain-models";
export * from "./token-exchange";

// NOTE: Database-dependent services are exported from ./backend.ts
// to avoid ESM compatibility issues with standalone agents.
// Use: import { getConfiguredAIModel } from "@repo/agent-core/backend"
