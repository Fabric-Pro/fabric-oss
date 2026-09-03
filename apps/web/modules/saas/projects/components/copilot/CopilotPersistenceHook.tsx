"use client";

/**
 * `CopilotPersistenceHook` — Group H (FR-2, AC-5/AC-6/AC-7).
 *
 * Stream-completion-only persistence for the document AI Assistant. Mounted
 * as a sibling of `<CopilotSidebar>` inside the same `<CopilotKit>` provider
 * so it can subscribe to the live messages array (`useCopilotChatInternal`)
 * the sidebar itself renders from.
 *
 * # FR-2: persistence runs on stream COMPLETION ONLY. Never on streaming deltas.
 * # Doing so would cause write amplification (~600 row updates per 30s generation).
 *
 * ## H.1 spike outcome — which hook(s) fire on terminal state?
 *
 * CopilotKit 1.52.0 does NOT expose a single `onMessageFinish` /
 * `onMessageReceived` callback on either `<CopilotKit>` or `<CopilotSidebar>`
 * that fires once per terminal turn (see the destructure list of
 * `useCopilotChatInternal` in `@copilotkit/react-core/dist/index.d.mts`
 * line ~954). We therefore subscribe to BOTH `messages` and `isLoading`
 * via `useCopilotChatSession()` and detect terminal turns by diffing the
 * messages array on every meaningful change. A message is "ready to persist"
 * the FIRST time it is observed with `status.code !== "Pending"`.
 * Cancellation (no clean event in v1.52) is inferred when `isLoading`
 * flips true → false while the most-recent assistant message is still
 * `Pending` — we then promote it to `streamStatus: "cancelled"` and
 * persist.
 *
 * ## Effect-dependency design
 *
 * CopilotKit re-allocates the messages array on every meaningful change
 * (CopilotMessages provider uses `useState([])` + `setMessages`), so a
 * `useEffect([messages])` dep would in principle suffice. We still derive
 * a **content fingerprint** (`length + last-id + last-status`) and key the
 * effect off it because (a) it makes the dependency explicit and
 * readable, (b) it survives any future CopilotKit upgrade that mutates
 * the array in place, and (c) it lets us safely depend on `isLoading`
 * inside the same effect without doubling the walk frequency.
 *
 * ## Serialised persist queue (concurrency)
 *
 * When a user sends a message, BOTH the user turn and the assistant turn
 * settle as terminal in quick succession. With a naive parallel-`Promise`
 * approach, both `persist()` calls would launch concurrently with
 * `conversationIdRef.current === null` → the server lazy-creates TWO
 * conversations, each containing one of the messages. To prevent that,
 * persist calls are pushed into an in-memory queue and drained by a single
 * worker. The worker waits for each `appendTurn` to settle before pulling
 * the next item, so the second call always sees the conversation id
 * resolved by the first.
 *
 * ## Idempotency layers
 *
 *   - Local: a `Set<string>` ref of message ids already enqueued for
 *     persistence. Prevents double-enqueue from React Strict Mode, parent
 *     re-renders, or fingerprint ticks.
 *   - Server: `appendTurnForDocument` is idempotent on `message.id` (returns
 *     the existing row without appending — see Group B implementation).
 *
 * ## Failure modes
 *
 *   - `CONFLICT "Document assistant history is disabled for this organization"`:
 *     swallow silently — the feature flag is OFF and we don't want toast
 *     noise on every turn.
 *   - `CONFLICT "You've started 50 conversations on this document today..."`:
 *     surface the server's friendly copy via `toast.error` (FR-11).
 *   - Any other error: warn-log via `console.warn` and continue. The chat
 *     itself is not blocked — persistence is best-effort.
 */

// CopilotKit 1.52 — `useCopilotChatInternal()` is the only correct read
// hook for the live message store. Short version:
//   - `useCopilotChat()` Omits `messages` from its public return type
//   - `useCopilotMessagesContext()` is a separate, sidebar-unread store
//   - `useCopilotChatHeadless_c()` is premium-licensed and returns empty
//     state without a public API key
// `useCopilotChatInternal` is exported and used by `<CopilotSidebar>`
// itself for rendering, so subscribing here observes the exact same
// stream the user sees on screen.
//
// Since CopilotKit 1.70 that hook also OPENS an `agent/connect` per call
// site (Fizzy #2389), so this component no longer calls it directly — it
// reads the surface's single instance through
// `<CopilotChatSessionProvider>`, which publishes the identical value.
// NOTE: Client component — must not import @repo/logs (it pulls in node:fs
// via pino transports and breaks the browser bundle). Use console for the
// rare best-effort log line; this matches how the rest of the saas client
// modules log.
import {
	type AppendTurnMessage,
	useAppendDocumentAssistantTurn,
} from "@saas/projects/hooks/useDocumentAssistantHistory";
import { useAttachmentRegistry } from "@saas/shared/components/copilot/AttachmentRegistry";
import { useCopilotChatSession } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

