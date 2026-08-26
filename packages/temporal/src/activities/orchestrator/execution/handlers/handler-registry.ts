/**
 * Handler Registry
 *
 * Manages step handlers and routes execution to appropriate handlers
 * based on step capability and configuration.
 *
 * Features:
 * - Lazy handler instantiation for cold-start optimization
 * - Priority-based handler routing
 * - Fallback to MCP tool handler if no handler matches
 * - Variable interpolation for step inputs ({{step-X.output}}, etc.)
 */

import { HANDLER_PRIORITY } from "../../config";
import type {
	AgentVariable,
	ExecuteStepInput,
	ExecuteStepOutput,
} from "../../types";
import type {
	HandlerConfig,
	HandlerContext,
	HandlerResult,
	StepHandler,
} from "./types";

// =============================================================================
// Variable Interpolation
// =============================================================================

/**
 * Interpolate template variables in step inputs.
 * Supports patterns like {{step-X.output}}, {{step-X.results[0].url}}, {{variableName}}
 *
 * @param inputs - Step inputs with potential template variables
 * @param variables - Available variables from workflow state
 * @param previousStepResults - Results from previous steps
 * @returns Inputs with variables resolved
 */
function interpolateStepInputs(
	inputs: Record<string, unknown> | undefined,
	variables: Record<string, AgentVariable>,
	previousStepResults?: Array<{
		stepId: string;
		stepDescription?: string;
		response?: string;
		keyOutputs?: Record<string, unknown>;
	}>,
): Record<string, unknown> | undefined {
	if (!inputs) {
		return undefined;
	}

	const resolvedInputs: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(inputs)) {
		if (typeof value === "string") {
			resolvedInputs[key] = interpolateString(
				value,
				variables,
				previousStepResults,
			);
		} else if (Array.isArray(value)) {
			resolvedInputs[key] = value.map((item) =>
				typeof item === "string"
					? interpolateString(item, variables, previousStepResults)
					: item,
			);
		} else if (value && typeof value === "object") {
			resolvedInputs[key] = interpolateStepInputs(
				value as Record<string, unknown>,
				variables,
				previousStepResults,
			);
		} else {
			resolvedInputs[key] = value;
		}
	}

	return resolvedInputs;
}

/**
 * Interpolate template variables in a string.
 */
function interpolateString(
	template: string,
	variables: Record<string, AgentVariable>,
	previousStepResults?: Array<{
		stepId: string;
		stepDescription?: string;
		response?: string;
		keyOutputs?: Record<string, unknown>;
	}>,
): string {
	// Match patterns like {{step-1.output}}, {{step-1.results[0].url}}, {{variableName}}
	return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
		const trimmedPath = path.trim();

		// Handle step references: {{step-X.output}}, {{step-X.response}}
		const stepMatch = trimmedPath.match(/^step-(\d+)\.(.+)$/);
		if (stepMatch && previousStepResults) {
			const stepIndex = Number.parseInt(stepMatch[1], 10) - 1; // step-1 = index 0
			const propertyPath = stepMatch[2];

			if (stepIndex >= 0 && stepIndex < previousStepResults.length) {
				const stepResult = previousStepResults[stepIndex];
				const value = resolvePropertyPath(stepResult, propertyPath);
				if (value !== undefined) {
					return typeof value === "string"
						? value
						: JSON.stringify(value);
				}
				// Fallback: If can't resolve complex path, return full response
				// This handles cases where LLM generates invalid paths like "results[0].url"
				if (stepResult.response) {
					console.warn(
						`[HandlerRegistry] Could not resolve '${propertyPath}', using full response`,
					);
					return stepResult.response;
				}
			} else if (stepIndex >= previousStepResults.length) {
				// Step hasn't executed yet or failed — return a descriptive placeholder
				// so downstream steps can detect the missing input instead of passing
				// a raw template string like "{{step-2.response}}" as a tool argument
				console.warn(
					`[HandlerRegistry] Step ${stepMatch[1]} has no result (may have failed or not executed yet). Reference: ${match}`,
				);
				return `[Step ${stepMatch[1]} result unavailable — step may have failed or not executed yet]`;
			}
			console.warn(
				`[HandlerRegistry] Could not resolve step reference: ${match}`,
			);
			return `[Unresolved: ${match} — step ${stepMatch[1]} produced no output]`;
		}

		// Handle variable references: {{variableName}}
		if (variables[trimmedPath]) {
			const varValue = variables[trimmedPath].value;
			return typeof varValue === "string"
				? varValue
				: JSON.stringify(varValue);
		}

		// Check keyOutputs from all previous steps
		if (previousStepResults) {
			for (const result of previousStepResults) {
				if (result.keyOutputs?.[trimmedPath] !== undefined) {
					const value = result.keyOutputs[trimmedPath];
					return typeof value === "string"
						? value
						: JSON.stringify(value);
				}
			}
		}

		console.warn(`[HandlerRegistry] Unknown variable reference: ${match}`);
		return match; // Keep original if can't resolve
	});
}

