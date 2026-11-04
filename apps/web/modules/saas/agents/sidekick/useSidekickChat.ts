"use client";

import { HttpAgent, type Message } from "@ag-ui/client";
import { useChat } from "@ai-sdk/react";
import {
	type RuntimeChatTransport,
	useRuntimeChatTransport,
} from "@saas/agents/hooks/useRuntimeChatTransport";
import {
	isAbortError,
	runtimeHeaders,
	runtimePaths,
} from "@saas/agents/lib/direct-runtime-transport";
import {
	SIDEKICK_AGENT_ID,
	SIDEKICK_MODEL_EVENT,
	sidekickModelEventSchema,
	sidekickUiMessages,
} from "@saas/agents/lib/sidekick-runtime-protocol";
import { useEffectiveOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { type ChatStatus, DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidekickFormSnapshot } from "./SidekickFormContext";
import type { SidekickEntityType } from "./SidekickSuggestionsContext";

interface SidekickChatOptions {
	agentId: string;
	entityType: SidekickEntityType;
	organizationId?: string;
	sessionId?: string;
	/** The form as it is now, read when a message is sent. */
	getSnapshot: () => SidekickFormSnapshot;
	onSendSnapshot?: (snapshot: SidekickFormSnapshot) => void;
	onError: (error: unknown) => void;
}

interface SidekickChat {
	messages: UIMessage[];
	status: ChatStatus;
	error: Error | undefined;
	/** Keeps one identity for the hook's lifetime. */
	sendMessage: (message: { text: string }) => void;
	regenerate: () => void | Promise<void>;
	stop: () => void | Promise<void>;
}

/**
 * The Sidekick's conversation over its stream route: the AI SDK's `useChat`,
 * the route's request body built from the freshest form at send time.
 */
function useSidekickRouteChat(options: SidekickChatOptions): SidekickChat {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const { agentId, entityType, organizationId, sessionId } = options;

	// Build transport that adapts the AI SDK message format to the
	// Sidekick streaming route's expected request body.
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api: "/api/agents/sidekick/stream",
				prepareSendMessagesRequest: ({ messages }) => {
					// Send the full AI SDK messages array (preserves tool call structure)
					// plus custom fields the route needs.
					const formSnapshot = optionsRef.current.getSnapshot();
					optionsRef.current.onSendSnapshot?.(formSnapshot);
					return {
						body: {
							agentId,
							entityType,
							...(organizationId !== undefined
								? { organizationId }
								: {}),
							formSnapshot,
							messages,
						},
					};
				},
			}),
		[agentId, entityType, organizationId],
	);

	const { messages, status, sendMessage, error, regenerate, stop } = useChat({
		id: `sidekick-${organizationId ?? "organization"}-${entityType}-${agentId}-${sessionId ?? "default"}`,
		transport,
		onError: (err) => optionsRef.current.onError(err),
	});
	return { messages, status, sendMessage, error, regenerate, stop };
}

/**
 * The Sidekick's conversation over the agent runtime
 * (`sidekick-runtime-protocol.ts`): a headless AG-UI agent on one thread for
 * the panel's lifetime, whose messages (tool calls and results included)
 * every run sends back as the history. A run's refusal or failure reaches
 * `onError` once, as an error with the run's message.
 *
 * The fetch interceptor toasts every refused run from its body
 * (`metadata.fabric`), so the panel gets that body as the error's `cause`
 * only for a usage limit, whose toast both show under one id. Any other body
 * would let the panel's limit toast repeat the interceptor's: a ChatGPT plan
 * to reconnect or a spent one, or the request floor's 429.
 */
