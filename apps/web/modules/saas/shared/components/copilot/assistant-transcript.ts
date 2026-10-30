import { isHumanMessage } from "@repo/agent-core/reasoning-trace/extract";
import { isToolResultError } from "@repo/agent-core/tool-result";
import type { ToolCallEntry } from "./ReasoningCollapsible";

/**
 * MCP-app result envelope written by /api/mcp-app/invoke.
 * Reply rows use it for the insert button; CopilotKit's tool render owns the frame.
 */
const FABRIC_MCP_RENDER_KEY = "__fabricMcpRender";

export interface FabricMcpRenderEnvelope {
	resourceUri: string;
	configId: string;
	checkpointId?: string | null;
	toolArgs?: Record<string, unknown>;
}

const SAVED_TOOL_TRACE_KEY = "fabricAssistantToolTrace";
const MAX_SAVED_TOOLS = 100;

type SavedTrace = {
	reasoning: { text: string; durationMs?: number } | null;
	toolCalls: ToolCallEntry[] | null;
};

type TranscriptMessage = {
	metadata?: Record<string, unknown>;
	reasoningText?: string;
	reasoningDurationMs?: number;
	id?: string;
	role?: string;
	type?: string;
	toolCallId?: string;
	actionExecutionId?: string;
	tool_call_id?: string;
	streamStatus?: "completed" | "cancelled" | "error";
	toolCalls?: Array<{ id: string; status?: unknown; result?: unknown }>;
	status?: unknown;
	error?: unknown;
	additional_kwargs?: Record<string, unknown>;
	content?: unknown;
	result?: unknown;
};
type ParsedResult = {
	content: unknown;
	result: unknown;
	envelope: FabricMcpRenderEnvelope | null;
	status: "success" | "error";
	failed: boolean;
	accepted?: boolean;
};
const parsedResults = new WeakMap<object, ParsedResult>();
// AG-UI publishes cloned snapshots. Weak values share parses across clones
// without retaining scene payloads after their message/index owners disappear.
const payloadResults = new Map<string, WeakRef<ParsedResult>>();
const payloadCleanup = new FinalizationRegistry<{
	key: string;
	ref: WeakRef<ParsedResult>;
}>(({ key, ref }) => {
	if (payloadResults.get(key) === ref) {
		payloadResults.delete(key);
	}
});

function parseResult(message: TranscriptMessage): ParsedResult {
	const failed = isToolResultError({
		...message,
		role: "tool",
		status: message.error === "error" ? "error" : message.status,
	});
	const cached = parsedResults.get(message);
	if (
		cached &&
		cached.content === message.content &&
		cached.result === message.result &&
		cached.failed === failed
	) {
		return cached;
	}
	const key =
		typeof message.content === "string"
			? message.content
			: typeof message.result === "string"
				? message.result
				: null;
	const shared = key === null ? undefined : payloadResults.get(key)?.deref();
	if (
		shared &&
		shared.content === message.content &&
		shared.result === message.result &&
		shared.failed === failed
	) {
		parsedResults.set(message, shared);
		return shared;
	}
	const parse = (value: unknown) => {
		try {
			return typeof value === "string" ? JSON.parse(value) : value;
		} catch {
			return null;
		}
	};
	const content = parse(message.content);
	const result =
		message.result === message.content ? content : parse(message.result);
	let envelope: FabricMcpRenderEnvelope | null = null;
	for (const value of [result, content]) {
		const env =
			value && typeof value === "object"
				? (value as Record<string, unknown>)[FABRIC_MCP_RENDER_KEY]
				: null;
		if (
			env &&
			typeof env === "object" &&
			typeof (env as FabricMcpRenderEnvelope).resourceUri === "string" &&
			typeof (env as FabricMcpRenderEnvelope).configId === "string"
		) {
			envelope = env as FabricMcpRenderEnvelope;
			break;
		}
	}
	const decision = result ?? content;
	const accepted =
		decision &&
		typeof decision === "object" &&
		typeof (decision as { accepted?: unknown }).accepted === "boolean"
			? (decision as { accepted: boolean }).accepted
			: undefined;
	const parsed: ParsedResult = {
		accepted,
		content: message.content,
		result: message.result,
		envelope,
		failed,
		status: failed ? "error" : "success",
	};
	parsedResults.set(message, parsed);
	if (key !== null) {
		const ref = new WeakRef(parsed);
		payloadResults.set(key, ref);
		payloadCleanup.register(parsed, { key, ref });
	}
	return parsed;
}