/**
 * Resolve a property path like "output", "results[0].url", "keyOutputs.cardId"
 */
function resolvePropertyPath(
	obj: Record<string, unknown>,
	path: string,
): unknown {
	const parts = path.split(/\.|\[|\]/).filter(Boolean);
	let current: unknown = obj;

	for (const part of parts) {
		if (current === null || current === undefined) {
			return undefined;
		}

		// Handle array index
		const index = Number.parseInt(part, 10);
		if (!Number.isNaN(index) && Array.isArray(current)) {
			current = current[index];
		} else if (typeof current === "object") {
			// Map common aliases
			const key = mapPropertyAlias(part);
			current = (current as Record<string, unknown>)[key];
		} else {
			return undefined;
		}
	}

	return current;
}

/**
 * Map property aliases to actual field names in step results.
 */
function mapPropertyAlias(prop: string): string {
	const aliases: Record<string, string> = {
		output: "response",
		result: "response",
		results: "keyOutputs",
	};
	return aliases[prop] || prop;
}

/**
 * Handler factory function for lazy instantiation.
 */
type HandlerFactory = () => StepHandler;

/**
 * Registry entry with lazy handler support.
 */
interface LazyHandlerEntry {
	factory: HandlerFactory;
	config: HandlerConfig;
	instance?: StepHandler;
}

/**
 * Registry for step handlers.
 * Manages handler registration and routing based on capabilities.
 * Uses lazy instantiation for cold-start optimization.
 */
export class HandlerRegistry {
	private handlers: LazyHandlerEntry[] = [];
	private fallbackFactory: HandlerFactory;
	private fallbackInstance?: StepHandler;

	constructor() {
		// MCP tool handler is the default fallback (lazy)
		this.fallbackFactory = () => {
			const { McpToolHandler } = require("./mcp-tool-handler");
			return new McpToolHandler();
		};
	}

	/**
	 * Get the fallback handler (lazy instantiation).
	 */
	private getFallbackHandler(): StepHandler {
		if (!this.fallbackInstance) {
			this.fallbackInstance = this.fallbackFactory();
		}
		return this.fallbackInstance;
	}

	/**
	 * Register a handler factory with configuration.
	 * Handler is not instantiated until first use.
	 */
	register(
		factory: HandlerFactory,
		config: Partial<HandlerConfig> = {},
	): void {
		const fullConfig: HandlerConfig = {
			priority: config.priority ?? HANDLER_PRIORITY.MCP_TOOL,
			enabled: config.enabled ?? true,
		};

		this.handlers.push({ factory, config: fullConfig });
		// Sort by priority (lower = higher priority)
		this.handlers.sort((a, b) => a.config.priority - b.config.priority);
	}

	/**
	 * Get handler instance (lazy instantiation).
	 */
	private getHandlerInstance(entry: LazyHandlerEntry): StepHandler {
		if (!entry.instance) {
			entry.instance = entry.factory();
		}
		return entry.instance;
	}

	/**
	 * Get a handler that can process the given input.
	 */
	getHandler(input: ExecuteStepInput): StepHandler {
		for (const entry of this.handlers) {
			if (entry.config.enabled) {
				const handler = this.getHandlerInstance(entry);
				if (handler.canHandle(input)) {
					return handler;
				}
			}
		}
		return this.getFallbackHandler();
	}

