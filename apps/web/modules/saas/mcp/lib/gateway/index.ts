/**
 * Fabric MCP Gateway
 *
 * Unified MCP server that aggregates all Fabric platform capabilities
 * and user-connected MCP server tools into a single endpoint.
 *
 * @module
 */

export { executePlatformTool } from "./platform-tools";
export {
	createGatewaySession,
	deleteGatewaySession,
	getGatewaySession,
	updateSessionOrganization,
} from "./session-store";
export {
	executeConnectedServerTool,
	getAggregatedTools,
} from "./tool-aggregator";
export type {
	GatewaySession,
	JsonRpcRequest,
} from "./types";
