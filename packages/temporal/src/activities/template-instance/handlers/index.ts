/**
 * Data Source Handlers Registry
 *
 * Central registry for all data source handlers.
 * Handlers are responsible for fetching data from different sources.
 */

import type {
	DataSourceDefinition,
	DataSourceHandler,
	DataSourceType,
} from "../types";
import { IntegrationDataSourceHandler } from "./integration-handler";
import { McpDataSourceHandler } from "./mcp-handler";

// Handler instances (singletons)
const mcpHandler = new McpDataSourceHandler();
const integrationHandler = new IntegrationDataSourceHandler();

// Handler registry
const handlers: Record<DataSourceType, DataSourceHandler> = {
	mcp: mcpHandler,
	integration: integrationHandler,
	workspace: null as unknown as DataSourceHandler, // TODO: Implement
	"user-input": null as unknown as DataSourceHandler, // TODO: Implement
	fabric: null as unknown as DataSourceHandler, // TODO: Implement
};

/**
 * Get the handler for a data source type
 */
export function getHandler(type: DataSourceType): DataSourceHandler | null {
	return handlers[type] || null;
}

/**
 * Get the handler for a data source definition
 * Supports both explicit type and legacy inference
 */
export function getHandlerForDataSource(
	dataSource: DataSourceDefinition,
): DataSourceHandler | null {
	// Use explicit type if provided
	if (dataSource.type) {
		return getHandler(dataSource.type);
	}

	// Legacy inference based on provider
	const provider = dataSource.provider?.toLowerCase();

	// Check if MCP handler supports this provider
	if (mcpHandler.supportedProviders.includes(provider)) {
		return mcpHandler;
	}

	// Check if integration handler supports this provider
	if (integrationHandler.supportedProviders.includes(provider)) {
		return integrationHandler;
	}

	return null;
}

/**
 * Infer the data source type from provider (for legacy templates)
 */
export function inferDataSourceType(provider: string): DataSourceType {
	const providerLower = provider.toLowerCase();

	// Integration-first providers (typically OAuth or API key based)
	const integrationProviders = ["slack", "resend", "perplexity", "firecrawl"];
	if (integrationProviders.includes(providerLower)) {
		return "integration";
	}

	// MCP-first providers (typically need MCP server for complex interactions)
	const mcpProviders = ["fizzy", "notion", "confluence", "asana", "trello"];
	if (mcpProviders.includes(providerLower)) {
		return "mcp";
	}

	// Dual-support providers - default to integration for simpler setup
	const dualProviders = ["github", "linear", "jira"];
	if (dualProviders.includes(providerLower)) {
		return "integration";
	}

	// Default to MCP for unknown providers
	return "mcp";
}

export { IntegrationDataSourceHandler } from "./integration-handler";
// Re-export handlers
export { McpDataSourceHandler } from "./mcp-handler";
