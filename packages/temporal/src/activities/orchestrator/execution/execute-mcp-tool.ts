/**
 * MCP Tool Execution Activity
 *
 * Executes individual MCP tools with caching support via Letta memory.
 * Uses cached MCP clients and tool lists for performance.
 *
 * OAuth2 Support:
 * - Uses authProvider for automatic token refresh
 * - If tokens can't be refreshed, throws OAuthAuthorizationRequiredError
 * - The workflow should catch this and signal the frontend to show connection dialog
 *
 * OAuth Integration Tools:
 * - Microsoft Teams tools (configId starts with 'microsoft-teams-connected:')
 * - GitHub tools (configId starts with 'github-connected:')
 * - These are routed to their respective executors instead of MCP clients
 */

import type { WorkflowIntegrationProvider } from "@repo/database";
import { db, fetchCredentialsByIdAndProviderInTenant } from "@repo/database";
import type { OperationDefinition } from "@repo/integrations/executor-registry";
import { executeGitHubTool } from "@repo/integrations/github";
import { executeSlackTool } from "@repo/integrations/slack";
import {
	getCachedMcpClientForConfig,
	invalidateMcpClientCache,
	OAuthAuthorizationRequiredError,
} from "@repo/mcp";
import { getBaseUrl } from "@repo/utils";
import { splitIntegrationToolRef } from "@repo/utils/integration-tool-ref";
import { heartbeat } from "@temporalio/activity";
import {
	MCP_TOOL_RESULT_MAX_BYTES,
	truncateMcpTextOutput,
} from "../../../lib/payload-elision";
import { assertPayloadWithinLimit } from "../../../lib/payload-size-guard";
import {
	cacheToolResult,
	getCachedToolResult,
} from "../../letta-memory-activities";
import {
	createFirstClassFrame,
	getFirstClassFrame,
	listFirstClassFrames,
	shareFirstClassFrame,
	updateFirstClassFrame,
} from "../../shared/frame-service";
import { executeMicrosoftTeamsTool } from "../../shared/oauth-tool-executors";
import { guardToolWriteForReadOnly } from "../../shared/read-only-gate";
import { HEARTBEAT_INTERVALS } from "../config";
import type { ExecuteMcpToolInput, ExecuteMcpToolOutput } from "../types";
import { runWithTimeout } from "./mcp-call-timeout";

/**
 * Parse the synthetic config ID discovery stores for an integration tool
 * (`integration:<PROVIDER>:<integrationId>`).
 *
 * Strict on purpose: the embedded provider must equal the provider derived from
 * the tool name, and the ID must be present. There is deliberately no
 * provider-wide fallback — resolving by provider would run whichever
 * same-provider row sorts first, which can be an integration the user excluded
 * from this session.
 */
function parseIntegrationConfigId(
	configId: string | undefined,
	expectedProvider: string,
): { integrationId: string } | { error: string } {
	if (!configId) {
		return {
			error: `Cannot execute ${expectedProvider}: the tool was not bound to a specific integration. Search for the integration again and retry.`,
		};
	}

	const ref = splitIntegrationToolRef(configId);
	if (!ref) {
		return {
			error: `Cannot execute ${expectedProvider}: malformed integration reference. Search for the integration again and retry.`,
		};
	}

	if (ref.provider !== expectedProvider) {
		return {
			error: `Cannot execute ${expectedProvider}: the bound integration belongs to ${ref.provider}. Search for the integration again and retry.`,
		};
	}

	return { integrationId: ref.integrationId };
}

/**
 * Normalize the `args` payload of an `integration__*` tool call.
 *
 * A malformed payload is rejected rather than silently replaced with `{}` — an
 * empty object turns a broken call into a plausible-looking one that queries
 * the wrong thing.
 */
function parseIntegrationArgsEnvelope(
	rawArgs: unknown,
): { args: Record<string, unknown> } | { error: string } {
	// Absent, or the empty string a model sends when it means "no arguments".
	if (
		rawArgs === undefined ||
		rawArgs === null ||
		(typeof rawArgs === "string" && rawArgs.trim() === "")
	) {
		return { args: {} };
	}

	let candidate: unknown = rawArgs;
	if (typeof rawArgs === "string") {
		try {
			candidate = JSON.parse(rawArgs);
		} catch {
			return {
				error: 'Tool "args" is not valid JSON. Pass an object of operation arguments.',
			};
		}
	}

	if (
		candidate === null ||
		typeof candidate !== "object" ||
		Array.isArray(candidate)
	) {
		return {
			error: 'Tool "args" must be a JSON object of operation arguments.',
		};
	}

	return { args: candidate as Record<string, unknown> };
}

/**
 * Safely send a heartbeat — swallow errors when called outside an activity
 * context (e.g. in tests that import this module directly).
 */
function safeHeartbeat(details?: unknown): void {
	try {
		heartbeat(details);
	} catch {
		// Not running inside an activity context — ignore.
	}
}

// =============================================================================
// Arg Deserialization & Type Coercion
// =============================================================================

/**
 * Extract the JSON Schema from an AI SDK tool definition.
 *
 * AI SDK tools expose the raw JSON schema at different paths depending on how
 * they were created:
 *   - `tool()` → `toolDef.parameters.jsonSchema`
 *   - `dynamicTool()` → `toolDef.inputSchema.jsonSchema`
 */