const HISTORY_DISABLED_ERROR_FRAGMENT = "history is disabled";
const DAILY_CAP_ERROR_FRAGMENT = "started 50 conversations";

/**
 * Persistable attachment shape. Matches `MessageAttachmentSchema` on the
 * server (`packages/api/.../update-conversation.ts`).
 */
export interface PendingAttachment {
	id: string;
	s3Path: string;
	name: string;
	mimeType: string;
	sizeBytes?: number;
	kind: "image" | "file";
}

interface CopilotPersistenceHookProps {
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	documentRefId: string;
	projectId: string;
	organizationId: string | null;
	/**
	 * FIFO queue of per-message attachment batches captured by
	 * `CopilotSidebarInput`'s `onAttachmentsForNextMessage` callback.
	 *
	 * Each `onAttachmentsForNextMessage` invocation `push()`es one batch
	 * before the typed text reaches CopilotKit's `onSend`. When we
	 * observe a user-role message reach terminal state, we `shift()`
	 * the oldest batch and attach it to the persisted message. Surfaces
	 * that don't need attachment persistence (e.g. standalone Fabric AI)
	 * simply omit the prop and the hook treats every user message as
	 * having zero attachments.
	 *
	 * The queue is keyed positionally (not by message id) because
	 * CopilotKit assigns message ids only once the message lands in its
	 * runtime — i.e., AFTER the input factory has fired the callback.
	 * Position ordering matches send ordering matches persistence
	 * ordering, so this is safe under normal use. The only failure mode
	 * is two near-simultaneous sends with attachments where the
	 * persistence walker observes them out of order, which CopilotKit
	 * doesn't currently permit (the textarea disables during stream).
	 */
	pendingAttachmentsRef?: React.RefObject<PendingAttachment[][]>;
	/**
	 * The currently-active document-assistant conversation id, or `null`
	 * when the user has not yet sent a turn (the procedure lazy-creates on
	 * first call). The parent owns this state — Group D wires the initial
	 * SSR seed and Group E's "New conversation" affordance resets it to
	 * `null`.
	 */
	conversationId: string | null;
	/**
	 * Called when the procedure lazy-creates a conversation (response's
	 * `conversationId` is unknown to the client). The parent stores the id
	 * so subsequent turns target the same row.
	 */
	onConversationIdResolved: (id: string) => void;
	/**
	 * Called when the per-conversation 200-turn cap (FR-3) triggers a
	 * spill. The parent should update its local `conversationId` to the
	 * continuation id so subsequent appends target the new row.
	 */
	onSpilled: (newConversationId: string) => void;
	/** SHARED is the default; PRIVATE is set when the author opted out
	 * pre-first-send via the sidebar header chip (Group E). Only honored
	 * on the lazy-create path. */
	requestedVisibility: "SHARED" | "PRIVATE";
	/** Which LangGraph agent is generating responses (e.g.
	 * `"project_document_generator"`). Persisted so the History drawer
	 * can attribute and filter later. Required so we never silently
	 * persist `agentId: "unknown"` — the parent has the agent name in
	 * its `useCoAgent` config and passes it down. */
	agentId: string;
	/**
	 * Message ids that came from the SSR-loaded conversation
	 * (`initialAssistantMessages`). Pre-populated into the local
	 * `persistedIdsRef` so the walker never re-fires `appendTurnForDocument`
	 * for messages that are already in the DB. The server is idempotent
	 * on `message.id` so duplicate writes wouldn't corrupt data, but each
	 * spurious call costs a round-trip and a DB read; skipping them here
	 * keeps every reload from triggering N redundant persists.
	 */
	initialPersistedMessageIds?: ReadonlyArray<string>;
}

