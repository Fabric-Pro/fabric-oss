/**
 * OpenAPI Tools Package
 *
 * Provides utilities for parsing OpenAPI specs and dynamically loading
 * tools for AI agents.
 */

// Documentation extractor (describes an API; see `describe-types.ts` for how
// this differs from the execution-shaped parser below)
export type {
	ModelDescription,
	ModelPropertyDescription,
	OpenApiDescription,
	OperationDescription,
	ParameterDescription,
	ParameterLocation,
	RequestBodyDescription,
	ResponseDescription,
	SecuritySchemeSummary,
	SpecDetection,
} from "./describe-types";
export { OpenApiDescribeError } from "./describe-types";
export {
	describeOpenApiSpec,
	looksLikeOpenApiSpec,
} from "./lib/describe";
// Executor
export {
	createToolExecutor,
	executeOpenAPITool,
	toToolDefinition,
} from "./lib/executor";
// Loader (for agent integration)
export type {
	LoadOpenAPIToolsOptions,
	LoadOpenAPIToolsResult,
	OpenAPIAgentTool,
} from "./lib/loader";
export {
	createOpenAPIAgentTool,
	dbServiceToConfig,
	dbToolToParsedTool,
	logToolsLoaded,
	toLangChainTool,
} from "./lib/loader";
// Parser
export {
	parseOpenAPISpec,
	validateToolInput,
} from "./lib/parser";
export {
	renderModel,
	renderOperation,
	renderSpecSummary,
} from "./lib/render";
// Types
export type {
	AuthSchemeInfo,
	ExecuteToolInput,
	OnboardServiceInput,
	ParameterInfo,
	ParsedOpenAPISpec,
	ParsedOpenAPITool,
	SyncServiceInput,
	ToolExecutionConfig,
	ToolExecutionInput,
	ToolExecutionResult,
} from "./types";
export {
	ExecuteToolInputSchema,
	OnboardServiceInputSchema,
	SyncServiceInputSchema,
} from "./types";
