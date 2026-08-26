"use client";

/**
 * DocumentGeneratorEditor - Shared document editor component for document generator agents
 *
 * This component implements the 4-effect streaming pattern for document generation
 * with proper diff highlighting. It's used by both:
 * - Personal account: /app/agents/document-generator
 * - Organization account: /app/[org]/agents/[agentId]/chat (for document generator agents)
 *
 * Features:
 * - TipTap rich-text editor with slash commands
 * - AG-UI protocol for real-time streaming updates
 * - Diff highlighting for AI-generated changes (green for additions, red for deletions)
 * - Predictive state updates pattern from CopilotKit
 * - Document type selection
 * - Raw markdown view toggle
 *
 * IMPORTANT: This component follows the 4-effect pattern for document streaming.
 * See docs/DOCUMENT_EDITOR_STREAMING_PATTERN.md for the canonical implementation.
 */

import "@copilotkit/react-ui/styles.css";
import "@saas/projects/components/DocumentEditor.css";

import {
	useCoAgent,
	useCopilotAction,
	useCopilotChat,
	useCopilotChatInternal,
	useCopilotReadable,
} from "@copilotkit/react-core";
import type { AssistantMessageProps } from "@copilotkit/react-ui";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { MessageRole, TextMessage } from "@copilotkit/runtime-client-gql";
import type { DocumentType } from "@repo/agent-types";
import { CompactDocumentTypeSelector } from "@saas/agents/components/CompactDocumentTypeSelector";
import { createDocumentGeneratorChatHeader } from "@saas/agents/components/DocumentGeneratorChatHeader";
import { DocumentGeneratorHistoryDrawer } from "@saas/agents/components/DocumentGeneratorHistoryDrawer";
import type { ConversationMessage } from "@saas/agents/hooks/useConversationHistory";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { EditorBubbleMenu } from "@saas/projects/components/EditorBubbleMenu";
import { EditorToolbar } from "@saas/projects/components/EditorToolbar";
import { SlashCommandsExtension } from "@saas/projects/components/SlashCommands";
import {
	diffPartialText,
	focusOnAnchor,
	focusOnLastDiff,
	fromMarkdown,
	repairMarkdownDocument,
	resetScrollTracking,
} from "@saas/projects/lib/diff-utils";
import { advancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { CopilotAssistantMessageForDocumentGenerator } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { createCopilotSidebarInput } from "@saas/shared/components/copilot/CopilotSidebarInput";
import { CopilotUserMessage } from "@saas/shared/components/copilot/CopilotUserMessage";
import { useClarifyingQuestions } from "@saas/shared/components/copilot/useClarifyingQuestions";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { orpcClient } from "@shared/lib/orpc-client";
import { EditorContent, useEditor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Code2Icon, EyeIcon } from "lucide-react";
import {
	type ComponentType,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { getEditorMarkdownForSave } from "../../projects/lib/editor-markdown-save";

const extensions = [...advancedExtensions, SlashCommandsExtension];

/**
 * Maps a CopilotKit runtime message to the persisted AgentConversation
 * `MessageSchema` shape (id / role / content / ISO timestamp). Returns null for
 * non-text or empty messages so they're skipped during persistence — only
 * user/assistant prose is stored.
 *
 * Handles BOTH message formats CopilotKit surfaces, because the live runtime in
 * the free hook tree does NOT use the GQL class instances:
 *   1. **GQL-format** (e.g. messages we hydrate via `setMessages` with
 *      `TextMessage` instances): class instances exposing `isTextMessage()`.
 *   2. **AGUI-format** (what `useCopilotChatInternal().messages` actually
 *      contains for live turns — verified on staging): plain
 *      `{ id, role, content }` objects with NO discriminator methods. These are
 *      detected by duck-typing: a string `content`, a known `role`, and the
 *      ABSENCE of tool-call fields (`arguments` / `actionExecutionId`). Missing
 *      this branch silently dropped every live turn so nothing ever persisted.
 * Mirrors `CopilotPersistenceHook.extractPayload` (the proven document-assistant
 * persistence path).
 */
function toPersistedMessage(
	msg: unknown,
	agentId: string,
): ConversationMessage | null {
	const m = msg as {
		id?: unknown;
		role?: unknown;
		content?: unknown;
		createdAt?: unknown;
		type?: unknown;
		isTextMessage?: () => boolean;
		isActionExecutionMessage?: () => boolean;
		arguments?: unknown;
		actionExecutionId?: unknown;
	};
	const isGqlText =
		typeof m.isTextMessage === "function"
			? m.isTextMessage()
			: m.type === "TextMessage";
	const isAguiText =
		typeof m.isTextMessage === "undefined" &&
		typeof m.isActionExecutionMessage === "undefined" &&
		typeof m.content === "string" &&
		m.arguments === undefined &&
		m.actionExecutionId === undefined;
	if (!isGqlText && !isAguiText) {
		return null;
	}
	const role = m.role;
	if (role !== "user" && role !== "assistant" && role !== "system") {
		return null;
	}
	const content = typeof m.content === "string" ? m.content : "";
	if (!content.trim()) {
		return null;
	}
	const id = typeof m.id === "string" && m.id ? m.id : crypto.randomUUID();
	const timestamp =
		typeof m.createdAt === "string"
			? m.createdAt
			: m.createdAt instanceof Date
				? m.createdAt.toISOString()
				: new Date().toISOString();
	return { id, role, content, timestamp, agentId };
}

interface AgentState {
	document: string;
	documentType?: DocumentType;
	error?: string;
	retryCount?: number;
	focusAnchor?: string;
	/**
	 * Uploaded-file content forwarded to the agent. Mirrors what the
	 * `useCopilotReadable` ("rag context") channel publishes — included here
	 * because `document_generator` reads `copilotKitState.ragContexts` and
	 * ignores the readables array entirely
	 * (`agents/langchain/document-generator/unified-server.ts:394`).
	 */
	ragContexts?: string[];
	/**
	 * Per-turn reasoning trace populated by chat-node.ts via
	 * `buildReasoningUpdate` from `@repo/agent-core/reasoning-trace`.
	 * Must be declared here AND seeded in `useCoAgent`'s `initialState`
	 * for the STATE_SNAPSHOT events to survive CopilotKit's key filter.
	 */
	reasoningByTurn?: Record<
		number,
		{
			text: string;
			durationMs: number;
			startedAt: number;
			completedAt: number;
		}
	>;
}

export interface DocumentGeneratorEditorProps {
	/** Agent ID to use for the CoAgent hook */
	agentId?: string;
	/** Title to display in the sidebar */
	title?: string;
	/** Initial message in the sidebar */
	initialMessage?: string;
	/** Chat suggestions */
	suggestions?: Array<{ title: string; message: string }>;
	/**
	 * Optional pre-bound assistant message component. Defaults to the
	 * `document_generator`-bound variant for the
	 * `/app/agents/document-generator` page. Custom-agent callers
	 * (e.g. `AgentChatDocument`) must pass a `useMemo`'d factory bound
	 * to their dynamic `agentId` so reasoning state is read from the
	 * correct `useCoAgent` channel.
	 */
	AssistantMessage?: ComponentType<AssistantMessageProps>;
}

export function DocumentGeneratorEditor({
	agentId = "document_generator",
	title = "AI Assistant",
	initialMessage = "Hi! I can help you edit documents in place. Try asking me to:\n\n• Expand a specific section\n• Add more technical details, examples, or edge cases\n• Fill in missing sections without rewriting the whole document",
	suggestions = [
		{
			title: "Expand a section",
			message:
				"Expand the current section with more detailed requirements, examples, and implementation notes.",
		},
		{
			title: "Add edge cases",
			message:
				"Add edge cases, failure modes, and exception handling details to the relevant parts of this document.",
		},
		{
			title: "Fill missing details",
			message:
				"Find thin or incomplete sections and add concrete technical details without regenerating the full document.",
		},
	],
	AssistantMessage = CopilotAssistantMessageForDocumentGenerator,
}: DocumentGeneratorEditorProps) {
	const [documentType, setDocumentType] = useState<DocumentType>("general");
	const [currentDocument, setCurrentDocument] = useState("");
	const [viewMode, setViewMode] = useState<"rich" | "raw">("rich");
	const [rawContent, setRawContent] = useState("");
	const { isLoading } = useCopilotChat();
	// CopilotKit's live message store. `useCopilotChatInternal` (NOT
	// `useCopilotChat`) is the correct read hook for the raw message array the
	// sidebar renders from — the same store `CopilotPersistenceHook` subscribes
	// to. `useCopilotChat().visibleMessages` does not surface live turns in the
	// AGUI shape the persistence walker needs. `setMessages` is the supported
	// primitive for clearing/hydrating the transcript (same as DocumentEditor).
	const { setMessages: setCopilotMessages, messages: internalMessages } =
		useCopilotChatInternal();

	// Organization context for document uploads
	const { organizationId } = useOrganizationContext();

	// Clarifying-question card: register the `ask_clarifying_question` frontend
	// action so the document_generator agent can surface the interactive question
	// card on this standalone editor too. No project frequency here — defaults to
	// BALANCED.
	useClarifyingQuestions({ organizationId: organizationId ?? null });

	// Track uploaded document content for follow-up questions
	const [uploadedDocContexts, setUploadedDocContexts] = useState<string[]>(
		[],
	);

	// `flushSync` forces the state commit synchronously so the
	// `useCopilotReadable` value is updated before the in-flight Send picks
	// up CopilotKit's context snapshot — without it the first turn after
	// upload races React's batch and ships an empty context.
	//
	// The entry arrives finished from `useCopilotDocumentUpload`, which also
	// picks the image envelope (a markdown image link carrying the
	// `data:image/...;base64,…` URL, so vision-capable LLMs render the picture
	// from prompt context) and neutralizes the filename. We only push it.
	const handleContentExtracted = useCallback((contextEntry: string) => {
		flushSync(() => {
			setUploadedDocContexts((prev) => [...prev, contextEntry]);
		});
	}, []);

	// Expose uploaded document content to the agent via TWO channels because
	// the `document_generator` and `project_document_generator` agents read
	// from different places:
	//
	//   1. `useCopilotReadable` with description containing "rag context" —
	//      `project_document_generator` reads via `findReadableValue("rag context")`
	//      against `input.context`.
	//   2. `useCoAgent` state's `ragContexts` field — `document_generator`
	//      reads `copilotKitState?.ragContexts` and ignores `input.context`
	//      entirely (see `agents/langchain/document-generator/unified-server.ts:394`).
	//
	// Sending via both ensures the file content reaches whichever agent the
	// page is wired to.
	useCopilotReadable({
		description:
			"RAG context — content extracted from documents uploaded by the user in this chat session",
		value: {
			ragContexts: uploadedDocContexts,
			ragContextsCount: uploadedDocContexts.length,
		},
	});

	// Stable hook handed to the input factory below. It flushes the live editor
	// content into the agent's `document` state field right before every chat
	// send — the real closure is assigned to `syncDocumentBeforeSendRef.current`
	// once `editor`/`setAgentStateRef` are declared (further down). `useCoAgent`
	// is bidirectional, so an agent reply that omits `document` syncs an empty
	// value back onto the frontend state; re-asserting it before each send keeps
	// the agent able to see the open document's sections. Defined here so the
	// factory memo can reference a stable identity without re-registering.
	const syncDocumentBeforeSendRef = useRef<() => void>(() => {});
	const handleBeforeSend = useCallback(() => {
		syncDocumentBeforeSendRef.current();
	}, []);

	// Custom CopilotSidebar Input with document upload support
	const CustomSidebarInput = useMemo(
		() =>
			createCopilotSidebarInput({
				organizationId: organizationId ?? null,
				onContentExtracted: handleContentExtracted,
				surface: "document-generator",
				compressionMaxDimension: 1024,
				compressionQuality: 0.8,
				onBeforeSend: handleBeforeSend,
			}),
		[organizationId, handleContentExtracted, handleBeforeSend],
	);

	// === STREAMING BASELINE REFS (fixes race condition with async state) ===
	// The baseline must be captured synchronously when loading starts.
	// Using state alone causes race conditions because setCurrentDocument is async
	// but Effect 3 needs the baseline immediately when agentState changes.
	// Declared here (above the session-persistence handlers) so those handlers
	// can reset the baseline on "New conversation" / load-history.
	const baselineRef = useRef<string>("");
	const wasLoadingRef = useRef(false);

	// === SESSION PERSISTENCE (AgentConversation) ===
	// Server-persist each completed turn into the generic AgentConversation
	// model, scoped to this surface by `agentId` + `organizationId` (XOR). This
	// mirrors FabricDirectChat's persist-on-stream-complete pattern, adapted to
	// the CopilotKit message store the sidebar reads from.
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
	// Idempotency guard — stores a signature of the last persisted turn so an
	// effect re-run (CopilotKit re-renders frequently) never double-persists the
	// same pair. Mirrors FabricDirectChat's `lastPersistedRef`.
	const lastPersistedRef = useRef<string | null>(null);
	// `conversationId` is read inside the persistence effect but must not be a
	// dependency (we don't want a freshly-created id to re-trigger the effect and
	// re-persist the same turn). Read it through a ref instead.
	const conversationIdRef = useRef<string | null>(null);
	conversationIdRef.current = conversationId;
	// Hydration guard — when we load a past conversation we call
	// `setCopilotMessages(...)`, which makes those messages appear in
	// `internalMessages`. We must NOT re-persist hydrated history, so we record
	// the ids we just hydrated and skip them on the next persistence pass.
	const hydratedIdsRef = useRef<Set<string>>(new Set());

	// Persist on completed turn: a `useEffect` watching the live messages while
	// `!isLoading`. Detects the latest user→assistant text pair and writes it.
	useEffect(() => {
		if (isLoading) {
			return;
		}
		const persisted = (internalMessages ?? [])
			.map((m) => toPersistedMessage(m, agentId))
			.filter((m): m is ConversationMessage => m !== null);
		if (persisted.length < 2) {
			return;
		}
		// The most recent assistant message and the user message that precedes
		// it form the turn to persist.
		const lastAssistantIdx = (() => {
			for (let i = persisted.length - 1; i >= 0; i--) {
				if (persisted[i].role === "assistant") {
					return i;
				}
			}
			return -1;
		})();
		if (lastAssistantIdx <= 0) {
			return;
		}
		const assistantMsg = persisted[lastAssistantIdx];
		let userMsg: ConversationMessage | null = null;
		for (let i = lastAssistantIdx - 1; i >= 0; i--) {
			if (persisted[i].role === "user") {
				userMsg = persisted[i];
				break;
			}
		}
		if (!userMsg) {
			return;
		}
		// Skip turns whose messages came from a hydrated past conversation.
		if (
			hydratedIdsRef.current.has(assistantMsg.id) ||
			hydratedIdsRef.current.has(userMsg.id)
		) {
			return;
		}
		const signature = `${userMsg.id}::${assistantMsg.id}`;
		if (lastPersistedRef.current === signature) {
			return;
		}
		lastPersistedRef.current = signature;

		const orgId = organizationId ?? null;
		void (async () => {
			try {
				if (conversationIdRef.current === null) {
					const title = userMsg.content.slice(0, 80);
					const created =
						await orpcClient.agents.conversations.create({
							organizationId: orgId,
							agentId,
							title,
							messages: [userMsg, assistantMsg],
							metadata: { surface: "document-generator" },
						});
					setConversationId(created.id);
					conversationIdRef.current = created.id;
				} else {
					// Append the new user + assistant messages individually.
					await orpcClient.agents.conversations.addMessage({
						conversationId: conversationIdRef.current,
						organizationId: orgId,
						message: userMsg,
					});
					await orpcClient.agents.conversations.addMessage({
						conversationId: conversationIdRef.current,
						organizationId: orgId,
						message: assistantMsg,
					});
				}
			} catch (err) {
				// Persistence is best-effort — a failure must never break the
				// chat. Release the idempotency latch so a later effect pass can
				// retry the same turn.
				lastPersistedRef.current = null;
				console.warn(
					"[DocumentGeneratorEditor] Failed to persist conversation turn:",
					err,
				);
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [internalMessages, isLoading, agentId, organizationId]);

	// "New conversation": clear the live transcript and reset persistence state
	// so the next turn lazy-creates a fresh AgentConversation row.
	const handleNewConversation = useCallback(() => {
		setCopilotMessages([]);
		setConversationId(null);
		conversationIdRef.current = null;
		lastPersistedRef.current = null;
		hydratedIdsRef.current = new Set();
		// Reset the streaming baseline so the next turn diffs from a clean slate.
		baselineRef.current = "";
		toast.success("Started a new conversation");
	}, [setCopilotMessages]);

	const handleOpenHistory = useCallback(() => {
		setHistoryDrawerOpen(true);
	}, []);

	// Load a past conversation into the live transcript on select.
	const handleSelectConversation = useCallback(
		async (id: string) => {
			try {
				const conversation = await orpcClient.agents.conversations.get({
					id,
					organizationId: organizationId ?? null,
				});
				const persistedMessages = Array.isArray(conversation.messages)
					? (conversation.messages as unknown as ConversationMessage[])
					: [];
				const hydrated = persistedMessages
					.filter(
						(m) =>
							(m.role === "user" || m.role === "assistant") &&
							typeof m.content === "string",
					)
					.map(
						(m) =>
							new TextMessage({
								id: m.id,
								role:
									m.role === "assistant"
										? MessageRole.Assistant
										: MessageRole.User,
								content: m.content,
								createdAt: m.timestamp,
							}),
					);
				// Record hydrated ids so the persistence effect skips re-writing
				// this loaded history.
				hydratedIdsRef.current = new Set(hydrated.map((m) => m.id));
				lastPersistedRef.current = null;
				setCopilotMessages(hydrated);
				setConversationId(id);
				conversationIdRef.current = id;
				baselineRef.current = "";
			} catch (err) {
				const message =
					err instanceof Error
						? err.message
						: "Could not open that conversation.";
				toast.error(message);
			}
		},
		[organizationId, setCopilotMessages],
	);

	// Custom CopilotSidebar Header — title + "New conversation" + chat-history
	// affordances, matching the project editors' header visual design.
	const CustomSidebarHeader = useMemo(
		() =>
			createDocumentGeneratorChatHeader({
				title,
				onNewConversation: handleNewConversation,
				onOpenHistory: handleOpenHistory,
			}),
		[title, handleNewConversation, handleOpenHistory],
	);

	// NOTE: `baselineRef` / `wasLoadingRef` are declared above (before the
	// session-persistence block) so the "New conversation" / load-history
	// handlers can reset the streaming baseline without a forward reference.

	const editor = useEditor({
		extensions,
		immediatelyRender: false,
		editorProps: {
			attributes: { class: "p-10 tiptap" },
		},
	});

	const {
		state: agentState,
		setState: setAgentState,
		nodeName,
	} = useCoAgent<AgentState>({
		name: agentId,
		initialState: {
			document: "",
			documentType: "general",
			error: undefined,
			retryCount: 0,
			// Declare reasoningByTurn in initialState so CopilotKit's
			// useCoAgent doesn't filter it out of STATE_SNAPSHOT updates.
			// Without this key, reasoning events arrive on the SSE wire but
			// are dropped before reaching the CopilotAssistantMessage*
			// subscriptions. Same rationale as DocumentEditor.tsx:1286.
			reasoningByTurn: {},
		},
	});

	// `useCoAgent` returns a new `setState` every render; reading it through
	// a ref keeps our effects from depending on the identity AND lets us
	// avoid the stale-closure trap of `setState({ ...agentState, ... })`,
	// which would overwrite freshly-applied diff/accept changes with an
	// outdated snapshot of `agentState`. We pass partial updates only;
	// `useCoAgent`'s `setState` merges them with the live state.
	const setAgentStateRef = useRef(setAgentState);
	setAgentStateRef.current = setAgentState;

	// Keep the before-send sync closure (handed to the input factory above as
	// `handleBeforeSend`) pointing at the latest `editor` + `setAgentStateRef`.
	// Flushes the current editor markdown into `state.document` synchronously
	// right before each send so the outgoing turn always carries the open
	// document — guards against the bidirectional `useCoAgent` sync having
	// clobbered it to empty. Partial-update form only (never spread stale
	// `agentState`, per the note above).
	syncDocumentBeforeSendRef.current = () => {
		if (!editor) {
			return;
		}
		// This component has no persistence path of its own (the
		// generated doc is exported/applied elsewhere) — it only mirrors editor
		// content into agent context, so `?? ""` is fine on a failed read.
		const markdown = getEditorMarkdownForSave(editor) ?? "";
		flushSync(() => {
			setAgentStateRef.current({ document: markdown } as AgentState);
		});
	};

	// Sync document type with agent state (partial update — no spread).
	useEffect(() => {
		if (agentState?.documentType !== documentType) {
			setAgentStateRef.current({ documentType } as AgentState);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [documentType]);

	// Sync uploaded-file content into agent state so `document_generator`
	// (which ignores `useCopilotReadable` and reads `copilotKitState.ragContexts`)
	// receives the file content. Partial update via ref — never spread a
	// stale `agentState` here, otherwise an in-flight diff/accept that has
	// already mutated `document` would be silently rolled back the moment
	// a new attachment arrives.
	useEffect(() => {
		if (
			(agentState?.ragContexts?.length ?? 0) !==
			uploadedDocContexts.length
		) {
			setAgentStateRef.current({
				ragContexts: uploadedDocContexts,
			} as AgentState);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [uploadedDocContexts]);

	// === STREAMING PATTERN - REF-BASED TO FIX RACE CONDITIONS ===
	// The key insight: React state updates are async, but we need the baseline
	// IMMEDIATELY when streaming starts. Using refs ensures synchronous access.
	// See docs/DOCUMENT_EDITOR_STREAMING_PATTERN.md for detailed explanation

	// Effect 1: Capture baseline when loading STARTS (transition from false to true)
	// Uses ref to detect the transition and capture baseline synchronously
	useEffect(() => {
		// Only capture baseline on transition: wasLoading=false → isLoading=true
		if (isLoading && !wasLoadingRef.current && editor) {
			// Reset scroll tracking for new streaming session
			// This clears the "user scrolled away" flag so auto-scroll works
			resetScrollTracking();

			// No persistence path here (see note above); `?? ""`
			// preserves prior behavior on a failed read.
			const baseline = getEditorMarkdownForSave(editor) ?? "";
			baselineRef.current = baseline;
			setCurrentDocument(baseline); // Keep state in sync for other uses
			console.log("[DocumentGeneratorEditor] Baseline captured:", {
				length: baseline.length,
				preview: baseline.substring(0, 100),
			});
		}
		wasLoadingRef.current = isLoading;
		editor?.setEditable(!isLoading);
	}, [isLoading, editor]);

	// Effect 2: Final diff when nodeName becomes "end"
	// Uses baselineRef instead of currentDocument state to avoid stale closure
	useEffect(() => {
		if (nodeName === "end") {
			const baseline = baselineRef.current;
			const newDocument = agentState?.document || "";

			// Only show diff if we have BOTH baseline AND new content
			if (
				baseline.trim().length > 0 &&
				newDocument.trim().length > 0 &&
				baseline !== newDocument
			) {
				const diff = diffPartialText(baseline, newDocument, true);
				const markdown = fromMarkdown(diff);
				editor?.commands.setContent(markdown);
				console.log("[DocumentGeneratorEditor] Final diff applied:", {
					baselineLength: baseline.length,
					newLength: newDocument.length,
				});
			}

			// Focus on the changed section using focusAnchor from agent state
			const anchor = agentState?.focusAnchor;
			if (anchor && anchor.trim().length > 0) {
				setTimeout(() => {
					focusOnAnchor(editor, anchor);
				}, 100);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeName, agentState?.document]);

	// Effect 3: Streaming diff updates
	// CRITICAL: Uses baselineRef.current instead of currentDocument state
	// This fixes the race condition where state hasn't updated yet
	useEffect(() => {
		if (isLoading) {
			const baseline = baselineRef.current;
			const newDocument = agentState?.document || "";

			// Skip if baseline is empty (shouldn't happen, but safety check)
			if (baseline.trim().length === 0) {
				// No baseline - just show the new content without diff
				if (newDocument.trim().length > 0) {
					const markdown = fromMarkdown(newDocument);
					editor?.commands.setContent(markdown);
				}
				return;
			}

			// Skip if new document is empty or same as baseline
			if (newDocument.trim().length === 0 || newDocument === baseline) {
				return;
			}

			const diff = diffPartialText(baseline, newDocument);
			const markdown = fromMarkdown(diff);
			editor?.commands.setContent(markdown);

			// Follow the last diff element during streaming
			focusOnLastDiff(editor);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentState?.document, isLoading]);

	// Effect 4: Sync editor to state when not loading
	// Also updates baselineRef so it's ready for the next streaming session
	const editorDocRef = editor?.state?.doc;
	useEffect(() => {
		if (!isLoading && editor) {
			// No persistence path here (see note above); `?? ""`
			// preserves prior behavior on a failed read.
			const editorMarkdown = getEditorMarkdownForSave(editor) ?? "";
			setCurrentDocument(editorMarkdown);
			baselineRef.current = editorMarkdown; // Keep ref in sync
			setAgentState({
				...agentState,
				document: editorMarkdown,
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editorDocRef, isLoading]);

	// Sync raw content when currentDocument changes
	useEffect(() => {
		if (viewMode === "rich") {
			setRawContent(currentDocument);
		}
	}, [currentDocument, viewMode]);

	// Handle view mode toggle
	const handleViewModeToggle = () => {
		if (viewMode === "raw") {
			const normalized = repairMarkdownDocument(rawContent);
			setRawContent(normalized);
			setCurrentDocument(normalized);
			if (editor) {
				editor.commands.setContent(fromMarkdown(normalized));
			}
			setViewMode("rich");
		} else {
			setViewMode("raw");
		}
	};

	// Handle raw content changes
	const handleRawContentChange = (value: string) => {
		setRawContent(value);
		setCurrentDocument(value);
	};

	// Keyboard shortcut for toggling view mode
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "V") {
				e.preventDefault();
				handleViewModeToggle();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewMode, rawContent]);

	// Confirmation action - follows ag-ui-demo pattern
	// CRITICAL FIX: Use editor content with diff tags stripped, NOT agentState.document
	// The AI may return only partial content, but the editor has the full merged view
	// with diff highlighting. getEditorMarkdownForSave() strips diff tags and gives us
	// the final content (original - deletions + additions).
	useCopilotAction(
		{
			name: "confirm_changes",
			renderAndWaitForResponse: ({ args, respond, status }) => (
				<ConfirmChanges
					args={args}
					respond={respond}
					status={status}
					onReject={() => {
						// Revert to baseline
						const baseline = baselineRef.current;
						editor?.commands.setContent(fromMarkdown(baseline));
						setCurrentDocument(baseline);
						setAgentState({ document: baseline });
						console.log(
							"[DocumentGeneratorEditor] Changes rejected, reverted to baseline",
						);
					}}
					onConfirm={() => {
						// Confirm: Get the merged content from editor (strips diff tags)
						// This gives us: original content - deletions + additions
						// No persistence path here (see note above);
						// `?? ""` preserves prior behavior on a failed read.
						const finalContent =
							getEditorMarkdownForSave(editor) ?? "";

						// Set editor to clean content (no diff highlighting)
						editor?.commands.setContent(fromMarkdown(finalContent));
						setCurrentDocument(finalContent);
						baselineRef.current = finalContent; // CRITICAL: Update baseline for follow-ups
						setAgentState({ document: finalContent });
						console.log(
							"[DocumentGeneratorEditor] Changes accepted, baseline updated",
						);
					}}
				/>
			),
		},
		[agentState?.document],
	);

	// Patch-mode UX cue: the agent holds state.document at the baseline until
	// the final STATE_SNAPSHOT arrives, so equality with the baseline during a
	// load means the model is still producing patches.
	const isPatchMode =
		isLoading && (agentState?.document ?? "") === baselineRef.current;

	return (
		<CopilotSidebar
			AssistantMessage={AssistantMessage}
			UserMessage={CopilotUserMessage}
			Header={CustomSidebarHeader}
			defaultOpen={true}
			clickOutsideToClose={false}
			Input={CustomSidebarInput}
			labels={{
				title,
				initial: initialMessage,
			}}
			suggestions={suggestions}
		>
			{/* h-full (not h-screen): the page wraps this in an
			    h-[calc(100vh-53px)] region below the breadcrumb. h-screen made the
			    editor 100vh — 53px too tall — so it overflowed and the toolbar
			    bled through the top of the AI Assistant panel. */}
			<div className="flex h-full min-h-0 flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-6 py-3 border-b bg-background gap-4">
					{isLoading ? (
						<div className="flex-1 flex justify-center">
							<div className="relative flex items-center gap-3 px-5 py-2 rounded-full bg-gradient-to-r from-violet-500/20 via-purple-500/20 to-fuchsia-500/20 border border-purple-500/40 shadow-lg shadow-purple-500/20">
								<div className="absolute inset-0 rounded-full bg-gradient-to-r from-violet-500/30 via-purple-500/30 to-fuchsia-500/30 animate-pulse" />
								<div
									className="absolute inset-0 rounded-full bg-purple-500/20 animate-ping opacity-50"
									style={{ animationDuration: "1.5s" }}
								/>
								<div className="relative">
									<FabricLogo
										className="h-5 w-5 opacity-90"
										size={20}
										variant="dark"
									/>
								</div>
								<span className="relative text-base font-semibold bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500 bg-clip-text text-transparent">
									{isPatchMode
										? "Applying changes..."
										: "AI is generating..."}
								</span>
							</div>
						</div>
					) : (
						<>
							<div className="flex items-center gap-3 min-w-0 flex-1">
								<h2 className="text-lg font-semibold truncate">
									Document Generator
								</h2>
								<CompactDocumentTypeSelector
									value={documentType}
									onChange={setDocumentType}
									disabled={isLoading}
								/>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant={
													viewMode === "raw"
														? "default"
														: "outline"
												}
												size="sm"
												onClick={handleViewModeToggle}
												disabled={isLoading}
											>
												{viewMode === "rich" ? (
													<>
														<Code2Icon className="h-4 w-4" />
														<span className="ml-2 hidden sm:inline">
															Raw
														</span>
													</>
												) : (
													<>
														<EyeIcon className="h-4 w-4" />
														<span className="ml-2 hidden sm:inline">
															Rich
														</span>
													</>
												)}
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											<p>
												{viewMode === "rich"
													? "Switch to raw markdown view"
													: "Switch to rich editor"}
											</p>
											<p className="text-xs text-muted-foreground">
												{navigator.platform.includes(
													"Mac",
												)
													? "⌘"
													: "Ctrl"}
												+Shift+V
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							</div>
						</>
					)}
				</div>

				{/* Toolbar - Only show in rich mode */}
				{viewMode === "rich" && <EditorToolbar editor={editor} />}

				{/* Editor */}
				{viewMode === "rich" ? (
					<div
						className={`flex-1 overflow-auto bg-background ${isLoading ? "streaming-diff-active" : ""}`}
					>
						{editor && <EditorBubbleMenu editor={editor} />}
						<EditorContent
							editor={editor}
							className="prose prose-sm max-w-none dark:prose-invert"
						/>
					</div>
				) : (
					<div className="flex-1 overflow-auto bg-background p-10">
						<Textarea
							value={rawContent}
							onChange={(e) =>
								handleRawContentChange(e.target.value)
							}
							placeholder="Enter your document content in markdown format..."
							className="font-mono text-sm resize-none min-h-[calc(100vh-300px)] w-full"
							disabled={isLoading}
						/>
						<div className="mt-4 space-y-2">
							<p className="text-xs text-muted-foreground">
								Raw markdown view. Edit the document directly in
								markdown format.
							</p>
						</div>
					</div>
				)}
			</div>

			{/* Session-history drawer (AgentConversation-backed). Uses a Radix
			    Sheet that portals to the body, so it can live inside the
			    sidebar tree where the CopilotKit hooks resolve. */}
			<DocumentGeneratorHistoryDrawer
				open={historyDrawerOpen}
				onOpenChange={setHistoryDrawerOpen}
				agentId={agentId}
				organizationId={organizationId ?? null}
				activeConversationId={conversationId}
				onSelectConversation={handleSelectConversation}
			/>
		</CopilotSidebar>
	);
}

// ConfirmChanges component - follows ag-ui-demo pattern
interface ConfirmChangesProps {
	args: any;
	respond: any;
	status: any;
	onReject: () => void;
	onConfirm: () => void;
}

function ConfirmChanges({
	respond,
	status,
	onReject,
	onConfirm,
}: ConfirmChangesProps) {
	const [accepted, setAccepted] = useState<boolean | null>(null);
	const [hidden, setHidden] = useState(false);

	// Auto-dismiss after user makes a choice
	useEffect(() => {
		if (accepted !== null) {
			const timer = setTimeout(() => setHidden(true), 2000);
			return () => clearTimeout(timer);
		}
	}, [accepted]);

	// If status is not "executing" and user hasn't made a choice,
	// this is a stale/re-registered component - hide it
	if (status !== "executing" && accepted === null) {
		return null;
	}

	if (hidden) {
		return null;
	}

	return (
		<div
			data-testid="confirm-changes-modal"
			className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
		>
			<h2 className="text-lg font-bold mb-4 text-foreground">
				Confirm Changes
			</h2>
			<p className="mb-6 text-foreground">
				Do you want to accept the changes?
			</p>
			{accepted === null && (
				<div className="flex justify-end space-x-4">
					<button
						type="button"
						data-testid="reject-button"
						className="bg-muted text-muted-foreground py-2 px-4 rounded cursor-pointer hover:bg-muted/80"
						onClick={() => {
							if (respond) {
								setAccepted(false);
								onReject();
								respond({ accepted: false });
							}
						}}
					>
						Reject
					</button>
					<button
						type="button"
						data-testid="confirm-button"
						className="bg-primary text-primary-foreground py-2 px-4 rounded cursor-pointer hover:bg-primary/90"
						onClick={() => {
							if (respond) {
								setAccepted(true);
								onConfirm();
								respond({ accepted: true });
							}
						}}
					>
						Confirm
					</button>
				</div>
			)}
			{accepted !== null && (
				<div className="flex justify-end">
					<div
						data-testid="status-display"
						className="mt-4 bg-muted text-muted-foreground py-2 px-4 rounded inline-block"
					>
						{accepted ? "✓ Accepted" : "✗ Rejected"}
					</div>
				</div>
			)}
		</div>
	);
}
