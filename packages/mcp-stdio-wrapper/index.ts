/**
 * @repo/mcp-stdio-wrapper
 *
 * HTTP wrapper service for STDIO-based MCP servers.
 * Enables multi-user organization support with proper tenant isolation.
 *
 * Per MCP Authorization Documentation:
 * "For MCP servers using the STDIO transport, you can use environment-based credentials
 *  or credentials provided by third-party libraries."
 *
 * This wrapper:
 * 1. Exposes HTTP endpoints for internal consumption
 * 2. Spawns STDIO MCP processes with credentials passed via environment variables
 * 3. Maintains process isolation per user/organization/config
 * 4. Handles process lifecycle with TTL-based cleanup
 *
 * @see https://modelcontextprotocol.io/docs/tutorials/security/authorization
 */

export { internalOnlyMiddleware } from "./src/middleware/internal-only";
export {
	ProcessPool,
	type ProcessPoolConfig,
	type ProcessPoolEntry,
} from "./src/process-pool";
export { createServer, startServer } from "./src/server";
export {
	StdioTransport,
	type StdioTransportConfig,
} from "./src/stdio-transport";