	/**
	 * Execute a step using the appropriate handler.
	 * Handles fallback logic if primary handler fails.
	 */
	async executeStep(input: ExecuteStepInput): Promise<ExecuteStepOutput> {
		const startTime = Date.now();

		// =======================================================================
		// VARIABLE INTERPOLATION
		// Resolve template variables like {{step-X.output}} in step inputs
		// BEFORE passing to handlers. This is critical for step chaining.
		// =======================================================================
		const resolvedInputs = interpolateStepInputs(
			input.step.inputs as Record<string, unknown> | undefined,
			input.variables,
			input.previousStepResults,
		);

		// Log if any interpolation occurred
		if (
			resolvedInputs &&
			JSON.stringify(resolvedInputs) !== JSON.stringify(input.step.inputs)
		) {
			console.log(
				`[HandlerRegistry] Interpolated step inputs for ${input.step.id}`,
				{
					original: input.step.inputs,
					resolved: resolvedInputs,
				},
			);
		}

		// =======================================================================
		// SCHEMA-AWARE INPUT MAPPING
		// Validate and map inputs to tool schema parameters dynamically.
		// Handles common LLM mistakes like using wrong parameter names.
		// =======================================================================
		const toolName = input.step.app || input.step.executor;
		let mappedInputs = resolvedInputs;

		if (toolName && resolvedInputs) {
			try {
				const { validateAndMapInputs } = await import(
					"./schema-mapper"
				);
				const preloadedTools = input.preloadedTools?.toolMap;
				mappedInputs = validateAndMapInputs(
					toolName,
					resolvedInputs,
					preloadedTools,
				);

				if (
					JSON.stringify(mappedInputs) !==
					JSON.stringify(resolvedInputs)
				) {
					console.log(
						`[HandlerRegistry] Schema-mapped inputs for ${toolName}`,
						{
							before: resolvedInputs,
							after: mappedInputs,
						},
					);
				}
			} catch (schemaError) {
				// Log schema validation error but let handler decide how to proceed
				console.warn(
					`[HandlerRegistry] Schema validation issue for ${toolName}:`,
					schemaError instanceof Error
						? schemaError.message
						: schemaError,
				);
				// Re-throw to fail the step with helpful error message
				throw schemaError;
			}
		}

		// Create modified input with resolved and mapped inputs
		const resolvedInput: ExecuteStepInput = {
			...input,
			step: {
				...input.step,
				inputs: mappedInputs,
			},
		};

		const context: HandlerContext = {
			input: resolvedInput,
			variables: { ...input.variables },
			toolCalls: [],
			startTime,
		};

		// Try to find a handler
		const handler = this.getHandler(resolvedInput);
		console.log(
			`[HandlerRegistry] Using handler: ${handler.name} for step: ${input.step.id}`,
		);

		const result = await handler.execute(context);

		// If handler succeeded, return output
		if (result.handled && result.output) {
			return result.output;
		}

		// If handler suggests fallback, try fallback handler
		if (result.shouldFallback) {
			console.log(
				`[HandlerRegistry] Handler ${handler.name} requested fallback: ${result.fallbackReason}`,
			);

			const fallbackHandler = this.getFallbackHandler();

			// If it's already the fallback handler, throw the error
			if (handler === fallbackHandler) {
				throw new Error(result.error || "Step execution failed");
			}

			// Use MCP tool handler as fallback
			const fallbackResult = await this.executeFallback(
				context,
				result,
				fallbackHandler,
			);
			if (fallbackResult.handled && fallbackResult.output) {
				return fallbackResult.output;
			}

			// Fallback also failed
			throw new Error(
				fallbackResult.error || result.error || "Step execution failed",
			);
		}

		// Handler didn't handle and didn't request fallback - error
		throw new Error(result.error || "No handler could process this step");
	}

	/**
	 * Execute fallback handler with context from failed handler.
	 */
	private async executeFallback(
		context: HandlerContext,
		previousResult: HandlerResult,
		fallbackHandler: StepHandler,
	): Promise<HandlerResult> {
		console.log("[HandlerRegistry] Executing fallback handler");

		// If agent delegation failed, pass the error to MCP handler for context
		if (
			previousResult.fallbackReason?.includes("Agent delegation") ||
			previousResult.fallbackReason?.includes("agent")
		) {
			// Type assertion for MCP handler with fallback method
			const mcpHandler = fallbackHandler as StepHandler & {
				executeWithFallback?: (
					input: ExecuteStepInput,
					error: string,
				) => Promise<ExecuteStepOutput>;
			};
			if (typeof mcpHandler.executeWithFallback === "function") {
				try {
					const output = await mcpHandler.executeWithFallback(
						context.input,
						previousResult.error ||
							previousResult.fallbackReason ||
							"Agent unavailable",
					);
					return { handled: true, output };
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					return { handled: false, error: errorMessage };
				}
			}
		}

		// Standard fallback execution
		return fallbackHandler.execute(context);
	}

	/**
	 * List all registered handlers (instantiates handlers if needed).
	 */
	listHandlers(): Array<{
		name: string;
		capabilities: string[];
		priority: number;
		enabled: boolean;
	}> {
		return this.handlers.map((entry) => {
			const handler = this.getHandlerInstance(entry);
			return {
				name: handler.name,
				capabilities: handler.capabilities,
				priority: entry.config.priority,
				enabled: entry.config.enabled,
			};
		});
	}
}

/**
 * Create a default handler registry with all standard handlers.
 * Uses lazy instantiation - handlers are only created when first needed.
 */