function extractToolJsonSchema(
	toolDef: unknown,
): Record<string, unknown> | null {
	try {
		const def = toolDef as {
			parameters?: { jsonSchema?: Record<string, unknown> };
			inputSchema?: { jsonSchema?: Record<string, unknown> };
		};

		// tool() uses `parameters`, dynamicTool() uses `inputSchema`
		const schema =
			def?.parameters?.jsonSchema ?? def?.inputSchema?.jsonSchema ?? null;

		if (schema && typeof schema === "object" && "properties" in schema) {
			return schema;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Coerce LLM-generated args to match the tool's expected JSON Schema types.
 *
 * LLMs frequently output string literals for non-string types:
 *   - `"true"` / `"false"` instead of `true` / `false` (boolean)
 *   - `"100"` instead of `100` (number/integer)
 *   - `"[1,2,3]"` instead of `[1,2,3]` (array)
 *   - `"{\"a\":1}"` instead of `{"a":1}` (object)
 *
 * This function reads the tool's JSON Schema `properties` and coerces string
 * values to their expected types. Idempotent — safe to apply multiple times.
 */
function coerceArgsToSchema(
	args: Record<string, unknown>,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const properties = (
		schema as { properties?: Record<string, Record<string, unknown>> }
	).properties;
	if (!properties) {
		return args;
	}

	const coerced = { ...args };
	let didCoerce = false;

	for (const [key, value] of Object.entries(coerced)) {
		const propSchema = properties[key];
		if (!propSchema || value === null || value === undefined) {
			continue;
		}

		const expectedType = propSchema.type as string | undefined;

		if (expectedType === "boolean" && typeof value === "string") {
			if (value === "true") {
				coerced[key] = true;
				didCoerce = true;
			} else if (value === "false") {
				coerced[key] = false;
				didCoerce = true;
			}
		} else if (
			(expectedType === "number" || expectedType === "integer") &&
			typeof value === "string"
		) {
			const trimmed = value.trim();
			if (trimmed.length === 0) {
				continue; // Don't coerce empty/whitespace to 0
			}
			const num = Number(trimmed);
			if (!Number.isNaN(num)) {
				coerced[key] =
					expectedType === "integer" ? Math.trunc(num) : num;
				didCoerce = true;
			}
		} else if (expectedType === "array" && typeof value === "string") {
			try {
				const parsed = JSON.parse(value);
				if (Array.isArray(parsed)) {
					coerced[key] = parsed;
					didCoerce = true;
				}
			} catch {
				// Not valid JSON array — leave as string
			}
		} else if (expectedType === "object" && typeof value === "string") {
			try {
				const parsed = JSON.parse(value);
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					!Array.isArray(parsed)
				) {
					coerced[key] = parsed;
					didCoerce = true;
				}
			} catch {
				// Not valid JSON object — leave as string
			}
		}
	}

	if (didCoerce) {
		const fixedKeys = Object.keys(coerced).filter(
			(k) => args[k] !== coerced[k],
		);
		console.log(
			`[Orchestrator] Coerced arg types to match schema: ${fixedKeys.join(", ")}`,
		);
	}

	return coerced;
}

/**
 * LLMs sometimes stringify complex nested parameters (e.g. ADO work item fields).
 * Instead of producing `fields: [{name: "System.Title", value: "..."}]` (an array),
 * the LLM may produce `fields: "[{\"name\":\"System.Title\",\"value\":\"...\"}]"` (a string).
 *
 * This function:
 * 1. Detects string values that look like JSON arrays/objects and parses them
 * 2. Converts flat key-value objects to name/value arrays when the key looks like
 *    a dotted field path (e.g. ADO's "System.Title" → [{name, value}])
 */
function deserializeStringifiedArgs(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let didFix = false;

	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (
				(trimmed.startsWith("[") && trimmed.endsWith("]")) ||
				(trimmed.startsWith("{") && trimmed.endsWith("}"))
			) {
				try {
					result[key] = JSON.parse(trimmed);
					didFix = true;
				} catch {
					// Not valid JSON, keep as string
					result[key] = value;
				}
			} else {
				result[key] = value;
			}
		} else {
			result[key] = value;
		}
	}

	// Post-parse fix: convert flat field objects to name/value arrays.
	// LLMs often produce {"System.Title": "val"} instead of [{name: "System.Title", value: "val"}].
	// Detect by checking if the value is a plain object whose keys contain dots (e.g. "System.Title").
	for (const [key, value] of Object.entries(result)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			key.toLowerCase() === "fields"
		) {
			const obj = value as Record<string, unknown>;
			const objKeys = Object.keys(obj);
			const hasDottedKeys = objKeys.some((k) => k.includes("."));
			if (hasDottedKeys && objKeys.length > 0) {
				result[key] = objKeys.map((fieldName) => ({
					name: fieldName,
					value: String(obj[fieldName] ?? ""),
				}));
				didFix = true;
				console.log(
					`[Orchestrator] Converted flat fields object to name/value array (${objKeys.length} fields)`,
				);
			}
		}
	}

	if (didFix) {
		console.log(
			"[Orchestrator] Fixed LLM-generated args:",
			Object.keys(result).filter(
				(k) => JSON.stringify(args[k]) !== JSON.stringify(result[k]),
			),
		);
	}

	return result;
}

// =============================================================================
// Excalidraw Element Normalization
// LLMs generate minimal element objects (type, x, y, width, height) but the
// Excalidraw MCP server requires ~20 additional fields per element.
// This function fills in sensible defaults for all missing required fields.
// =============================================================================

let _excalidrawIdCounter = 0;