/** Original trace id carried by the agent's confirmation call. */
export function inlineConfirmationTraceId(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const call = value as {
		args?: unknown;
		arguments?: unknown;
		function?: { arguments?: unknown };
	};
	let args = call.args ?? call.arguments ?? call.function?.arguments;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			return null;
		}
	}
	const marker = (args as { __inlineTool?: { id?: unknown } } | null)
		?.__inlineTool;
	return typeof marker?.id === "string" ? marker.id : null;
}

interface Turn {
	saved: SavedTrace;
	firstAssistant?: string;
	latest: boolean;
	results: Record<string, "success" | "error">;
}
interface IndexedRow {
	turn: Turn;
	envelope: FabricMcpRenderEnvelope | null;
	user: TranscriptMessage | null;
}
const EMPTY_EXCLUDED: ReadonlySet<string> = new Set();
const transcriptIndexes = new WeakMap<
	unknown[],
	WeakMap<
		ReadonlySet<string>,
		{
			rows: Map<string | undefined, IndexedRow>;
			pending: IndexedRow;
		}
	>
>();

function transcriptIndex(transcript: unknown[], excluded = EMPTY_EXCLUDED) {
	let indexes = transcriptIndexes.get(transcript);
	if (!indexes) {
		indexes = new WeakMap();
		transcriptIndexes.set(transcript, indexes);
	}
	const cached = indexes.get(excluded);
	if (cached) {
		return cached;
	}
	const rows = new Map<string | undefined, IndexedRow>();
	const parsedOwners: ParsedResult[] = [];
	const outcomes: Record<string, "success" | "error"> = Object.create(null);
	const turns = new Set<Turn>();
	const preparationIds = new Map<string, string>();
	const resultOutcomes = new Map<string, ParsedResult>();
	const savedOutcomes = new Map<string, "success" | "error">();
	let turn: Turn = {
		latest: true,
		results: {},
		saved: EMPTY_SAVED_TRACE,
	};
	let envelope: FabricMcpRenderEnvelope | null = null;
	let user: TranscriptMessage | null = null;
	for (const raw of transcript) {
		const message = raw as TranscriptMessage;
		if (message.role === "user" && !excluded.has(message.id ?? "")) {
			turn.latest = false;
			turn = {
				latest: true,
				results: {},
				saved: EMPTY_SAVED_TRACE,
			};
			envelope = null;
		}
		turns.add(turn);
		// Match findIndex's first-id semantics.
		if (!rows.has(message.id)) {
			rows.set(message.id, {
				turn,
				envelope,
				user,
			});
		}
		if (message.role === "user" && !excluded.has(message.id ?? "")) {
			user = message;
		}
		if (message.role === "assistant" && !excluded.has(message.id ?? "")) {
			const saved = savedTraceForMessage(message);
			turn.saved = mergeSavedTrace(turn.saved, saved);
			for (const entry of saved.toolCalls ?? []) {
				if (entry.status === "success" || entry.status === "error") {
					outcomes[entry.id] = entry.status;
					savedOutcomes.set(entry.id, entry.status);
				}
			}
			for (const call of message.toolCalls ?? []) {
				const inlineId = inlineConfirmationTraceId(call);
				if (inlineId) {
					preparationIds.set(inlineId, call.id);
				}
				if (
					call.status === "success" ||
					call.status === "error" ||
					call.result !== undefined
				) {
					const parsed = parseResult({
						role: "tool",
						content: call.result,
						status: call.status,
					});
					outcomes[call.id] = parsed.status;
					resultOutcomes.set(call.id, parsed);
				}
			}
		}
		if (
			message.role === "assistant" &&
			!excluded.has(message.id ?? "") &&
			turn.firstAssistant === undefined
		) {
			turn.firstAssistant = message.id;
		}
		if (isResultMessage(message)) {
			const parsed = parseResult(message);
			parsedOwners.push(parsed);
			envelope = parsed.envelope ?? envelope;
			const id =
				message.toolCallId ??
				message.actionExecutionId ??
				message.tool_call_id;
			if (id) {
				outcomes[id] = parsed.status;
				resultOutcomes.set(id, parsed);
			}
		}
	}
	// buildConfirmChangesCommand emits a preparation result before the verdict.
	// Its __inlineTool marker keeps that result from resolving the review trace.
	for (const [id, confirmationId] of preparationIds) {
		const verdict = savedOutcomes.get(id);
		const result = resultOutcomes.get(confirmationId);
		if (verdict) {
			outcomes[id] = verdict;
		} else if (typeof result?.accepted === "boolean") {
			outcomes[id] = result.accepted ? "success" : "error";
		} else if (result?.status === "error") {
			outcomes[id] = "error";
		} else {
			delete outcomes[id];
		}
	}
	for (const item of turns) {
		item.results = outcomes;
		item.saved = resolveSavedOutcomes(item.saved, outcomes);
	}
	const index = {
		rows,
		parsedOwners,
		pending: { turn, envelope, user },
	};
	indexes.set(excluded, index);
	return index;
}

