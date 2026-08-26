/**
 * Utility Functions Barrel Export
 */

export { safeParseJson } from "./json-parser";
// MCP-default-tool signal publisher activity. Bridges
// `state.mcpDefaultToolSignals` payloads to the SSE pipeline so the
// client hooks can call `useAnalytics().trackEvent`.
export { publishMcpDefaultToolSignalActivity } from "./mcp-default-telemetry";
export {
	createCleanDescription,
	createPlanDescription,
	detectMultipleActions,
	type ParsedMessage,
	parseMessage,
} from "./message-parser";
export { getAiModel } from "./model-selector";
export { jsonSchemaToZod } from "./schema-utils";
export {
	clearToolLearningCache,
	getToolLearningContext,
	getToolPattern,
	recordFailedToolCall,
	recordSuccessfulToolCall,
} from "./tool-learning";