export function getDefaultHandlerRegistry(): HandlerRegistry {
	const registry = new HandlerRegistry();

	// Register handlers as factories with config-based priorities
	// Unified search handler - searches all project knowledge sources in parallel
	registry.register(
		() => {
			const {
				UnifiedSearchHandler,
			} = require("./unified-search-handler");
			return new UnifiedSearchHandler();
		},
		{ priority: HANDLER_PRIORITY.UNIFIED_SEARCH },
	);

	registry.register(
		() => {
			const { WeaveQueryHandler } = require("./weave-query-handler");
			return new WeaveQueryHandler();
		},
		{ priority: HANDLER_PRIORITY.FABRIC_AI - 1 },
	);

	// Workspace RAG handler - checked first for document queries (dynamic RAG)
	registry.register(
		() => {
			const { WorkspaceRagHandler } = require("./workspace-rag-handler");
			return new WorkspaceRagHandler();
		},
		{ priority: HANDLER_PRIORITY.WORKSPACE_RAG },
	);

	// Project RAG handler - checked for project-specific document queries
	registry.register(
		() => {
			const { ProjectRagHandler } = require("./project-rag-handler");
			return new ProjectRagHandler();
		},
		{ priority: HANDLER_PRIORITY.PROJECT_RAG },
	);

	// Code search handler - repository code search, file retrieval, tree listing
	registry.register(
		() => {
			const { CodeSearchHandler } = require("./code-search-handler");
			return new CodeSearchHandler();
		},
		{ priority: HANDLER_PRIORITY.CODE_SEARCH },
	);

	// Architecture decisions handler - reads the project's Decisions tab
	// (ArchitectureDecision rows). Checked before the generic Fabric AI handler
	// so it claims the fabric_list_architecture_decisions tool.
	registry.register(
		() => {
			const {
				ArchitectureDecisionsHandler,
			} = require("./architecture-decisions-handler");
			return new ArchitectureDecisionsHandler();
		},
		{ priority: HANDLER_PRIORITY.DECISION_CONTEXT },
	);

	// Feature decisions handler - reads a feature's Decision Log tab
	// (DecisionLogEntry threads). Checked before the generic Fabric AI handler
	// so it claims the fabric_list_feature_decisions tool.
	registry.register(
		() => {
			const {
				FeatureDecisionsHandler,
			} = require("./feature-decisions-handler");
			return new FeatureDecisionsHandler();
		},
		{ priority: HANDLER_PRIORITY.DECISION_CONTEXT },
	);

	// Security findings handler - reads the project's Security tab findings
	// (ScanFinding rows). Checked before the generic Fabric AI handler so it
	// claims the fabric_list_security_findings tool.
	registry.register(
		() => {
			const {
				SecurityFindingsHandler,
			} = require("./security-findings-handler");
			return new SecurityFindingsHandler();
		},
		{ priority: HANDLER_PRIORITY.SECURITY_FINDINGS },
	);

	// Fabric AI handler - checked for specific URLs (YouTube, etc.)
	registry.register(
		() => {
			const { FabricAiHandler } = require("./fabric-ai-handler");
			return new FabricAiHandler();
		},
		{ priority: HANDLER_PRIORITY.FABRIC_AI },
	);

	// Workflow handler for pre-defined Temporal workflows
	registry.register(
		() => {
			const { WorkflowHandler } = require("./workflow-handler");
			return new WorkflowHandler();
		},
		{ priority: HANDLER_PRIORITY.WORKFLOW },
	);

	// Integration handler for configured service integrations (Slack, GitHub, etc.)
	registry.register(
		() => {
			const { IntegrationHandler } = require("./integration-handler");
			return new IntegrationHandler();
		},
		{ priority: HANDLER_PRIORITY.INTEGRATION },
	);

	// LLM handler for pure LLM steps (fast path, no tools)
	registry.register(
		() => {
			const { LlmHandler } = require("./llm-handler");
			return new LlmHandler();
		},
		{ priority: HANDLER_PRIORITY.LLM },
	);

	// Agent handler for agent delegation via A2A protocol
	registry.register(
		() => {
			const { AgentHandler } = require("./agent-handler");
			return new AgentHandler();
		},
		{ priority: HANDLER_PRIORITY.AGENT },
	);

	// Web handler for web browsing capabilities
	registry.register(
		() => {
			const { WebHandler } = require("./web-handler");
			return new WebHandler();
		},
		{ priority: HANDLER_PRIORITY.WEB },
	);

	// MCP tool handler is registered as fallback in constructor

	return registry;
}