export function findTranscriptPrompt(
	message: { id?: string } | undefined,
	transcript: unknown[],
	excluded = EMPTY_EXCLUDED,
) {
	const index = transcriptIndex(transcript, excluded);
	return (index.rows.get(message?.id) ?? index.pending).user;
}

function isResultMessage(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") {
		return false;
	}
	const m = msg as Record<string, unknown>;
	return (
		m.role === "tool" ||
		m.type === "ResultMessage" ||
		(m as { isResultMessage?: () => boolean }).isResultMessage?.() === true
	);
}

/**
 * CopilotKit passes the full transcript to assistant rows. Use the latest
 * tool result before this assistant message, stopping at the preceding user
 * message, so the insert button is paired with the turn that produced it.
 */
export function findInlineMcpEnvelope(
	message: { id?: string } | undefined,
	transcript: unknown[],
	excluded = EMPTY_EXCLUDED,
): FabricMcpRenderEnvelope | null {
	if (!message) {
		return null;
	}
	const index = transcriptIndex(transcript, excluded);
	return (index.rows.get(message.id) ?? index.pending).envelope;
}

// Share exclusion scans across rows for each LangChain state snapshot.
const excludedIndexes = new WeakMap<unknown[], ReadonlySet<string>>();
export function selectExcludedTurnIds(state: { messages?: unknown[] }) {
	const messages = state.messages;
	if (!messages) {
		return EMPTY_EXCLUDED;
	}
	const cached = excludedIndexes.get(messages);
	if (cached) {
		return cached;
	}
	const excluded = new Set<string>();
	for (const raw of messages) {
		const message = raw as TranscriptMessage & { _getType?: () => string };
		if (
			message.id &&
			!isHumanMessage(message) &&
			(message.type === "human" ||
				message.role === "user" ||
				message._getType?.() === "human")
		) {
			excluded.add(message.id);
		}
	}
	const result = excluded.size ? excluded : EMPTY_EXCLUDED;
	excludedIndexes.set(messages, result);
	return result;
}

// Turn lookups do not inspect streamed content or parse tool results.
const EMPTY_STATE_MESSAGES: unknown[] = [];
type TurnIndex = {
	stateLength: number;
	messagesLength: number;
	turns: Map<string, number | null>;
};
const turnIndexes = new WeakMap<
	unknown[],
	WeakMap<unknown[], WeakMap<ReadonlySet<string>, TurnIndex>>
