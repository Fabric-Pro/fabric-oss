/**
 * MCP Default-Tool analytics signal payloads
 *
 * Cross-cutting domain type that describes a single managed-default MCP
 * tool invocation or failure event detected during orchestrator
 * execution. Produced by:
 *
 *   - The catch blocks in `applyDefaultMcpEagerRouting`
 *     (`packages/temporal/src/workflows/orchestrator/phases/
 *     iterative-execution.ts`) — emits `kind: "failed"` with one of
 *     `failureKind ∈ {no-config, server-unreachable, schema-mismatch}`.
 *   - The wrapper around `executeMcpTool` at the same workflow site —
 *     emits `kind: "failed"` with `failureKind: "tool-call-error"` when
 *     the resolved `MCPConfig.isManagedDefault === true`.
 *   - The success branch of `executeMcpTool` (`kind: "invoked"`).
 *
 * Accumulated on `WorkflowState.mcpDefaultToolSignals[]`; the per-event
 * SSE forwarder downstream lets the client hooks (`useDirectStream`,
 * `useMultiAgentStream`) call `useAnalytics().trackEvent(name, payload)`.
 *
 * The two payload shapes carry the analytics envelope fields the
 * dashboards consume — keep the keys here in sync with the
 * `trackEvent` call sites in the hooks.
 */

/**
 * Surface the managed-default MCP routing ran for. Sourced from
 * `OrchestratorWorkflowInput["surface"]`; widened from the workflow-io
 * literal so this types module doesn't have to re-import the workflow
 * surface enum (which would create a circular dependency between this
 * file and `workflow-io.types.ts`).
 */
export type McpDefaultToolSurface =
	| "nexus"
	| "copilot"
	| "document-editor"
	| "agent-template"
	| "weave";

/**
 * Why an eager-routing / tool-call attempt failed. Maps one-to-one with
 * the catch sites in `applyDefaultMcpEagerRouting`.
 *
 *   - `"no-config"` — the registry row matched but no `MCPConfig` row
 *     exists for this tenant. Should be unreachable for Excalidraw
 *     post-backfill; remains for future opt-in default servers.
 *   - `"server-unreachable"` — `fetchToolsFromServerIds` threw OR the
 *     activity wrapping `findDefaultMcpConfigActivity` threw before
 *     returning. Catch-all for transport-level failures.
 *   - `"tool-call-error"` — the eager-load succeeded but the subsequent
 *     `tools/call` returned an error (or threw). Fired by the
 *     `executeMcpTool` wrapper at the workflow caller.
 *   - `"schema-mismatch"` — the eager tool name is not present in the
 *     fetched tool list. Indicates registry drift vs. the upstream MCP
 *     server.
 */
export type McpDefaultToolFailureKind =
	| "no-config"
	| "server-unreachable"
	| "tool-call-error"
	| "schema-mismatch";

/**
 * Payload for a successful managed-default MCP tool invocation.
 */
export interface McpDefaultToolInvokedPayload {
	kind: "invoked";
	surface: McpDefaultToolSurface;
	serverKey: string;
	toolName: string;
	configSource: "managed-default" | "user-installed";
	executionId: string;
	organizationId: string | null;
}

/**
 * Payload for a managed-default MCP tool failure. `errorMessage` MUST
 * be the output of `sanitizeMcpErrorMessage()` — no API keys, no email
 * addresses, capped at 500 chars.
 */
export interface McpDefaultToolFailedPayload {
	kind: "failed";
	surface: McpDefaultToolSurface;
	serverKey: string;
	failureKind: McpDefaultToolFailureKind;
	errorMessage: string;
	executionId: string;
	organizationId: string | null;
}

/**
 * Discriminated union accumulated on `WorkflowState.mcpDefaultToolSignals`.
 * The `kind` literal selects the SSE event name
 * (`mcp_default_tool_invoked` vs `mcp_default_tool_failed`).
 */
export type McpDefaultToolSignal =
	| McpDefaultToolInvokedPayload
	| McpDefaultToolFailedPayload;