function useSidekickRuntimeChat(options: SidekickChatOptions): SidekickChat {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const organizationId = useEffectiveOrganizationId(options.organizationId);
	const [agent] = useState(
		() =>
			new HttpAgent({
				url: runtimePaths(SIDEKICK_AGENT_ID).run,
				headers: runtimeHeaders(organizationId ?? undefined),
				threadId: crypto.randomUUID(),
				agentId: SIDEKICK_AGENT_ID,
			}),
	);
	const [agUi, setAgUi] = useState<Message[]>([]);
	const [status, setStatus] = useState<ChatStatus>("ready");
	const [error, setError] = useState<Error | undefined>(undefined);

	useEffect(() => {
		const subscription = agent.subscribe({
			onMessagesChanged: ({ messages }) => setAgUi([...messages]),
			onCustomEvent: ({ event, messages }) => {
				if (event.name !== SIDEKICK_MODEL_EVENT) {
					return;
				}
				const parsed = sidekickModelEventSchema.safeParse(event.value);
				if (!parsed.success) {
					return;
				}
				return {
					messages: messages.map((message) =>
						parsed.data.messageIds.includes(message.id) &&
						message.role === "assistant"
							? {
									...message,
									metadata: {
										...message.metadata,
										model: parsed.data.model,
									},
								}
							: message,
					),
				};
			},
		});
		// Closing the panel aborts the request, and the runtime stops a turn
		// whose response closed, as the route's `useChat` stopped its fetch.
		return () => {
			subscription.unsubscribe();
			agent.abortRun();
		};
	}, [agent]);

	const runCurrentThread = useCallback(() => {
		setError(undefined);
		setStatus("submitted");
		let reported = false;
		const report = (err: unknown) => {
			if (!reported) {
				reported = true;
				const normalized =
					err instanceof Error ? err : new Error(String(err));
				setError(normalized);
				optionsRef.current.onError(err);
			}
		};
		const { agentId, entityType, getSnapshot, onSendSnapshot } =
			optionsRef.current;
		const formSnapshot = getSnapshot();
		onSendSnapshot?.(formSnapshot);
		agent
			.runAgent(
				{
					forwardedProps: {
						agentId,
						entityType,
						formSnapshot,
					},
				},
				{
					onRunStartedEvent: () => setStatus("streaming"),
					onRunErrorEvent: ({ event }) => {
						// The panel's own abort arrives as a run error coded
						// "abort"; the route's `useChat` stopped silently too.
						if (event.code !== "abort") {
							const usageLimit =
								event.code === "AI_USAGE_LIMIT_EXCEEDED";
							report(
								new Error(event.message, {
									cause: usageLimit
										? event.metadata?.fabric
										: undefined,
								}),
							);
						}
					},
				},
			)
			.catch((err: unknown) => {
				if (!isAbortError(err)) {
					report(err);
				}
			})
			.finally(() => setStatus(reported ? "error" : "ready"));
	}, [agent]);

	const sendMessage = useCallback(
		({ text }: { text: string }) => {
			agent.addMessage({
				id: crypto.randomUUID(),
				role: "user",
				content: text,
			});
			runCurrentThread();
		},
		[agent, runCurrentThread],
	);

	const stop = useCallback(() => {
		agent.abortRun();
		setStatus("ready");
	}, [agent]);

	const regenerate = useCallback(() => {
		runCurrentThread();
	}, [runCurrentThread]);

	const messages = useMemo(() => sidekickUiMessages(agUi), [agUi]);
	return { messages, status, sendMessage, error, regenerate, stop };
}

const TRANSPORT_HOOKS = {
	legacy: useSidekickRouteChat,
	runtime: useSidekickRuntimeChat,
} as const satisfies Record<
	RuntimeChatTransport,
	(options: SidekickChatOptions) => SidekickChat
>;

/**
 * The Sidekick panel's conversation, over the transport chosen when the
 * panel mounts (`COPILOTKIT_SIDEKICK_CHAT`, see `useRuntimeChatTransport`):
 * the same messages, status and `sendMessage` either way, so suggestion
 * cards, reviewed form proposals and the limit toasts read one shape.
 */
export function useSidekickChat(options: SidekickChatOptions): SidekickChat {
	const transport = useRuntimeChatTransport(
		"COPILOTKIT_SIDEKICK_CHAT",
		options.organizationId,
	);
	const useTransportChat = TRANSPORT_HOOKS[transport];
	return useTransportChat(options);
}