function makeExcalidrawId(): string {
	_excalidrawIdCounter++;
	return `el-${Date.now()}-${_excalidrawIdCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeExcalidrawElement(
	el: Record<string, unknown>,
): Record<string, unknown> {
	const type = (el.type as string) || "rectangle";
	const now = Date.now();

	// Handle common LLM aliases: w→width, h→height
	if (el.w !== undefined && el.width === undefined) {
		el.width = el.w;
		delete el.w;
	}
	if (el.h !== undefined && el.height === undefined) {
		el.height = el.h;
		delete el.h;
	}

	// Base defaults shared by all element types
	const defaults: Record<string, unknown> = {
		id: makeExcalidrawId(),
		type,
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		angle: 0,
		strokeColor: "#1e1e1e",
		backgroundColor: "transparent",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [],
		frameId: null,
		roundness: null,
		seed: Math.floor(Math.random() * 2147483647),
		version: 1,
		versionNonce: Math.floor(Math.random() * 2147483647),
		isDeleted: false,
		boundElements: null,
		updated: now,
		link: null,
		locked: false,
	};

	// Text-specific defaults
	if (type === "text") {
		// el.label may be a string or {text,fontSize} object — extract text string
		const labelStr =
			typeof el.label === "object" && el.label !== null
				? ((el.label as Record<string, unknown>).text as string) || ""
				: (el.label as string) || "";
		const textContent = (el.text as string) || labelStr || "";
		const isBound = !!el.containerId;
		Object.assign(defaults, {
			text: textContent,
			fontSize: 16,
			fontFamily: 1,
			textAlign: isBound ? "center" : "left",
			verticalAlign: isBound ? "middle" : "top",
			containerId: null,
			originalText: textContent,
			lineHeight: 1.25,
			autoResize: true,
		});
	}

	// Arrow/line specific defaults
	if (type === "arrow" || type === "line") {
		Object.assign(defaults, {
			points: (el.points as unknown[]) || [
				[0, 0],
				[100, 0],
			],
			lastCommittedPoint: null,
			startBinding: null,
			endBinding: null,
			startArrowhead: type === "arrow" ? "arrow" : null,
			endArrowhead: type === "arrow" ? "arrow" : null,
		});
	}

	// Merge: element's own values take precedence over defaults.
	// Strip "name" (not a valid Excalidraw field).
	// "label" is kept and converted to the {text, fontSize} object format
	// the Excalidraw MCP server expects on shape elements (rectangle/ellipse/diamond/arrow).
	const {
		label: _label,
		name: _name,
		...cleanEl
	} = el as Record<string, unknown> & { label?: unknown; name?: unknown };

	const normalized = { ...defaults, ...cleanEl };

	// Re-attach label as {text, fontSize} for shapes and arrows that support it.
	// The MCP server handles this natively — no separate text element needed.
	const supportsLabel =
		type === "rectangle" ||
		type === "ellipse" ||
		type === "diamond" ||
		type === "arrow";
	const rawLabel = _label || _name;
	if (supportsLabel && rawLabel) {
		if (typeof rawLabel === "object" && rawLabel !== null) {
			// Already the correct {text, fontSize} format
			(normalized as Record<string, unknown>).label = rawLabel;
		} else {
			// Convert plain string → object
			(normalized as Record<string, unknown>).label = {
				text: String(rawLabel),
				fontSize: 16,
			};
		}
	}

	return normalized;
}

/**
 * Normalize args for Excalidraw's create_view tool.
 * Fills in all missing required element fields so the MCP server validation passes.
 */
function normalizeExcalidrawCreateViewArgs(
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!args.elements || !Array.isArray(args.elements)) {
		return args;
	}

	const normalizedElements: Record<string, unknown>[] = [];

	for (const el of args.elements as Record<string, unknown>[]) {
		if (typeof el !== "object" || el === null) {
			continue;
		}

		const normalized = normalizeExcalidrawElement(el);
		normalizedElements.push(normalized);
	}

	// Compute the bounding box of all drawn elements and append a final cameraUpdate
	// that frames the content exactly — this prevents white-space gaps in the iframe.
	const CAMERA_SIZES = [
		{ w: 400, h: 300 },
		{ w: 600, h: 450 },
		{ w: 800, h: 600 },
		{ w: 1200, h: 900 },
		{ w: 1600, h: 1200 },
	];
	const PADDING = 50;

	const shapes = normalizedElements.filter(
		(el) =>
			el.type !== "cameraUpdate" &&
			el.type !== "text" &&
			el.type !== "restoreCheckpoint" &&
			el.type !== "delete",
	);

	if (shapes.length > 0) {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const el of shapes) {
			const x = (el.x as number) || 0;
			const y = (el.y as number) || 0;
			const w = (el.width as number) || 0;
			const h = (el.height as number) || 0;
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x + w);
			maxY = Math.max(maxY, y + h);
		}

		const contentW = maxX - minX + PADDING * 2;
		const contentH = maxY - minY + PADDING * 2;

		// Pick the smallest 4:3 camera that fits the content
		let camera = CAMERA_SIZES[CAMERA_SIZES.length - 1];
		for (const size of CAMERA_SIZES) {
			if (size.w >= contentW && size.h >= contentH) {
				camera = size;
				break;
			}
		}

		normalizedElements.push({
			type: "cameraUpdate",
			width: camera.w,
			height: camera.h,
			x: minX - PADDING,
			y: minY - PADDING,
		});
	}

	console.log(
		`[Orchestrator] Normalized ${normalizedElements.length} Excalidraw elements for create_view`,
	);

	// The MCP server expects elements as a JSON-encoded string, not an array
	return { ...args, elements: JSON.stringify(normalizedElements) };
}

// =============================================================================
// Tool List Cache - Avoid re-fetching tool list for every execution
// =============================================================================

interface CachedToolList {
	tools: Record<string, unknown>;
	cachedAt: number;
}

// Cache tool lists per configId+userId
const toolListCache = new Map<string, CachedToolList>();

// Tool list cache TTL (5 minutes - matches MCP client cache)
const TOOL_LIST_CACHE_TTL = 5 * 60 * 1000;

function getToolListCacheKey(
	configId: string,
	userId: string,
	organizationId?: string,
): string {
	return `tools:${configId}:${userId}:${organizationId ?? "personal"}`;
}

async function getCachedToolList(
	configId: string,
	userId: string,
	organizationId: string | undefined,
	client: { tools: () => Promise<Record<string, unknown>> },
): Promise<Record<string, unknown>> {
	const cacheKey = getToolListCacheKey(configId, userId, organizationId);
	const cached = toolListCache.get(cacheKey);

	if (cached && Date.now() - cached.cachedAt < TOOL_LIST_CACHE_TTL) {
		return cached.tools;
	}

	// Fetch fresh tool list
	const tools = await client.tools();
	toolListCache.set(cacheKey, {
		tools,
		cachedAt: Date.now(),
	});

	return tools;
}

/**
 * Executes a single MCP tool with optional caching.
 *
 * Features:
 * - Letta cache check before execution (if lettaAgentId provided)
 * - Automatic tool discovery across configured MCP servers
 * - Result caching for future use
 * - Error caching to avoid repeated failed calls
 *
 * Heartbeats are emitted every {@link HEARTBEAT_INTERVALS.DEFAULT} ms for the
 * entire lifetime of the activity so Temporal's heartbeat timeout (configured
 * on the proxy, e.g. 30s) is never exceeded during slow tool executions (OAuth
 * API calls, MCP round-trips, image generation, large LLM patterns, etc.).
 * Additional explicit heartbeats are sent at phase boundaries with `{ phase,
 * toolName }` details for observability.
 */
export async function executeMcpTool(
	input: ExecuteMcpToolInput,
): Promise<ExecuteMcpToolOutput> {
	const startTime = Date.now();

	const heartbeatInterval = setInterval(
		() =>
			safeHeartbeat({
				toolName: input.toolName,
				elapsedMs: Date.now() - startTime,
			}),
		HEARTBEAT_INTERVALS.DEFAULT,
	);

	// When a timeout is set, also cancel the underlying MCP call on expiry so a
	// never-settling tool.execute releases its request/socket instead of piling
	// up across cycles (finding 8). One controller per call → siblings sharing
	// the cached client are unaffected.
	const abortController = input.timeoutMs ? new AbortController() : undefined;

	try {
		const work = executeMcpToolImpl(
			input,
			startTime,
			abortController?.signal,
		);
		// Opt-in per-call timeout. The race resolves on timeout, so this function
		// returns and the `finally` below clears the heartbeat interval — the
		// hung `tool.execute` inside `work` can no longer leak a live timer.
		const result = await (input.timeoutMs
			? runWithTimeout(work, input.timeoutMs, () => {
					abortController?.abort();
					return {
						output: {
							error: `MCP tool "${input.toolName}" timed out after ${input.timeoutMs}ms`,
						},
						durationMs: Date.now() - startTime,
						success: false,
						cached: false,
					};
				})
			: work);

		// Bound EVERY exit of the impl at this single choke point (#1997):
		// integration, Teams/GitHub/Slack OAuth and Fabric-AI tool results cross
		// this same activity boundary, not only the generic MCP return.
		// JSON-shaped text is never cut mid-document (see payload-elision);
		// whatever cannot be expressed within the frame fails here with a named
		// error instead of a post-retry core rejection.
		const bounded = truncateMcpTextOutput(
			result.output,
			MCP_TOOL_RESULT_MAX_BYTES,
		);
		if (bounded.truncated) {
			console.warn(
				`[Orchestrator] Tool "${input.toolName}" result exceeded ${MCP_TOOL_RESULT_MAX_BYTES} bytes — text truncated (was ${bounded.originalBytes})`,
			);
		} else if (bounded.originalBytes > MCP_TOOL_RESULT_MAX_BYTES) {
			// Truncation was bypassed (JSON-shaped text the parsers need intact,
			// or no cuttable content[]): the whole result crosses the boundary.
			// Still under the frame guard below, but operators should see the
			// 512 KiB policy being skipped.
			console.warn(
				`[Orchestrator] Tool "${input.toolName}" result exceeded ${MCP_TOOL_RESULT_MAX_BYTES} bytes but was not truncated (was ${bounded.originalBytes}) — crossing whole`,
			);
		}
		assertPayloadWithinLimit(
			bounded.output,
			`executeMcpTool(${input.toolName}) result`,
		);

		return { ...result, output: bounded.output };
	} finally {
		clearInterval(heartbeatInterval);
	}
}

/**
 * Execute a `integration__{PROVIDER}` tool from the LOOM chat surface.
 *
 * Ordering is the point of this function. Everything the registry can tell us —
 * provider, operation, chat opt-in, argument envelope, bound integration ID —
 * is resolved and validated BEFORE any gate runs, so an unsupported provider is
 * reported as unsupported rather than as whatever the generic name-based gate
 * happened to conclude. The Read-only gate then runs once, on the operation's
 * REGISTRY-DECLARED access rather than its name.
 *
 * Generic Letta result caching is deliberately not applied here: a cache hit
 * would return provider data without re-checking authority or that the
 * integration row is still active.
 */
async function executeIntegrationTool(
	input: ExecuteMcpToolInput,
	startTime: number,
	signal?: AbortSignal,
): Promise<ExecuteMcpToolOutput> {
	// Two tool-name forms reach here:
	//   integration__{PROVIDER}__{operation}  operation in the name, args direct
	//   integration__{PROVIDER}                legacy envelope in args
	// The second only arises when replaying an activity result recorded before
	// operations were projected as separate tools.
	const [, providerSegment, operationSegment] = input.toolName.split("__");
	const provider = providerSegment ?? "";
	const operation =
		operationSegment ?? (input.args?.operation as string) ?? "";
	const rawArgs = operationSegment ? input.args : input.args?.args;

	console.log(
		`[Orchestrator] Routing to integration executor: ${provider}/${operation || "<missing operation>"}`,
	);
	safeHeartbeat({
		phase: "integration",
		toolName: input.toolName,
		provider,
		operation,
	});

	// Structured failure — the iterative loop shows this to the model and the UI
	// instead of aborting the turn.
	const fail = (message: string): ExecuteMcpToolOutput => {
		console.error(
			`[Orchestrator] Integration tool "${provider}/${operation}" rejected: ${message}`,
		);
		return {
			success: false,
			output: { error: message },
			durationMs: Date.now() - startTime,
			cached: false,
		};
	};

	// Imported lazily to keep the registry out of THIS module's static graph:
	// several activity tests mock `@repo/utils` and `@repo/database` down to a
	// couple of exports, and a static import here would drag the registry's own
	// dependencies through those stubs. The activity barrel imports the registry
	// statically elsewhere, so this saves nothing at worker startup.
	const registry = await import("@repo/integrations/executor-registry");

	// ── 1. Shape, before any gate or credential access ────────────────────────
	if (!registry.getIntegrationExecutor(provider)) {
		return fail(`Unsupported integration provider: ${provider}`);
	}

	if (!operation) {
		return fail(
			`Missing "operation" for ${provider}. Supported: ${registry.listIntegrationOperationNames(provider).join(", ")}`,
		);
	}

	let operationDefinition: OperationDefinition;
	try {
		operationDefinition = registry.resolveIntegrationOperation(
			provider,
			operation,
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (!operationDefinition.chatEnabled) {
		return fail(
			`Operation "${operation}" on ${provider} is not available from chat.`,
		);
	}

	const parsedEnvelope = parseIntegrationArgsEnvelope(rawArgs);
	if ("error" in parsedEnvelope) {
		return fail(parsedEnvelope.error);
	}

	const integrationRef = parseIntegrationConfigId(
		input.mcpConfigId,
		provider,
	);
	if ("error" in integrationRef) {
		return fail(integrationRef.error);
	}

	// ── 2. Project Read-only mode, on the DECLARED access ────────────────────
	// This is the only Read-only check on this path; the generic chokepoint gate
	// is bypassed because it would classify the operation from its name.
	const readOnlyBlock = await guardToolWriteForReadOnly(
		input.projectId,
		operation,
		{ accessOverride: operationDefinition.access },
	);
	if (readOnlyBlock) {
		console.log(
			`[Orchestrator] Blocked ${provider}/${operation} — project ${input.projectId} is in Read-only mode`,
		);
		return {
			output: readOnlyBlock,
			durationMs: Date.now() - startTime,
			success: false,
			cached: false,
		};
	}

	// ── 3. Runtime authority, also driven by declared access ─────────────────
	// READ operations return authorized without prompting.
	try {
		const { checkIntegrationAuthority } = await import("./authority-gate");
		const authorityResult = await checkIntegrationAuthority({
			userId: input.userId,
			organizationId: input.organizationId,
			provider,
			operation,
			runType: "ORCHESTRATOR",
			runId: input.executionId,
		});
		if (!authorityResult.authorized) {
			return fail(
				`Runtime authority required for ${provider} (${authorityResult.requiredAccessLevel} access for "${authorityResult.providerKey}"). ${authorityResult.reason ?? ""}`.trim(),
			);
		}
	} catch (error) {
		// Fail closed — an authority check that errors must not admit the call.
		return fail(
			`Authority check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// ── 4. Credentials for the EXACT discovered integration ──────────────────
	// Also revalidates that the row is still active — including for
	// credentialless providers, so a disconnected integration stops working
	// immediately.
	const credentials = await fetchCredentialsByIdAndProviderInTenant(
		integrationRef.integrationId,
		provider as WorkflowIntegrationProvider,
		input.userId,
		input.organizationId,
	);
	if (!credentials) {
		return fail(
			`${provider} integration is not available — it may have been disconnected or disabled. Please reconnect it in Settings > Integrations.`,
		);
	}

	// ── 5. Execute ───────────────────────────────────────────────────────────
	try {
		const result = await registry.executeRegisteredIntegrationOperation({
			provider,
			operation,
			args: parsedEnvelope.args,
			credentials,
			signal,
		});

		return {
			success: true,
			output: result.data,
			durationMs: Date.now() - startTime,
			cached: false,
		};
	} catch (error) {
		console.error(
			`[Orchestrator] Integration tool "${provider}/${operation}" failed:`,
			error,
		);
		return {
			success: false,
			output: {
				error:
					error instanceof Error
						? error.message
						: "Integration execution failed",
			},
			durationMs: Date.now() - startTime,
			cached: false,
		};
	}
}

