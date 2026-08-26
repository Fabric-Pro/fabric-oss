"use client";

/**
 * Custom `Messages` component for `<CopilotSidebar Messages={…}>`.
 *
 * Replaces CopilotKit's default Messages component so the AI Assistant
 * sidebar renders SSR-hydrated history **directly from React state**
 * instead of pushing it through `agent.messages`. Eliminates the
 * staging hydration flake (~1 in 5 reloads ended up with empty
 * sidebar) — CopilotKit's agent lifecycle is unreliable in production,
 * and any solution that depends on `agent.messages` being a stable
 * source of truth is fragile.
 *
 * # Data sources
 *
 *   1. **Historical** — `useHydratedMessages()` context, populated by
 *      `<HydratedMessagesProvider>` from the SSR-loaded conversation
 *      blob. Frozen at mount. Persistent across CopilotKit's internal
 *      agent swaps because it lives outside CopilotKit.
 *   2. **Live**   — `useCopilotChatInternal().messages`, the standard
 *      live store CopilotKit owns. New turns the user sends, plus any
 *      streaming assistant turn, flow through this path normally.
 *
 * Merged and rendered in document order: greeting → historical →
 * live. Live messages whose id is already in the historical set are
 * filtered out (after persistence + reload the same message appears in
 * both lists; we keep the historical copy).
 *
 * # Why not use the default `messages` prop on MessagesProps
 *
 * Looking at the default `Messages.tsx` in @copilotkit/react-ui:
 *   const { messages: visibleMessages } = useCopilotChatInternal();
 *   const messages = [...initialMessages, ...visibleMessages];
 *
 * The default ignores the `messages` prop entirely and reads from the
 * internal hook. So this component reads from the same hook + our
 * historical context, then renders via the same `RenderMessage` /
 * `AssistantMessage` / `UserMessage` pipeline the default uses — full
 * compatibility with our customized `<CopilotAssistantMessage>` and
 * `<CopilotUserMessage>` renderers.
 *
 * # What this DOESN'T do
 *
 *   - Does NOT push anything into `agent.messages`. The hydrator is
 *     gone.
 *   - Does NOT race against `connectAgent`'s wipe / pruning. We don't
 *     touch the agent's messages at all.
 *   - Does NOT depend on `useAgent`'s provisional → real swap behavior.
 *     Whatever the agent's internal state, our historical messages stay
 *     on screen.
 */

import { useCopilotChatInternal } from "@copilotkit/react-core";
import { type MessagesProps, useChatContext } from "@copilotkit/react-ui";
import { useEffect, useMemo, useRef } from "react";
import {
	SystemMessage,
	type SystemMessageOutcome,
} from "../../../../../components/ai-elements/SystemMessage";
import {
	type HydratedMessage,
	useHydratedMessages,
} from "./HydratedMessagesContext";

/**
 * Type-guard for the operation-result metadata shape persisted by
 * `buildOperationResultMessage` (#1412 PR1). System-role messages
 * without this shape fall back to CopilotKit's default render path —
 * we only intercept the rows we know how to render.
 */
function isOperationResultMessage(
	message: AguiMessage,
): message is AguiMessage & {
	metadata: {
		kind: "operation_result";
		outcome: SystemMessageOutcome;
		artifact?: { label: string; url: string };
	};
} {
	const meta = (message as { metadata?: unknown }).metadata as
		| { kind?: unknown; outcome?: unknown }
		| undefined
		| null;
	if (!meta || typeof meta !== "object") {
		return false;
	}
	if (meta.kind !== "operation_result") {
		return false;
	}
	const outcome = meta.outcome;
	return (
		outcome === "success" ||
		outcome === "failure" ||
		outcome === "partial" ||
		outcome === "cancelled"
	);
}

/**
 * Minimal AGUI-compatible message shape. CopilotKit's `RenderMessage`
 * dispatches off the `role` field and is fine with extra fields like
 * `toolCalls` / `attachments` — the renderer in
 * `messages/AssistantMessage` reads them duck-typed.
 *
 * We keep the SSR blob's extra fields intact so attachments / tool
 * calls / status indicators all render correctly through our existing
 * customized assistant message renderer.
 */
type AguiMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
};

function toAguiMessage(raw: HydratedMessage): AguiMessage | null {
	const m = raw as {
		id?: unknown;
		role?: unknown;
		content?: unknown;
	};
	const id = typeof m.id === "string" ? m.id : null;
	const role =
		m.role === "user" || m.role === "assistant" || m.role === "system"
			? m.role
			: null;
	const content = typeof m.content === "string" ? m.content : "";
	if (!id || !role) {
		return null;
	}
	// Spread the full raw blob so downstream renderers can read extra
	// fields (toolCalls, attachments, status, timestamp). The required
	// AGUI fields are explicitly set last to guarantee shape.
	return { ...(raw as object), id, role, content } as AguiMessage;
}

function makeInitialMessages(
	initial: string | string[] | undefined,
): AguiMessage[] {
	if (!initial) {
		return [];
	}
	const arr = Array.isArray(initial) ? initial : [initial];
	return arr.map((message) => ({
		id: message,
		role: "assistant" as const,
		content: message,
	}));
}

/**
 * Same `useScrollToBottom` semantics as the default Messages component
 * (scroll-to-bottom on new user messages, MutationObserver to keep up
 * with streaming token-by-token assistant turns). Lifted verbatim from
 * `@copilotkit/react-ui/.../Messages.tsx` so behavior matches.
 */