/**
 * One of CopilotKit's runtime Message subclasses. We only need the
 * discriminator methods and a couple of read-only fields; the
 * structural type here keeps us decoupled from the runtime class
 * hierarchy (which CopilotKit reshuffled between minors).
 */
interface CopilotKitRuntimeMessage {
	id: string;
	createdAt?: string | Date;
	status?: {
		code?: "Pending" | "Success" | "Failed";
		// `Failed` carries a `reason` per the GraphQL schema; we capture
		// it as `unknown` because the structure shifts across versions
		// and we only persist it for diagnostics.
		reason?: unknown;
	};
	isTextMessage?: () => boolean;
	isActionExecutionMessage?: () => boolean;
	isResultMessage?: () => boolean;
	isAgentStateMessage?: () => boolean;
	isImageMessage?: () => boolean;
	role?: "user" | "assistant" | "system";
	content?: string;
	parentMessageId?: string | null;
	name?: string;
	arguments?: Record<string, unknown>;
	actionExecutionId?: string;
	actionName?: string;
	result?: string;
}

interface ExtractedPayload {
	role: "user" | "assistant" | "system";
	content: string;
	toolCalls: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		result?: string;
		status?: "pending" | "running" | "success" | "error";
	}>;
}

/**
 * Recognises an AGUI-format assistant message whose ONLY purpose is to
 * carry tool calls — no content, no methods, just `{id, role:"assistant",
 * toolCalls:[...]}`. CopilotKit 1.52's free hook tree splits a single
 * assistant turn into two such messages: the text turn ("Changes ready
 * for review.") and a separate tool-call turn. Without this recogniser
 * the persistence walker drops the tool-call turn (its AGUI catch-all
 * required `typeof content === "string"`), so the chip + accept-stamp
 * flow had nothing to bind to on staging.
 *
 * Returns the tool-call entries shaped for `ExtractedPayload.toolCalls`,
 * or `null` if the message is not a tool-call-only turn.
 */
function extractAguiToolCallOnly(
	m: CopilotKitRuntimeMessage,
): ExtractedPayload["toolCalls"] | null {
	if (m.role !== "assistant") {
		return null;
	}
	if (typeof m.isTextMessage === "function") {
		return null;
	}
	if (typeof m.isActionExecutionMessage === "function") {
		return null;
	}
	if (typeof m.content === "string" && m.content.length > 0) {
		return null;
	}
	const raw = (m as { toolCalls?: unknown }).toolCalls;
	if (!Array.isArray(raw) || raw.length === 0) {
		return null;
	}
	const out: ExtractedPayload["toolCalls"] = [];
	for (const tc of raw) {
		if (!tc || typeof tc !== "object") {
			continue;
		}
		const t = tc as {
			id?: unknown;
			name?: unknown;
			args?: unknown;
			arguments?: unknown;
			function?: { name?: unknown; arguments?: unknown } | undefined;
			result?: unknown;
		};
		// AGUI tool-call entries vary slightly in shape across providers
		// (some use `function.name + function.arguments`, others put them
		// at the top level). Normalize defensively so we don't drop a
		// valid call due to surface variation.
		const id = typeof t.id === "string" ? t.id : null;
		const name =
			typeof t.name === "string"
				? t.name
				: typeof t.function?.name === "string"
					? t.function.name
					: null;
		const args =
			t.args && typeof t.args === "object"
				? (t.args as Record<string, unknown>)
				: t.arguments && typeof t.arguments === "object"
					? (t.arguments as Record<string, unknown>)
					: t.function?.arguments &&
							typeof t.function.arguments === "object"
						? (t.function.arguments as Record<string, unknown>)
						: {};
		if (!id || !name) {
			continue;
		}
		const entry: ExtractedPayload["toolCalls"][number] = {
			id,
			name,
			args,
		};
		if (typeof t.result === "string") {
			entry.result = t.result;
		}
		out.push(entry);
	}
	return out.length > 0 ? out : null;
}

/**
 * Map a CopilotKit runtime message into the `MessageSchema` payload the
 * procedure expects. Tool-call results (`ResultMessage`) are merged onto
 * their parent assistant text turn via a follow-up pass in the caller; this
 * function returns the per-message extraction only.
 *
 * Returns `null` when the message has no persistable surface (e.g., an
 * `AgentStateMessage` which carries internal state, not user-visible
 * content).
 */