async function executeMcpToolImpl(
	input: ExecuteMcpToolInput,
	startTime: number,
	signal?: AbortSignal,
): Promise<ExecuteMcpToolOutput> {
	console.log(`[Orchestrator] Executing MCP tool: ${input.toolName}`);

	const toolNameLower = input.toolName.toLowerCase();

	// Integration tools resolve against the executor registry FIRST — before the
	// generic Read-only gate and before the result cache — so policy decisions
	// are made from the provider's declared access rather than from a tool name
	// the model supplied. See executeIntegrationTool.
	if (toolNameLower.startsWith("integration__")) {
		return executeIntegrationTool(input, startTime, signal);
	}

	// Project-level Read-only mode: this is the universal
	// dispatch point for external tool calls (MCP servers + the Teams/GitHub/
	// Slack executor routes below), so gating here also stops writes that were
	// already queued or in-flight when the mode was enabled. Shared with the
	// in-process agent tool wrappers via guardToolWriteForReadOnly.
	//
	// `integration__*` tools never reach here — they returned above, gated on
	// their registry-declared access instead of on a name. `fabric_*` names are
	// exempt HERE because they route to the in-process Fabric AI switch below;
	// the unknown-name fallthrough to external MCP re-gates strictly.
	const readOnlyBlock = await guardToolWriteForReadOnly(
		input.projectId,
		input.toolName,
		{ exemptFabricInternalTools: true },
	);
	if (readOnlyBlock) {
		console.log(
			`[Orchestrator] Blocked write tool "${input.toolName}" — project ${input.projectId} is in Read-only mode`,
		);
		return {
			output: readOnlyBlock,
			durationMs: Date.now() - startTime,
			success: false,
		};
	}

	// ==========================================================================
	// LETTA CACHE CHECK: Try to get cached result first
	// ==========================================================================
	safeHeartbeat({ phase: "cache-check", toolName: input.toolName });
	if (input.lettaAgentId) {
		try {
			const cached = await getCachedToolResult({
				lettaAgentId: input.lettaAgentId,
				userId: input.userId,
				toolName: input.toolName,
				toolArgs: input.args,
			});

			if (cached.found) {
				const cacheAge = cached.cachedAt
					? Date.now() - new Date(cached.cachedAt).getTime()
					: 0;
				console.log(
					`[Letta Cache HIT] ${input.toolName} ` +
						`(age: ${Math.round(cacheAge / 1000)}s, hits: ${cached.hitCount})`,
				);

				return {
					output: cached.result,
					durationMs: 0, // Instant from cache
					success: true,
					cached: true,
					cacheHitCount: cached.hitCount,
				};
			}
		} catch (error) {
			console.warn(
				"[Letta Cache] Failed to check cache, executing tool",
				error,
			);
			// Continue to normal execution
		}
	}

	// ==========================================================================
	// CACHE MISS: Execute tool normally
	// ==========================================================================

	// ==========================================================================
	// OAUTH INTEGRATION TOOLS: Route to appropriate executor
	// ==========================================================================

	// Check if this is a Microsoft Teams OAuth tool (by configId or tool name pattern)
	// Tool names are like "Microsoft_Teams__list_teams" or "Microsoft_Teams__search_messages"
	const isMicrosoftTeamsTool =
		input.mcpConfigId?.startsWith("microsoft-teams-connected:") ||
		toolNameLower.startsWith("microsoft_teams__");

	if (isMicrosoftTeamsTool) {
		console.log(
			`[Orchestrator] Routing to Microsoft Teams OAuth executor: ${input.toolName}`,
		);
		safeHeartbeat({ phase: "oauth-teams", toolName: input.toolName });

		// Extract the method name from the tool name
		// Tool names are like "Microsoft_Teams__list_teams" or "Microsoft_Teams__search_messages"
		const methodName = input.toolName.includes("__")
			? input.toolName.split("__")[1]
			: input.toolName;

		try {
			const output = await executeMicrosoftTeamsTool(
				methodName,
				input.args || {},
				input.userId,
				input.organizationId,
			);

			const durationMs = Date.now() - startTime;

			// Cache successful OAuth result
			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: output,
						durationMs,
						success: true,
					});
					console.log(
						`[Letta Cache] Stored Microsoft Teams result for ${input.toolName}`,
					);
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache OAuth result",
						cacheError,
					);
				}
			}

			return {
				output,
				durationMs,
				success: true,
				cached: false,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(
				`[Orchestrator] Microsoft Teams tool "${input.toolName}" execution failed:`,
				errorMessage,
			);

			const durationMs = Date.now() - startTime;

			// Cache failed OAuth result
			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: { error: errorMessage },
						durationMs,
						success: false,
					});
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache OAuth error result",
						cacheError,
					);
				}
			}

			// IMPORTANT: Return error as result instead of throwing
			// This allows the LLM to see the error and correct its tool call
			// instead of Temporal retrying the same failing request
			return {
				output: { error: errorMessage },
				durationMs,
				success: false,
				cached: false,
			};
		}
	}

	// Check if this is a GitHub OAuth tool
	// Tool names are like "GitHub__create_issue" or "GitHub__list_issues"
	const isGitHubTool =
		input.mcpConfigId?.startsWith("github-connected:") ||
		toolNameLower.startsWith("github__");

	if (isGitHubTool) {
		console.log(
			`[Orchestrator] Routing to GitHub OAuth executor: ${input.toolName}`,
		);
		safeHeartbeat({ phase: "oauth-github", toolName: input.toolName });

		const methodName = input.toolName.includes("__")
			? input.toolName.split("__")[1]
			: input.toolName;

		try {
			const output = await executeGitHubTool(
				methodName,
				input.args || {},
				input.userId,
				input.organizationId,
			);

			const durationMs = Date.now() - startTime;

			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: output,
						durationMs,
						success: true,
					});
					console.log(
						`[Letta Cache] Stored GitHub result for ${input.toolName}`,
					);
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache GitHub OAuth result",
						cacheError,
					);
				}
			}

			return {
				output,
				durationMs,
				success: true,
				cached: false,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(
				`[Orchestrator] GitHub tool "${input.toolName}" execution failed:`,
				errorMessage,
			);

			const durationMs = Date.now() - startTime;

			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: { error: errorMessage },
						durationMs,
						success: false,
					});
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache GitHub error result",
						cacheError,
					);
				}
			}

			return {
				output: { error: errorMessage },
				durationMs,
				success: false,
				cached: false,
			};
		}
	}

	// Check if this is a Slack OAuth tool
	// Tool names are like "Slack__list_channels" or "Slack__search_messages"
	const isSlackTool =
		input.mcpConfigId?.startsWith("slack-connected:") ||
		toolNameLower.startsWith("slack__");

	if (isSlackTool) {
		console.log(
			`[Orchestrator] Routing to Slack OAuth executor: ${input.toolName}`,
		);
		safeHeartbeat({ phase: "oauth-slack", toolName: input.toolName });

		const methodName = input.toolName.includes("__")
			? input.toolName.split("__")[1]
			: input.toolName;

		try {
			const output = await executeSlackTool(
				methodName,
				input.args || {},
				input.userId,
				input.organizationId,
			);

			const durationMs = Date.now() - startTime;

			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: output,
						durationMs,
						success: true,
					});
					console.log(
						`[Letta Cache] Stored Slack result for ${input.toolName}`,
					);
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache Slack OAuth result",
						cacheError,
					);
				}
			}

			return {
				output,
				durationMs,
				success: true,
				cached: false,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(
				`[Orchestrator] Slack tool "${input.toolName}" execution failed:`,
				errorMessage,
			);

			const durationMs = Date.now() - startTime;

			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: { error: errorMessage },
						durationMs,
						success: false,
					});
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache Slack error result",
						cacheError,
					);
				}
			}

			return {
				output: { error: errorMessage },
				durationMs,
				success: false,
				cached: false,
			};
		}
	}

	// ==========================================================================
	// FABRIC AI TOOLS: Built-in virtual tools (web search, scraping, patterns)
	// These are NOT MCP tools - they're executed directly via Fabric AI activities
	// ==========================================================================
	const isFabricAiTool = toolNameLower.startsWith("fabric_");
	if (isFabricAiTool) {
		console.log(
			`[Orchestrator] Routing to Fabric AI executor: ${input.toolName}`,
		);
		safeHeartbeat({ phase: "fabric-ai", toolName: input.toolName });

		try {
			const fabricAi = await import("../../fabric-ai");
			const args = input.args || {};
			let output: unknown;

			switch (input.toolName) {
				case "fabric_web_search": {
					const result = await fabricAi.searchWebActivity({
						question: (args.query as string) || "",
						userId: input.userId,
						organizationId: input.organizationId,
					});
					output = result.success
						? result.results
						: { error: result.error };
					break;
				}
				case "fabric_search_and_analyze": {
					const result = await fabricAi.searchAndAnalyzeActivity({
						question: (args.query as string) || "",
						pattern: (args.pattern as any) || "summarize",
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: input.projectId,
					});
					output = result.success
						? result.analysis
						: { error: result.error };
					break;
				}
				case "fabric_scrape_url": {
					const result = await fabricAi.scrapeUrlActivity({
						url: (args.url as string) || "",
						userId: input.userId,
						organizationId: input.organizationId,
					});
					output = result.success
						? result.content
						: { error: result.error };
					break;
				}
				case "fabric_scrape_and_analyze": {
					const result = await fabricAi.scrapeAndAnalyzeActivity({
						url: (args.url as string) || "",
						pattern: (args.pattern as any) || "summarize",
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: input.projectId,
					});
					output = result.success
						? result.analysis
						: { error: result.error };
					break;
				}
				case "fabric_pattern": {
					const result = await fabricAi.executeFabricPattern({
						pattern: (args.pattern as any) || "summarize",
						input:
							(args.input as string) ||
							(args.content as string) ||
							"",
						variables:
							(args.variables as Record<string, string>) || {},
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: input.projectId,
					});
					output = result.success
						? result.output
						: { error: result.error };
					break;
				}
				case "fabric_generate_image": {
					const { generateImageActivity } = await import(
						"../../image-generation"
					);

					const prompt = (args.prompt as string) || "";
					const provider =
						(args.provider as "gateway" | "fal" | "gemini") ||
						"gateway";
					// Use storage path for input images (not URLs - prevents SSRF)
					const inputImagePath =
						(args.inputImage as string) ||
						input.attachedImageUrls?.[0] ||
						undefined;

					if (!prompt) {
						output = {
							error: "Prompt is required for image generation",
						};
						break;
					}

					const imageResult = await generateImageActivity({
						prompt,
						provider,
						aspectRatio: (args.aspectRatio as string) || "1:1",
						quality: (args.quality as string) || "medium",
						model: args.model as string | undefined,
						inputImagePath,
						gatewayModel: args.gatewayModel as string | undefined,
						userId: input.userId,
						organizationId: input.organizationId,
					});

					if (!imageResult.success) {
						output = {
							error:
								imageResult.error || "Image generation failed",
						};
					} else {
						// Use proxy URL for stable image display (won't expire like signed URLs)
						const orgParam = input.organizationId
							? `&orgId=${encodeURIComponent(input.organizationId)}`
							: "";
						const imageDisplayUrl = imageResult.storagePath
							? `/api/storage/image?path=${encodeURIComponent(imageResult.storagePath)}${orgParam}`
							: imageResult.imageUrl;

						const dimensions =
							imageResult.width && imageResult.height
								? ` (${imageResult.width}x${imageResult.height})`
								: "";
						let resultText = `![Generated Image](${imageDisplayUrl})\n\n`;
						if (imageResult.text) {
							resultText += `${imageResult.text}\n\n`;
						}
						resultText +=
							`Image generated successfully using ${imageResult.provider}${dimensions}.\n` +
							`Model: ${imageResult.model}`;
						output = resultText;
					}
					break;
				}
				case "fabric_create_frame":
				case "fabric_create_slideshow": {
					const full = await createFirstClassFrame({
						args: args as Record<string, unknown>,
						userId: input.userId,
						organizationId: input.organizationId,
					});
					// Drop the rendered HTML from the workflow-bound result. The
					// content is already persisted in the DB; carrying it here
					// inflates state, blows past `truncateResult`'s 5KB cap (which
					// would replace the entire object with a sentinel string and
					// strand the client without `frameId`/`frameUrl`), and re-bills
					// the LLM for ~7KB of duplicate input every subsequent
					// iteration. Identifiers are all the client + LLM need.
					if ("error" in full) {
						output = full;
					} else {
						const { content: _content, ...lean } = full;
						output = lean;
					}
					break;
				}
				case "fabric_update_frame": {
					output = await updateFirstClassFrame({
						args: args as Record<string, unknown>,
						userId: input.userId,
						organizationId: input.organizationId,
					});
					break;
				}
				case "fabric_get_frame": {
					output = await getFirstClassFrame({
						args: args as Record<string, unknown>,
						userId: input.userId,
						organizationId: input.organizationId,
					});
					break;
				}
				case "fabric_list_frames": {
					output = await listFirstClassFrames({
						userId: input.userId,
						organizationId: input.organizationId,
					});
					break;
				}
				case "fabric_share_frame": {
					output = await shareFirstClassFrame({
						args: args as Record<string, unknown>,
						userId: input.userId,
						organizationId: input.organizationId,
					});
					break;
				}
				default: {
					// For other fabric_ tools, let them fall through to MCP execution.
					// The top gate exempted fabric_* for the internal cases above —
					// but past this point the name belongs to an EXTERNAL server
					// (a third party can name a write tool fabric_update_page), so
					// re-gate strictly before the fallthrough (post-ship review
					// finding: the name-based exemption was a write escape).
					const fallthroughBlock = await guardToolWriteForReadOnly(
						input.projectId,
						input.toolName,
					);
					if (fallthroughBlock) {
						output = fallthroughBlock;
						break;
					}
					console.log(
						`[Orchestrator] Unknown Fabric AI tool "${input.toolName}", falling through to MCP`,
					);
					break;
				}
			}

			if (output !== undefined) {
				const durationMs = Date.now() - startTime;

				// Cache Fabric AI result
				const isError =
					typeof output === "object" &&
					output !== null &&
					"error" in output;
				if (input.lettaAgentId) {
					try {
						await cacheToolResult({
							lettaAgentId: input.lettaAgentId,
							userId: input.userId,
							toolName: input.toolName,
							toolArgs: input.args,
							result: output,
							durationMs,
							success: !isError,
						});
						console.log(
							`[Letta Cache] Stored Fabric AI result for ${input.toolName}`,
						);
					} catch (cacheError) {
						console.warn(
							"[Letta Cache] Failed to cache Fabric AI result",
							cacheError,
						);
					}
				}

				return {
					output,
					durationMs,
					success: !isError,
					cached: false,
				};
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(
				`[Orchestrator] Fabric AI tool "${input.toolName}" failed:`,
				errorMessage,
			);
			return {
				output: { error: errorMessage },
				durationMs: Date.now() - startTime,
				success: false,
				cached: false,
			};
		}
	}

	// ==========================================================================
	// MCP TOOLS: Execute via MCP client
	// ==========================================================================

	// Build redirect URI for OAuth2 token refresh
	// This enables automatic token refresh via authProvider
	const baseUrl = getBaseUrl();
	const redirectUri = `${baseUrl}/api/mcp/oauth/callback`;

	// Helper function to execute tool on a specific config
	// isRetry=true skips closed-client retry to prevent infinite recursion
	const executeOnConfig = async (
		configId: string,
		serverName?: string,
		isRetry = false,
	): Promise<ExecuteMcpToolOutput | null> => {
		try {
			safeHeartbeat({
				phase: "mcp-connect",
				toolName: input.toolName,
				configId,
			});
			// Use cached MCP client (5-minute TTL, avoids reconnecting per call)
			// Pass redirectUri to enable OAuth2 authProvider with automatic token refresh
			const {
				client,
				serverName: resolvedServerName,
				fromCache,
			} = await getCachedMcpClientForConfig({
				configId,
				userId: input.userId,
				organizationId: input.organizationId,
				redirectUri, // Enable OAuth2 token refresh
			});

			if (!fromCache) {
				console.log(
					`[MCP Client] Created new connection to ${resolvedServerName}`,
				);
			}

			// Use cached tool list (5-minute TTL, avoids re-fetching per call)
			const tools = await getCachedToolList(
				configId,
				input.userId,
				input.organizationId,
				client,
			);
			const toolDef = tools[input.toolName];

			if (!toolDef) {
				// Tool not found on this server
				return null;
			}

			// Extract MCP App resource URI from tool definition (_meta.ui.resourceUri)
			// This is set by MCP App servers (e.g. Excalidraw) to indicate the tool
			// has an interactive HTML UI that should be rendered inline.
			const mcpAppResourceUri = (
				toolDef as {
					_meta?: { ui?: { resourceUri?: string } };
				}
			)._meta?.ui?.resourceUri;

			// Tool found - execute it
			const rawArgs =
				input.args && typeof input.args === "object" ? input.args : {};
			// Fix LLM-generated string args that should be arrays/objects.
			// LLMs sometimes stringify complex nested params (e.g. ADO fields: "[{...}]")
			const safeArgs = deserializeStringifiedArgs(rawArgs);

			// Coerce primitive types (string→boolean, string→number, etc.) using the
			// tool's JSON Schema. LLMs frequently output "true" / "100" as strings.
			// This is critical for HTTP/SSE MCP servers where the AI SDK doesn't coerce.
			const toolSchema = extractToolJsonSchema(toolDef);
			let coercedArgs = toolSchema
				? coerceArgsToSchema(safeArgs, toolSchema)
				: safeArgs;

			// For Excalidraw's create_view tool: LLMs generate minimal element objects
			// but the server requires ~20 required fields per element. Normalize them.
			if (input.toolName === "create_view") {
				if (!coercedArgs.elements) {
					// Return a helpful error before hitting the MCP server so the LLM
					// can retry immediately with the correct args instead of getting a
					// cryptic "expected string, received undefined" validation message.
					return {
						output: {
							content: [
								{
									type: "text",
									text: `Error: create_view requires an 'elements' array. Example: [{type:"cameraUpdate",width:800,height:600,x:0,y:0},{type:"rectangle",id:"r1",x:100,y:100,width:200,height:100,label:{text:"Box",fontSize:16}}]. Please call create_view again with a complete elements array.`,
								},
							],
							isError: true,
						},
						durationMs: 0,
						success: false,
						cached: false,
					};
				}
				coercedArgs = normalizeExcalidrawCreateViewArgs(coercedArgs);
			}

			console.log(
				`[Orchestrator] Found tool "${input.toolName}" on ${serverName || resolvedServerName}, executing`,
			);
			safeHeartbeat({
				phase: "mcp-execute",
				toolName: input.toolName,
				serverName: serverName || resolvedServerName,
			});

			const tool = toolDef as unknown as {
				execute: (
					args: Record<string, unknown>,
					context: {
						toolCallId: string;
						messages: unknown[];
						abortSignal?: AbortSignal;
					},
				) => Promise<unknown>;
			};

			const output = await tool.execute(coercedArgs, {
				toolCallId: `${input.toolName}-${Date.now()}`,
				messages: [],
				abortSignal: signal,
			});
			// Note: Don't close the client - it's cached for reuse

			const durationMs = Date.now() - startTime;

			// MCP tools return { content: [...], isError: true } on failure - they don't throw
			// We must check isError so callers (e.g. story sync) get correct success/failure
			const mcpOutput = output as {
				content?: Array<{ type?: string; text?: string }>;
				isError?: boolean;
			} | null;
			const isMcpError =
				mcpOutput &&
				typeof mcpOutput === "object" &&
				mcpOutput.isError === true;
			if (isMcpError) {
				const errText =
					mcpOutput?.content?.find((c) => c.type === "text")?.text ??
					"MCP tool returned error";
				console.error(
					`[Orchestrator] MCP tool "${input.toolName}" returned isError:`,
					errText,
				);
			}

			// =======================================================
			// LETTA CACHE STORE: Save successful result for future use
			// =======================================================
			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: output,
						durationMs,
						success: !isMcpError,
					});
					console.log(
						`[Letta Cache] Stored successful result for ${input.toolName}`,
					);
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache result",
						cacheError,
					);
					// Non-critical - continue execution
				}
			}

			return {
				output,
				durationMs,
				success: !isMcpError,
				cached: false,
				// MCP App support: pass through resource URI and config ID for iframe rendering
				mcpAppResourceUri,
				mcpAppConfigId: mcpAppResourceUri ? configId : undefined,
			};
		} catch (execError) {
			// Handle OAuth authorization required errors specially
			// Return authRequired result so workflow can pause and signal UI
			if (execError instanceof OAuthAuthorizationRequiredError) {
				console.warn(
					`[Orchestrator] OAuth authorization required for "${serverName || "MCP server"}": ${execError.message}`,
				);
				return {
					output: {
						error: `OAuth authorization required for "${execError.serverName}". Please connect in Settings.`,
					},
					durationMs: Date.now() - startTime,
					success: false,
					authRequired: true,
					authRequiredConfigId: execError.configId,
					authRequiredServerName: execError.serverName,
				};
			}

			const errorMessage =
				execError instanceof Error
					? execError.message
					: String(execError);

			// Detect "closed client" errors (stale cached connection).
			// Invalidate the cache and retry once with a fresh connection.
			// Skip if already a retry to prevent infinite recursion.
			const isClosedClientError =
				(!isRetry &&
					errorMessage.toLowerCase().includes("closed client")) ||
				errorMessage.toLowerCase().includes("client is closed") ||
				errorMessage.toLowerCase().includes("connection closed") ||
				errorMessage.toLowerCase().includes("transport closed");
			if (isClosedClientError) {
				console.warn(
					`[Orchestrator] Detected stale MCP connection for "${input.toolName}", reconnecting...`,
				);
				try {
					await invalidateMcpClientCache(
						configId,
						input.userId,
						input.organizationId,
					);
					// Retry the entire executeOnConfig with a fresh client
					// Pass a flag so we don't recurse infinitely
					return await executeOnConfig(configId, serverName, true);
				} catch (retryError) {
					const retryMsg =
						retryError instanceof Error
							? retryError.message
							: String(retryError);
					console.error(
						`[Orchestrator] Retry after reconnect also failed for "${input.toolName}":`,
						retryMsg,
					);
					return {
						output: { error: retryMsg },
						durationMs: Date.now() - startTime,
						success: false,
						cached: false,
					};
				}
			}
			// WARN, not ERROR: this failure is returned to the caller as
			// `{ success: false }` rather than swallowed, so the caller decides
			// whether it is noteworthy. Logging at ERROR here as well meant every
			// benign outcome — a card deleted upstream, most of all — was
			// reported twice at the highest severity by two layers, neither of
			// which knew whether it mattered.
			console.warn(
				`[Orchestrator] Tool "${input.toolName}" execution failed:`,
				errorMessage,
			);

			// Cache failed result to avoid retries (but not for OAuth errors)
			if (input.lettaAgentId) {
				try {
					await cacheToolResult({
						lettaAgentId: input.lettaAgentId,
						userId: input.userId,
						toolName: input.toolName,
						toolArgs: input.args,
						result: { error: errorMessage },
						durationMs: Date.now() - startTime,
						success: false,
					});
					console.log(
						`[Letta Cache] Stored failed result for ${input.toolName}`,
					);
				} catch (cacheError) {
					console.warn(
						"[Letta Cache] Failed to cache error result",
						cacheError,
					);
				}
			}

			// IMPORTANT: Return error as result instead of throwing
			// This allows the LLM to see the error and correct its tool call
			// instead of Temporal retrying the same failing request
			return {
				output: { error: errorMessage },
				durationMs: Date.now() - startTime,
				success: false,
				cached: false,
			};
		}
	};

	// ==========================================================================
	// OPTIMIZED PATH: If mcpConfigId is provided, skip config lookup
	// Strict scoping: only execute on the specified config. Callers that pass
	// an explicit mcpConfigId (e.g., PM/story-sync flows) rely on targeted
	// execution — falling back to other configs could mutate data on the wrong
	// server if two configs expose a same-named tool.
	// ==========================================================================
	if (input.mcpConfigId) {
		const result = await executeOnConfig(input.mcpConfigId);
		if (result) {
			return result;
		}
		// Return error as result instead of throwing - let LLM know tool wasn't found
		return {
			output: {
				error: `Tool not found: ${input.toolName} (on specified MCP config)`,
			},
			durationMs: Date.now() - startTime,
			success: false,
			cached: false,
		};
	}

	// ==========================================================================
	// FALLBACK: Search across all configured MCP servers
	// SECURITY: Use strict tenant isolation - either org context OR personal context, never both
	// Per-user-within-org pattern: configs have both userId AND organizationId set
	// Always filter by userId to prevent credential leakage between org members
	// ==========================================================================
	const mcpConfigs = await db.mCPConfig.findMany({
		where: input.organizationId
			? {
					// Organization context: current user's configs within this org
					userId: input.userId,
					organizationId: input.organizationId,
					enabled: true,
				}
			: {
					// Personal context: only user-owned configs (not org-owned)
					userId: input.userId,
					organizationId: null,
					enabled: true,
				},
		select: { id: true, displayName: true },
	});

	for (const config of mcpConfigs) {
		const result = await executeOnConfig(
			config.id,
			config.displayName ?? undefined,
		);
		if (result) {
			return result;
		}
		// Tool not found on this config, try next
	}

	// Return error as result instead of throwing - let LLM know tool wasn't found
	return {
		output: { error: `Tool not found: ${input.toolName}` },
		durationMs: Date.now() - startTime,
		success: false,
		cached: false,
	};
}