function useScrollToBottom(messages: AguiMessage[]) {
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement | null>(null);
	const isProgrammaticScrollRef = useRef(false);
	const isUserScrollUpRef = useRef(false);

	const scrollToBottom = () => {
		if (messagesContainerRef.current && messagesEndRef.current) {
			isProgrammaticScrollRef.current = true;
			messagesContainerRef.current.scrollTop =
				messagesContainerRef.current.scrollHeight;
		}
	};

	const handleScroll = () => {
		if (isProgrammaticScrollRef.current) {
			isProgrammaticScrollRef.current = false;
			return;
		}
		if (messagesContainerRef.current) {
			const { scrollTop, scrollHeight, clientHeight } =
				messagesContainerRef.current;
			isUserScrollUpRef.current = scrollTop + clientHeight < scrollHeight;
		}
	};

	useEffect(() => {
		const container = messagesContainerRef.current;
		if (container) {
			container.addEventListener("scroll", handleScroll);
		}
		return () => {
			if (container) {
				container.removeEventListener("scroll", handleScroll);
			}
		};
	}, []);

	useEffect(() => {
		const container = messagesContainerRef.current;
		if (!container) {
			return;
		}
		const mutationObserver = new MutationObserver(() => {
			if (!isUserScrollUpRef.current) {
				scrollToBottom();
			}
		});
		mutationObserver.observe(container, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => mutationObserver.disconnect();
	}, []);

	// Scroll-to-bottom trigger: re-fire when the number of USER messages
	// grows (a new user send happened). We deliberately don't trigger on
	// assistant messages — those stream in token-by-token and the
	// MutationObserver above already keeps the view at the bottom while
	// they grow. Re-deriving the count in the deps array (rather than
	// from a useMemo) keeps the per-render cost ~O(messages.length) but
	// avoids extra hook overhead for a single integer.
	let userMessageCount = 0;
	for (const m of messages) {
		if (m.role === "user") {
			userMessageCount += 1;
		}
	}
	useEffect(() => {
		isUserScrollUpRef.current = false;
		scrollToBottom();
	}, [userMessageCount]);

	return { messagesEndRef, messagesContainerRef };
}

export const CustomMessages = ({
	inProgress,
	children,
	RenderMessage,
	AssistantMessage,
	UserMessage,
	ErrorMessage,
	ImageRenderer,
	onRegenerate,
	onCopy,
	onThumbsUp,
	onThumbsDown,
	messageFeedback,
	markdownTagRenderers,
	chatError,
}: MessagesProps) => {
	const { labels, icons } = useChatContext();
	const { messages: liveMessages, interrupt } = useCopilotChatInternal();
	const hydrated = useHydratedMessages();

	const initialGreetings = useMemo(
		() => makeInitialMessages(labels.initial),
		[labels.initial],
	);

	// Convert SSR-loaded historical messages to AGUI shape. The context
	// keys its value off `(ssrConversationId, activeConversationId)`, so
	// the result is stable across renders for as long as those ids stay
	// the same. When the user clicks "Start a new conversation" and
	// `activeConversationId` flips away from `ssrConversationId`, the
	// context returns an empty list — this useMemo recomputes to `[]` and
	// the historical section disappears from the rendered list.
	const historicalAgui = useMemo<AguiMessage[]>(() => {
		if (!hydrated) {
			return [];
		}
		const out: AguiMessage[] = [];
		for (const raw of hydrated.historicalMessages) {
			const agui = toAguiMessage(raw);
			if (agui) {
				out.push(agui);
			}
		}
		return out;
	}, [hydrated]);

	// Filter live messages: drop anything whose id is already in the
	// historical set. After the user sends a new turn + persistence
	// fires + the user reloads, the same id appears in BOTH lists; we
	// keep the historical copy (it carries persisted attachments /
	// toolCalls / outcome stamps) and drop the live duplicate.
	const liveFiltered = useMemo(() => {
		if (!hydrated || hydrated.historicalIdSet.size === 0) {
			return liveMessages;
		}
		return liveMessages.filter((m) => {
			const id = (m as { id?: unknown }).id;
			if (typeof id !== "string") {
				return true;
			}
			return !hydrated.historicalIdSet.has(id);
		});
	}, [hydrated, liveMessages]);

	// Final messages list in display order.
	const messages = useMemo(
		() => [...initialGreetings, ...historicalAgui, ...liveFiltered],
		[initialGreetings, historicalAgui, liveFiltered],
	) as Parameters<typeof useScrollToBottom>[0];

	const { messagesContainerRef, messagesEndRef } =
		useScrollToBottom(messages);

	const LoadingIcon = () => <span>{icons.activityIcon}</span>;

	return (
		<div className="copilotKitMessages" ref={messagesContainerRef}>
			<div className="copilotKitMessagesContainer">
				{messages.map((message, index) => {
					const isCurrentMessage = index === messages.length - 1;
					if (
						message.role === "system" &&
						isOperationResultMessage(message)
					) {
						const { outcome, artifact } = message.metadata;
						// Suppress only the redundant SUCCESS card with no
						// artifact link — the agent's own conversational
						// confirmation ("Changes have been applied…") already
						// covers it. Keep the card for failure / partial /
						// cancelled (durable status the success-phrased agent
						// line won't convey) and for any row carrying an
						// artifact link (rendered only here, never in content).
						if (outcome === "success" && !artifact) {
							return null;
						}
						return (
							<SystemMessage
								// biome-ignore lint/suspicious/noArrayIndexKey: same array-order identity rule as the default RenderMessage path below
								key={index}
								outcome={outcome}
								content={message.content}
								artifact={artifact}
							/>
						);
					}
					return (
						<RenderMessage
							// biome-ignore lint/suspicious/noArrayIndexKey: matches CopilotKit's default Messages component — keeps stable per-index identity for the same reasons (messages array order is the identity contract)
							key={index}
							message={message as never}
							messages={messages as never}
							inProgress={inProgress}
							index={index}
							isCurrentMessage={isCurrentMessage}
							AssistantMessage={AssistantMessage}
							UserMessage={UserMessage}
							ImageRenderer={ImageRenderer}
							onRegenerate={onRegenerate}
							onCopy={onCopy}
							onThumbsUp={onThumbsUp}
							onThumbsDown={onThumbsDown}
							messageFeedback={messageFeedback}
							markdownTagRenderers={markdownTagRenderers}
						/>
					);
				})}
				{messages[messages.length - 1]?.role === "user" &&
					inProgress && <LoadingIcon />}
				{interrupt}
				{chatError && ErrorMessage && (
					<ErrorMessage error={chatError} isCurrentMessage />
				)}
			</div>
			<footer className="copilotKitMessagesFooter" ref={messagesEndRef}>
				{children}
			</footer>
		</div>
	);
};