>();
export function selectAgentTurn(
	messages: unknown[],
	id: string | undefined,
	excluded = EMPTY_EXCLUDED,
	stateMessages = EMPTY_STATE_MESSAGES,
) {
	let stateIndexes = turnIndexes.get(stateMessages);
	if (!stateIndexes) {
		stateIndexes = new WeakMap();
		turnIndexes.set(stateMessages, stateIndexes);
	}
	let indexes = stateIndexes.get(messages);
	if (!indexes) {
		indexes = new WeakMap();
		stateIndexes.set(messages, indexes);
	}
	let index = indexes.get(excluded);
	// addMessage can push a user into the existing AG-UI array.
	if (
		!index ||
		index.stateLength !== stateMessages.length ||
		index.messagesLength !== messages.length
	) {
		const turns = new Map<string, number | null>();
		let count = 0;
		for (const raw of stateMessages) {
			const message = raw as TranscriptMessage;
			if (isHumanMessage(message)) {
				count++;
			}
			if (message.id && !turns.has(message.id)) {
				turns.set(message.id, count || null);
			}
		}
		// State supplies known rows and the base count; AG-UI adds only its unseen tail.
		let shared = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (turns.has((messages[i] as TranscriptMessage).id ?? "")) {
				shared = i;
				break;
			}
		}
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i] as TranscriptMessage;
			if (
				i > shared &&
				message.role === "user" &&
				!excluded.has(message.id ?? "")
			) {
				count++;
			}
			if (message.id && !turns.has(message.id)) {
				// Unshared rows before the anchor are display history, not the live tail.
				turns.set(message.id, i > shared ? count || null : null);
			}
		}
		index = {
			stateLength: stateMessages.length,
			messagesLength: messages.length,
			turns,
		};
		indexes.set(excluded, index);
	}
	return id ? (index.turns.get(id) ?? null) : null;
}
export function equalExcludedTurnIds(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
) {
	return a === b || (a.size === b.size && [...a].every((id) => b.has(id)));
}

/** Stable trace owner and result statuses within this display turn. */
export function selectTranscriptTrace(
	message: { id?: string } | undefined,
	transcript: unknown[],
	excluded = EMPTY_EXCLUDED,
) {
	const index = transcriptIndex(transcript, excluded);
	const row = index.rows.get(message?.id);
	const turn = (row ?? index.pending).turn;
	const ownsTrace = row
		? turn.firstAssistant === message?.id
		: turn.firstAssistant === undefined;
	return {
		ownsTrace,
		saved: ownsTrace ? turn.saved : EMPTY_SAVED_TRACE,
		latest: turn.latest,
		results: ownsTrace ? turn.results : EMPTY_RESULTS,
	};
}
const EMPTY_RESULTS: Record<string, "success" | "error"> = {};

const EMPTY_SAVED_TRACE: SavedTrace = { reasoning: null, toolCalls: null };

function isSavedTool(value: unknown): value is ToolCallEntry {
	if (!value || typeof value !== "object") {
		return false;
	}
	const entry = value as ToolCallEntry;
	return (
		typeof entry.id === "string" &&
		typeof entry.name === "string" &&
		["pending", "waiting", "stopped", "success", "error"].includes(
			entry.status,
		)
	);
}

function boundedTool(entry: ToolCallEntry): ToolCallEntry {
	return {
		id: entry.id.slice(0, 256),
		name: entry.name.slice(0, 256),
		status: entry.status,
		...(typeof entry.startedAt === "number"
			? { startedAt: entry.startedAt }
			: {}),
		...(typeof entry.durationMs === "number"
			? { durationMs: entry.durationMs }
			: {}),
		...(typeof entry.errorMessage === "string"
			? { errorMessage: entry.errorMessage.slice(0, 240) }
			: {}),
	};
}

/** Capture only trace fields; reasoning uses the server's opt-in fields. */
export function captureAssistantTrace(
	messageId: string,
	messages: unknown[],
	state: {
		messages?: unknown[];
		reasoningByTurn?: Record<number, { text: string; durationMs?: number }>;
		toolCallsByTurn?: Record<number, ToolCallEntry[]>;
	},
	streamStatus: "completed" | "cancelled" | "error" = "completed",
) {
	const excluded = selectExcludedTurnIds(state);
	const turn = selectAgentTurn(messages, messageId, excluded, state.messages);
	if (turn === null) {
		return {};
	}
	const reasoning = state.reasoningByTurn?.[turn];
	const tools = state.toolCallsByTurn?.[turn];
	const index = transcriptIndex(messages, excluded);
	const results = (index.rows.get(messageId) ?? index.pending).turn.results;
	return {
		...(tools?.length
			? {
					metadata: {
						[SAVED_TOOL_TRACE_KEY]: tools
							.slice(0, MAX_SAVED_TOOLS)
							.filter(isSavedTool)
							.map((entry) =>
								boundedTool({
									...entry,
									status:
										results[entry.id] ??
										savedStatus(entry.status, streamStatus),
								}),
							),
					},
				}
			: {}),
		...(reasoning?.text
			? {
					reasoningText: reasoning.text,
					reasoningDurationMs: reasoning.durationMs,
				}
			: {}),
	};
}