function extractPayload(m: CopilotKitRuntimeMessage): ExtractedPayload | null {
	// GQL-format path: CopilotKit's TextMessage class exposes
	// `isTextMessage()` and friends as instance methods.
	if (typeof m.isTextMessage === "function" && m.isTextMessage()) {
		// `role` is required on a TextMessage in CopilotKit; default to
		// "assistant" defensively so a malformed runtime payload never
		// throws here.
		const role: "user" | "assistant" | "system" =
			m.role === "user" || m.role === "system" ? m.role : "assistant";
		return {
			role,
			content: m.content ?? "",
			toolCalls: [],
		};
	}
	// AGUI-format path: the live runtime in CopilotKit 1.52's free hook
	// tree returns plain objects like `{ id, role, content }` with no
	// `isTextMessage` method. We detect them by duck-typing: a string
	// `content` field + a `role` of "user"/"assistant"/"system" and the
	// ABSENCE of tool-call fields (`arguments`, `actionExecutionId`).
	// Missing this branch was the second layer of the persistence
	// regression — `isTerminal` correctly identified the message as
	// terminal but `extractPayload` then returned null because no
	// method-check matched, so the walker logged the id in
	// `persistedIdsRef` and silently dropped the turn.
	if (
		typeof m.isTextMessage === "undefined" &&
		typeof m.isActionExecutionMessage === "undefined" &&
		typeof m.content === "string" &&
		(m.role === "user" || m.role === "assistant" || m.role === "system") &&
		m.arguments === undefined &&
		m.actionExecutionId === undefined
	) {
		return {
			role: m.role,
			content: m.content,
			toolCalls: [],
		};
	}
	if (
		typeof m.isActionExecutionMessage === "function" &&
		m.isActionExecutionMessage()
	) {
		// Surface action invocations on a synthetic assistant turn so the
		// History drawer's read-only viewer can render the tool-call chip
		// even when the parent text message arrived first and is already
		// persisted.
		return {
			role: "assistant",
			content: "",
			toolCalls: [
				{
					id: m.id,
					name: m.name ?? "",
					args: m.arguments ?? {},
					status: undefined,
				},
			],
		};
	}
	// ResultMessage / AgentStateMessage / ImageMessage are not persisted
	// here as standalone turns — the diff outcome stamping lives in
	// `recordDiffOutcome` (Group G) and agent state ticks are transient.
	return null;
}

/**
 * Heuristic for whether the message is currently in a streamed but
 * non-terminal state.
 *
 * Two message shapes flow through `useCopilotChatInternal().messages`:
 *
 *   1. **GQL-format** (legacy / paid Headless tier): `{ id, role, content,
 *      status: { code: "Pending" | "Success" | "Failed", … } }`. Terminal
 *      when `code` is "Success" or "Failed".
 *
 *   2. **AGUI-format** (the shape that actually surfaces in CopilotKit
 *      1.52's free hook tree — verified on staging via React-fiber
 *      inspection): `{ id, role, content }` with NO `status` field at all.
 *      We detect terminal state for these via a different signal:
 *
 *      - **User messages** are always terminal — they're not streamed
 *        from the user's POV; sending puts them straight into the array
 *        as finished text.
 *      - **Assistant messages** are terminal once `isLoading` has flipped
 *        false (gated by `generationJustEnded` at the call site — see
 *        the walker loop), because the agent's stream has finished.
 *
 * The function returns `true` for case (1) and case (2)-user. The
 * assistant-completion-on-isLoading-edge case is handled inline at the
 * call site so we don't need to plumb `isLoading` here.
 *
 * The previous version only handled case (1) — `code === "Success" || "Failed"` —
 * which silently no-op'd whenever AGUI-format messages arrived, breaking
 * persistence on staging post-merge of #1091. (Local dev was unaffected
 * because the LLM provider 502'd before any messages could reach the walker.)
 */
function isTerminal(m: CopilotKitRuntimeMessage): boolean {
	const code = m.status?.code;
	if (code === "Success" || code === "Failed") {
		return true;
	}
	// AGUI-format messages have no `status` field. User messages are
	// always terminal (they're not streamed); assistant messages are
	// handled inline against `generationJustEnded` in the walker.
	if (code === undefined && m.role === "user") {
		return true;
	}
	return false;
}

