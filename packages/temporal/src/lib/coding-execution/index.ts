/**
 * Coding Execution Provider Module
 *
 * Provides a unified interface for executing code across different environments:
 * - BACKGROUND_AGENTS: Remote managed agents (Fabric-hosted)
 * - KANBAN_LOCAL: Local kanban CLI runtime
 *
 * All providers implement the CodingExecutionProvider interface with:
 * - createSession: Initialize execution environment
 * - sendPrompt: Send implementation prompts
 * - getSessionStatus: Poll for status/artifacts
 * - cancelSession: Stop execution
 * - healthCheck: Verify provider health
 *
 * Error Handling:
 * All providers throw typed ProviderError subclasses:
 * - AuthError: Authentication failures
 * - NetworkError: HTTP/communication failures
 * - TimeoutError: Operation timeouts
 * - SessionValidationError: Invalid session/parameters
 * - PortUnavailableError: No available ports (local providers)
 * - RuntimeNotFoundError: CLI tool not installed
 * - RateLimitError: Rate limiting exceeded
 *
 * Environment Variables:
 * - BACKGROUND_AGENTS_URL: URL for remote agent service
 * - BACKGROUND_AGENTS_INTERNAL_SECRET: Auth secret for remote service
 * - KANBAN_RUNTIME_PORT_RANGE: Port range for kanban (default: 3484-65535)
 * - KANBAN_RUNTIME_START_TIMEOUT_MS: Startup timeout (default: 15000)
 * - LOCAL_PROVIDER_RATE_LIMIT_PER_MINUTE: Rate limit (default: 10)
 * - CODING_EXECUTION_DEBUG: Enable debug logging (default: false)
 */

// Authentication
export {
	generateInternalToken,
	getAuthHeaders,
	verifyInternalToken,
} from "./auth";
// Individual providers
export {
	BackgroundAgentsProvider,
	FabricBackgroundAdapter,
} from "./background-agents-provider";
// Environment configuration
export {
	debugLog,
	env,
	getBackgroundAgentsSecret,
	getBackgroundAgentsUrl,
} from "./env";
// Error types
export {
	AuthError,
	NetworkError,
	PortUnavailableError,
	ProviderError,
	type ProviderErrorCode,
	RateLimitError,
	RuntimeNotFoundError,
	SessionValidationError,
	TimeoutError,
	toProviderError,
} from "./errors";
export {
	getLocalKanbanSessionUrl,
	KanbanLocalAdapter,
	LocalKanbanProvider,
} from "./local-kanban-provider";
// Core interfaces
export type {
	CodingExecutionProvider,
	CreateSessionParams,
	HealthCheckResult,
	SessionStatus,
} from "./provider";
// Provider registry
export {
	type CodingExecutionAdapterDefinition,
	getBackgroundAgentsProvider,
	getCodingExecutionAdapterDefinition,
	getCodingExecutionProvider,
	listCodingExecutionAdapterDefinitions,
} from "./registry";
// Validation schemas
export {
	CreateSessionParamsSchema,
	SessionResultSchema,
	SessionStatusSchema,
	type ValidatedCreateSessionParams,
	type ValidatedSessionResult,
	type ValidatedSessionStatus,
	validateCreateSessionParams,
	validateSessionStatus,
} from "./schemas";

// Security utilities
export {
	redactSensitiveData,
	sanitizeBranchName,
	sanitizeErrorMessage,
	validateBackgroundAgentsUrl,
	validateWorkingDirectory,
} from "./security";