function savedStatus(
	status: ToolCallEntry["status"],
	end?: TranscriptMessage["streamStatus"],
): ToolCallEntry["status"] {
	if (status !== "pending") {
		return status;
	}
	return end === "cancelled" || end === "error" ? "stopped" : "waiting";
}

const resolvedTraces = new WeakMap<SavedTrace, Map<string, SavedTrace>>();
function resolveSavedOutcomes(
	saved: SavedTrace,
	outcomes: Record<string, "success" | "error">,
): SavedTrace {
	const changes = saved.toolCalls?.filter(
		(entry) => outcomes[entry.id] && outcomes[entry.id] !== entry.status,
	);
	if (!changes?.length) {
		return saved;
	}
	const key = JSON.stringify(
		changes.map((entry) => [entry.id, outcomes[entry.id]]),
	);
	let cache = resolvedTraces.get(saved);
	if (!cache) {
		cache = new Map();
		resolvedTraces.set(saved, cache);
	}
	let resolved = cache.get(key);
	if (!resolved) {
		resolved = {
			...saved,
			toolCalls:
				saved.toolCalls?.map((entry) =>
					outcomes[entry.id]
						? {
								...entry,
								status: outcomes[entry.id],
								errorMessage: undefined,
							}
						: entry,
				) ?? null,
		};
		cache.set(key, resolved);
	}
	return resolved;
}

// Historical message objects survive live token updates in CustomMessages.
const savedTraces = new WeakMap<object, SavedTrace>();
function savedTraceForMessage(message: TranscriptMessage): SavedTrace {
	const cached = savedTraces.get(message);
	if (cached) {
		return cached;
	}
	const tools = message.metadata?.[SAVED_TOOL_TRACE_KEY];
	const saved: SavedTrace = {
		toolCalls: Array.isArray(tools)
			? tools
					.slice(0, MAX_SAVED_TOOLS)
					.filter(isSavedTool)
					.map((entry) =>
						boundedTool({
							...entry,
							status: savedStatus(
								entry.status,
								message.streamStatus,
							),
						}),
					)
			: null,
		reasoning:
			typeof message.reasoningText === "string"
				? {
						text: message.reasoningText,
						durationMs: message.reasoningDurationMs,
					}
				: null,
	};
	savedTraces.set(message, saved);
	return saved;
}

// Reuse merged traces when a live token update retains the saved message objects.
const savedTraceMerges = new WeakMap<
	SavedTrace,
	WeakMap<SavedTrace, SavedTrace>
>();
function mergeSavedTrace(previous: SavedTrace, next: SavedTrace): SavedTrace {
	if (!next.toolCalls?.length && !next.reasoning?.text.trim()) {
		return previous;
	}
	let merges = savedTraceMerges.get(previous);
	if (!merges) {
		merges = new WeakMap();
		savedTraceMerges.set(previous, merges);
	}
	const cached = merges.get(next);
	if (cached) {
		return cached;
	}
	let toolCalls = previous.toolCalls;
	if (next.toolCalls?.length) {
		const entries = new Map(
			(toolCalls ?? []).map((entry) => [entry.id, entry]),
		);
		for (const entry of next.toolCalls) {
			if (entries.has(entry.id) || entries.size < MAX_SAVED_TOOLS) {
				const previous = entries.get(entry.id);
				entries.set(
					entry.id,
					previous &&
						(previous.status === "success" ||
							previous.status === "error") &&
						entry.status !== "success" &&
						entry.status !== "error"
						? previous
						: entry,
				);
			}
		}
		toolCalls = [...entries.values()];
	}
	const merged: SavedTrace = {
		toolCalls,
		reasoning: next.reasoning?.text.trim()
			? next.reasoning
			: previous.reasoning,
	};
	merges.set(next, merged);
	return merged;
}
