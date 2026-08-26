/**
 * Agent Core Runtime
 *
 * Re-exports multi-tenant runtime utilities from @repo/agent-runtime
 * for backward compatibility and convenience.
 *
 * Usage:
 * ```typescript
 * import {
 *   tenantAuth,
 *   getTenant,
 * } from "@repo/agent-core/runtime";
 * ```
 */

// Re-export everything from agent-runtime
export * from "@repo/agent-runtime";
