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
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { type ChatStatus, DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidekickFormSnapshot } from "./SidekickFormContext";
import type { SidekickEntityType } from "./SidekickSuggestionsContext";

interface SidekickChatOptions {
	agentId: string;
	entityType: SidekickEntityType;
	/** The form as it is now, read when a message is sent. */
	getSnapshot: () => SidekickFormSnapshot;
	onError: (error: unknown) => void;
}

interface SidekickChat {
	messages: UIMessage[];
	status: ChatStatus;
	/** Keeps one identity for the hook's lifetime. */
	sendMessage: (message: { text: string }) => void;
}

/**
 * The Sidekick's conversation over its stream route: the AI SDK's `useChat`,
 * the route's request body built from the freshest form at send time.
 */
function useSidekickRouteChat(options: SidekickChatOptions): SidekickChat {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const { agentId, entityType } = options;

	// Build transport that adapts the AI SDK message format to the
	// Sidekick streaming route's expected request body.
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api: "/api/agents/sidekick/stream",
				prepareSendMessagesRequest: ({ messages }) => {
					// Send the full AI SDK messages array (preserves tool call structure)
					// plus custom fields the route needs.
					return {
						body: {
							agentId,
							entityType,
							formSnapshot: optionsRef.current.getSnapshot(),
							messages,
						},
					};
				},
			}),
		[agentId, entityType],
	);

	const { messages, status, sendMessage } = useChat({
		id: `sidekick-${agentId}`,
		transport,
		onError: (error) => optionsRef.current.onError(error),
	});
	return { messages, status, sendMessage };
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
	const { organizationId } = useOrganizationContext();
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

	const sendMessage = useCallback(
		({ text }: { text: string }) => {
			agent.addMessage({
				id: crypto.randomUUID(),
				role: "user",
				content: text,
			});
			setStatus("submitted");
			let reported = false;
			const report = (error: unknown) => {
				if (!reported) {
					reported = true;
					optionsRef.current.onError(error);
				}
			};
			const { agentId, entityType, getSnapshot } = optionsRef.current;
			agent
				.runAgent(
					{
						forwardedProps: {
							agentId,
							entityType,
							formSnapshot: getSnapshot(),
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
				.catch((error: unknown) => {
					if (!isAbortError(error)) {
						report(error);
					}
				})
				.finally(() => setStatus(reported ? "error" : "ready"));
		},
		[agent],
	);

	const messages = useMemo(() => sidekickUiMessages(agUi), [agUi]);
	return { messages, status, sendMessage };
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
 * cards, form auto-apply and the limit toasts read one shape.
 */
export function useSidekickChat(options: SidekickChatOptions): SidekickChat {
	const transport = useRuntimeChatTransport("COPILOTKIT_SIDEKICK_CHAT");
	const useTransportChat = TRANSPORT_HOOKS[transport];
	return useTransportChat(options);
}