export function CopilotPersistenceHook({
	documentRefKind,
	documentRefId,
	projectId,
	organizationId,
	conversationId,
	onConversationIdResolved,
	onSpilled,
	requestedVisibility,
	agentId,
	pendingAttachmentsRef,
	initialPersistedMessageIds,
}: CopilotPersistenceHookProps) {
	const { messages, isLoading } = useCopilotChatSession();
	const appendTurn = useAppendDocumentAssistantTurn();
	// Read attachments through the registry — `<AttachmentRegistryProvider>`
	// drains the `pendingAttachmentsRef` FIFO when each new user message
	// lands, so by the time the persistence hook builds the
	// `appendTurnForDocument` payload the registry already knows the right
	// batch keyed by message id. We deliberately do NOT pop the FIFO here
	// (the registry already did) — popping twice would consume the queue
	// twice and break the positional alignment.
	const attachmentRegistry = useAttachmentRegistry();

	// Local idempotency: once a message id has been enqueued for
	// persistence we never re-enqueue it. The server is also idempotent
	// on `message.id`, but the local set saves the round-trip on the
	// hot path (every fingerprint tick).
	const persistedIdsRef = useRef<Set<string>>(new Set());

	// Pre-seed `persistedIdsRef` with the SSR-hydrated message ids so the
	// walker never re-fires `appendTurnForDocument` for messages that are
	// already in the DB. We do this synchronously (not in a useEffect) so
	// it lands BEFORE the first walker tick — the messages array reaches
	// the hook populated, and without this guard the walker would attempt
	// to persist every hydrated message on its first observation. The
	// server is idempotent on `message.id`, so duplicates are harmless,
	// but each spurious call costs an oRPC round-trip + DB read.
	//
	// React-safety: we read `initialPersistedMessageIds` only on the
	// first render via a one-shot ref. Re-running this loop on every
	// render would also be a no-op (Set.add is idempotent), but the
	// ref-guarded variant keeps the dev-mode StrictMode double-mount
	// from doubling the work.
	const initialIdsSeededRef = useRef(false);
	if (!initialIdsSeededRef.current && initialPersistedMessageIds) {
		for (const id of initialPersistedMessageIds) {
			if (typeof id === "string" && id.length > 0) {
				persistedIdsRef.current.add(id);
			}
		}
		initialIdsSeededRef.current = true;
	}

	// Track the previous `isLoading` value so we can detect the
	// true → false edge (the moment the user-initiated generation
	// "ended" — either successfully, with an error, or via cancellation).
	const wasLoadingRef = useRef(false);

	// Live mirrors of conversation id + visibility so the queue worker
	// always reads the freshest values without forcing re-subscribes.
	const conversationIdRef = useRef(conversationId);
	useEffect(() => {
		conversationIdRef.current = conversationId;
	}, [conversationId]);
	const requestedVisibilityRef = useRef(requestedVisibility);
	useEffect(() => {
		requestedVisibilityRef.current = requestedVisibility;
	}, [requestedVisibility]);

	// Serialised persistence queue. Multiple terminal messages from a
	// single generation (e.g. user turn + assistant turn) are appended
	// here in observation order and drained by a single worker, so the
	// lazy-create race (each parallel call would create its own
	// conversation) is impossible: subsequent items always see the
	// `conversationIdRef` resolved by the previous append.
	const persistQueueRef = useRef<AppendTurnMessage[]>([]);
	const workerRunningRef = useRef(false);

	// Refs for the latest mutation + callback closures so the worker
	// reads fresh values on every iteration without re-binding the
	// outer effect.
	const appendTurnRef = useRef(appendTurn);
	useEffect(() => {
		appendTurnRef.current = appendTurn;
	}, [appendTurn]);
	const onConversationIdResolvedRef = useRef(onConversationIdResolved);
	useEffect(() => {
		onConversationIdResolvedRef.current = onConversationIdResolved;
	}, [onConversationIdResolved]);
	const onSpilledRef = useRef(onSpilled);
	useEffect(() => {
		onSpilledRef.current = onSpilled;
	}, [onSpilled]);

	// Content fingerprint of the messages array. Captures the structural
	// signal we care about (length + last terminal-status entry) so a
	// React re-render driven by other context updates (presence, query
	// refetches) doesn't re-enter the walk. Recomputed each render —
	// stable for `useEffect` because two renders that produce the same
	// array contents produce the same fingerprint.
	const fingerprint = computeFingerprint(
		messages as unknown as CopilotKitRuntimeMessage[],
	);

	useEffect(() => {
		const runtimeMessages =
			(messages as unknown as CopilotKitRuntimeMessage[]) ?? [];
		const wasLoading = wasLoadingRef.current;
		wasLoadingRef.current = isLoading;
		const generationJustEnded = wasLoading && !isLoading;

		if (runtimeMessages.length === 0) {
			return;
		}

		for (let i = 0; i < runtimeMessages.length; i++) {
			const m = runtimeMessages[i];
			if (!m?.id) {
				continue;
			}
			if (persistedIdsRef.current.has(m.id)) {
				continue;
			}

			// AGUI tool-call-only siblings. CopilotKit 1.52's free hook
			// tree splits an assistant turn into TWO messages: text first
			// ("Changes ready for review."), tool-calls slightly later
			// ({id, role:"assistant", toolCalls:[...]} with no content).
			// The text usually settles BEFORE the tool-call sibling
			// arrives, so the walker enqueues the text alone, then sees
			// the tool-call sibling on the next fingerprint tick.
			//
			// Two paths from here:
			//   (a) Same-tick: tool-call sibling already in the array
			//       when the text message is processed. The forward-scan
			//       below catches it and merges toolCalls onto the text
			//       payload BEFORE enqueueing. This branch then sees the
			//       sibling already in `persistedIdsRef` and skips it.
			//   (b) Late: text was persisted on a prior tick without
			//       toolCalls. The walker now sees the tool-call sibling
			//       fresh. We enqueue a "patch" persist call that targets
			//       the PARENT TEXT message's id (the immediately-prior
			//       assistant message) with the sibling's toolCalls.
			//       Server-side `appendTurnForDocument` recognises the
			//       duplicate id and MERGES the toolCalls into the
			//       existing row (see procedure docblock §9). The chip
			//       then renders on the parent text message id, where
			//       DiffOutcomeChip expects to find it.
			if (
				m.role === "assistant" &&
				typeof m.isTextMessage !== "function" &&
				typeof m.isActionExecutionMessage !== "function" &&
				(typeof m.content !== "string" || m.content.length === 0) &&
				Array.isArray((m as { toolCalls?: unknown }).toolCalls) &&
				((m as { toolCalls?: unknown[] }).toolCalls ?? []).length > 0
			) {
				persistedIdsRef.current.add(m.id);
				const siblingToolCalls = extractAguiToolCallOnly(m);
				if (siblingToolCalls && siblingToolCalls.length > 0) {
					// Walk backwards for the parent assistant text turn.
					// Stop at the first user message — never patch across
					// a turn boundary.
					let parentTextId: string | null = null;
					for (let p = i - 1; p >= 0; p--) {
						const prev = runtimeMessages[p];
						if (!prev?.id) {
							continue;
						}
						if (prev.role === "user") {
							break;
						}
						if (
							prev.role === "assistant" &&
							typeof prev.content === "string" &&
							prev.content.length > 0
						) {
							parentTextId = prev.id;
							break;
						}
					}
					if (
						parentTextId !== null &&
						persistedIdsRef.current.has(parentTextId)
					) {
						const patch: AppendTurnMessage = {
							id: parentTextId,
							role: "assistant",
							// Content is replayed but the server's
							// idempotent merge path only touches toolCalls.
							// We send the empty placeholder to keep the
							// schema satisfied — the existing row's content
							// is what's already there.
							content: "",
							timestamp: new Date().toISOString(),
							streamStatus: "completed",
							toolCalls: siblingToolCalls,
							agentId,
						};
						persistQueueRef.current.push(patch);
					}
				}
				continue;
			}

			// FR-2 guard: skip anything still streaming UNLESS the
			// generation just ended.
			//
			// Three terminal paths:
			//   (a) `isTerminal(m)` covers GQL-format messages with an
			//       explicit Success/Failed status, plus the AGUI-format
			//       user message (which is always terminal — see
			//       `isTerminal`'s docblock).
			//   (b) `isTrailingPending`: explicit Pending status on the
			//       trailing message + generation ended → cancellation.
			//   (c) `isAguiAssistantOnGenerationEnd`: AGUI-format
			//       assistant message (no `status` field at all) + the
			//       generation just ended → stream completed. This is
			//       the case CopilotKit 1.52's free hook tree actually
			//       produces, and is what broke staging persistence
			//       post-merge of #1091 until this guard was added.
			const terminal = isTerminal(m);
			const isTrailingPending =
				generationJustEnded &&
				i === runtimeMessages.length - 1 &&
				m.status?.code === "Pending";
			const isAguiAssistantOnGenerationEnd =
				generationJustEnded &&
				m.status?.code === undefined &&
				m.role === "assistant" &&
				typeof m.content === "string" &&
				m.content.length > 0;
			if (
				!terminal &&
				!isTrailingPending &&
				!isAguiAssistantOnGenerationEnd
			) {
				continue;
			}

			const payload = extractPayload(m);
			if (!payload) {
				// Non-persistable message types (AgentState etc.) are
				// recorded as "seen" so we don't keep iterating them.
				persistedIdsRef.current.add(m.id);
				continue;
			}

			// Merge any AGUI tool-call-only siblings that immediately
			// follow this assistant text message. CopilotKit 1.52's
			// free hook tree emits them as separate messages; we want
			// them attached to the parent text message in the persisted
			// blob so DiffOutcomeChip can stamp acceptedAt / rejectedAt
			// at the right id.
			if (payload.role === "assistant") {
				let j = i + 1;
				while (j < runtimeMessages.length) {
					const sibling = runtimeMessages[j];
					if (!sibling) {
						break;
					}
					const siblingToolCalls = extractAguiToolCallOnly(sibling);
					if (!siblingToolCalls) {
						break;
					}
					payload.toolCalls.push(...siblingToolCalls);
					// Already marked as seen by the dedicated branch above,
					// but be defensive — `j` may be past that branch's
					// reach if extractAguiToolCallOnly recognises a message
					// the branch didn't (different field-name shape).
					if (sibling.id) {
						persistedIdsRef.current.add(sibling.id);
					}
					j++;
				}
			}

			const streamStatus: "completed" | "error" | "cancelled" =
				isTrailingPending
					? "cancelled"
					: m.status?.code === "Failed"
						? "error"
						: "completed";
			// Pull the registered attachment batch for this user turn from
			// the shared `<AttachmentRegistryProvider>`. The provider has
			// already correlated the batch to this message's id (via its
			// own walk of `useCopilotChatInternal().messages`), so we
			// simply read by id. Non-user turns get nothing — the agent
			// doesn't (today) emit attachments of its own. The
			// `pendingAttachmentsRef` prop is kept for backwards compat
			// with surfaces that mount this component WITHOUT the
			// provider; in that case we fall back to the FIFO pop.
			let attachmentsForTurn: PendingAttachment[] | undefined;
			if (payload.role === "user") {
				const fromRegistry = attachmentRegistry?.get(m.id);
				if (Array.isArray(fromRegistry) && fromRegistry.length > 0) {
					// Coerce to the persistable shape — `previewUrl` is
					// stripped because the server signs it fresh on read,
					// and entries missing required fields are dropped so
					// we never persist an attachment we can't re-sign.
					attachmentsForTurn = fromRegistry
						.filter(
							(a): a is PendingAttachment =>
								typeof a.id === "string" &&
								typeof a.s3Path === "string" &&
								typeof a.name === "string" &&
								typeof a.mimeType === "string" &&
								(a.kind === "image" || a.kind === "file"),
						)
						.map((a) => ({
							id: a.id,
							s3Path: a.s3Path,
							name: a.name,
							mimeType: a.mimeType,
							sizeBytes: a.sizeBytes,
							kind: a.kind as "image" | "file",
						}));
					if (attachmentsForTurn.length === 0) {
						attachmentsForTurn = undefined;
					}
				} else if (
					pendingAttachmentsRef?.current &&
					pendingAttachmentsRef.current.length > 0
				) {
					// Legacy path: no provider mounted — pop directly.
					attachmentsForTurn = pendingAttachmentsRef.current.shift();
				}
			}
			const message: AppendTurnMessage = {
				id: m.id,
				role: payload.role,
				content: payload.content,
				timestamp:
					typeof m.createdAt === "string"
						? m.createdAt
						: m.createdAt instanceof Date
							? m.createdAt.toISOString()
							: new Date().toISOString(),
				streamStatus,
				...(streamStatus === "cancelled"
					? { cancelledAt: new Date().toISOString() }
					: {}),
				...(payload.toolCalls.length > 0
					? { toolCalls: payload.toolCalls }
					: {}),
				...(attachmentsForTurn && attachmentsForTurn.length > 0
					? { attachments: attachmentsForTurn }
					: {}),
				agentId,
			};
			// Optimistically mark as enqueued BEFORE the worker pops the
			// item — a parent re-render mid-flight must not re-enqueue
			// the same id. The server's per-id idempotency means a manual
			// retry path (page reload + hydration) is still safe.
			persistedIdsRef.current.add(m.id);
			persistQueueRef.current.push(message);
		}

		if (persistQueueRef.current.length > 0 && !workerRunningRef.current) {
			workerRunningRef.current = true;
			void drainQueue();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fingerprint, isLoading]);

	async function drainQueue(): Promise<void> {
		try {
			while (persistQueueRef.current.length > 0) {
				const next = persistQueueRef.current.shift();
				if (!next) {
					break;
				}
				await persist(next);
			}
		} finally {
			workerRunningRef.current = false;
		}
	}

	async function persist(message: AppendTurnMessage): Promise<void> {
		try {
			const response = await appendTurnRef.current.mutateAsync({
				conversationId: conversationIdRef.current,
				scope: {
					documentRefKind,
					documentRefId,
					projectId,
					organizationId,
				},
				message,
				agentId,
				requestedVisibility: requestedVisibilityRef.current,
			});
			// New conversation lazy-create: hand the returned id back so
			// the next dequeued message (and subsequent renders) target
			// the same row.
			if (
				conversationIdRef.current === null &&
				response?.conversationId
			) {
				// Update the ref synchronously so the next queue iteration
				// (which reads conversationIdRef before awaiting) sees the
				// freshly-created id. The parent state update flows in via
				// the useEffect on `conversationId` shortly after — by then
				// our ref already matches.
				conversationIdRef.current = response.conversationId;
				onConversationIdResolvedRef.current(response.conversationId);
			}
			// Spill: the procedure created a continuation row; future
			// turns must go to the new id.
			if (response?.spilledTo) {
				conversationIdRef.current = response.spilledTo;
				onSpilledRef.current(response.spilledTo);
			}
		} catch (err) {
			const errMessage = err instanceof Error ? err.message : String(err);
			if (errMessage.includes(HISTORY_DISABLED_ERROR_FRAGMENT)) {
				// Feature flag is OFF — swallow silently, the org has
				// opted out and we don't want UI noise on every turn.
				console.info(
					"[CopilotPersistenceHook] feature flag disabled — skipping turn",
					{ messageId: message.id, documentRefId },
				);
				return;
			}
			if (errMessage.includes(DAILY_CAP_ERROR_FRAGMENT)) {
				// 50/day soft cap — surface the friendly server message.
				toast.error(errMessage);
				return;
			}
			// Anything else: log and continue. Persistence is best-effort;
			// the chat keeps working.
			console.warn(
				"[CopilotPersistenceHook] failed to persist assistant turn",
				{ messageId: message.id, documentRefId, error: errMessage },
			);
		}
	}

	return null;
}

/**
 * Stable per-render summary of the messages array. We key the persistence
 * effect off this string so it re-fires whenever the structural state
 * changes (length grew, last message id changed, last terminal status
 * code changed) — independent of array reference identity. Two renders
 * with the same message ids in the same statuses produce the same
 * fingerprint and trigger no work.
 *
 * Exported for unit-test reach: a fingerprint regression test in
 * `__tests__/copilot/document-editor-persistence.test.tsx` exercises this
 * directly to guarantee a Pending → Success transition produces a
 * different string.
 */
export function computeFingerprint(
	messages: ReadonlyArray<CopilotKitRuntimeMessage> | undefined,
): string {
	if (!messages || messages.length === 0) {
		return "0::";
	}
	const last = messages[messages.length - 1];
	const lastId = last?.id ?? "";
	const lastCode = last?.status?.code ?? "Pending";
	// Include the second-to-last entry's id+code as well: a single
	// generation produces (user turn, assistant turn) in quick succession,
	// and we need to re-walk when the user turn settles even if the array
	// length is unchanged because the assistant turn was appended in the
	// same render tick.
	const prev =
		messages.length >= 2 ? messages[messages.length - 2] : undefined;
	const prevId = prev?.id ?? "";
	const prevCode = prev?.status?.code ?? "";
	return `${messages.length}:${lastId}:${lastCode}:${prevId}:${prevCode}`;
}
