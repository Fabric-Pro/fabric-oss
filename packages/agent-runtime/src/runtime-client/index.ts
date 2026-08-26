/**
 * Runtime Client Module
 *
 * HTTP client for calling the Runtime API instead of direct database access.
 * This makes agents stateless and self-contained.
 */

export type { RuntimeClientConfig } from "./client";
export { createRuntimeClient, getRuntimeClient, RuntimeClient } from "./client";
