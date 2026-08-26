"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import { classifyLimitError } from "@repo/ai/limits";
import { useLimitToast } from "@saas/ai/hooks/useLimitToast";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { DefaultChatTransport } from "ai";
import { Loader2Icon, SendIcon, SparklesIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import remarkDirective from "remark-directive";
import { Response } from "../../../../components/ai-elements/response";
import { SidekickSuggestionHost } from "./markdown/SidekickSuggestionHost";
import { sidekickSuggestionDirective } from "./markdown/sidekickSuggestionDirective";
import { useSidekickForm } from "./SidekickFormContext";
import type { SidekickEntityType } from "./SidekickSuggestionsContext";

// ---- Types ----

interface AgentBuilderSidekickProps {
	agentId: string;
	entityType?: SidekickEntityType;
}

/**
 * Pull the structured `AI_USAGE_LIMIT_EXCEEDED` payload out of an AI SDK
 * `useChat` `onError` argument.
 * The SDK can surface the wire JSON in a few different shapes depending
 * on version (`error.cause`, plain `error`, or as a stringified message
 * the consumer would have to parse); we probe each candidate before
 * falling through. Returns `null` when nothing matches.
 */
function findAiUsageLimitPayloadFromUseChat(
	error: unknown,
): AiUsageLimitExceededPayload | null {
	const candidates: unknown[] = [
		(error as { cause?: { data?: unknown } } | undefined)?.cause?.data,
		(error as { cause?: unknown } | undefined)?.cause,
		(error as { data?: unknown } | undefined)?.data,
		error,
	];

	for (const candidate of candidates) {
		const code = (candidate as { code?: unknown } | undefined)?.code;
		const data = (candidate as { data?: unknown } | undefined)?.data;
		if (code === "AI_USAGE_LIMIT_EXCEEDED") {
			if (isAiUsageLimitExceededPayload(data)) {
				return data;
			}
			if (isAiUsageLimitExceededPayload(candidate)) {
				return candidate;
			}
		}
		if (isAiUsageLimitExceededPayload(candidate)) {
			return candidate;
		}
	}

	// Last-resort: the SDK sometimes surfaces a JSON-string `message`.
	const msg = (error as { message?: unknown } | undefined)?.message;
	if (typeof msg === "string" && msg.includes("AI_USAGE_LIMIT_EXCEEDED")) {
		try {
			const parsed = JSON.parse(msg) as {
				code?: unknown;
				data?: unknown;
			};
			if (parsed?.code === "AI_USAGE_LIMIT_EXCEEDED") {
				if (isAiUsageLimitExceededPayload(parsed.data)) {
					return parsed.data;
				}
				if (isAiUsageLimitExceededPayload(parsed)) {
					return parsed as unknown as AiUsageLimitExceededPayload;
				}
			}
		} catch {
			// Not JSON — give up gracefully.
		}
	}
	return null;
}

// ---- Component ----

export function AgentBuilderSidekick({
	agentId,
	entityType = "registered",
}: AgentBuilderSidekickProps) {
	const sidekickForm = useSidekickForm();
	const { getSnapshot } = sidekickForm;
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const hasAutoStartedRef = useRef(false);

	// Store the getSnapshot function ref so the transport reads the
	// freshest form state lazily at send time (not on every render).
	const getSnapshotRef = useRef(getSnapshot);
	getSnapshotRef.current = getSnapshot;

	// Memoized remark plugins array — stable reference to avoid unnecessary
	// re-renders of the Response component.
	const remarkPlugins = useMemo(
		() => [remarkDirective, sidekickSuggestionDirective],
		[],
	);

	// Memoized components map for Response.
	const markdownComponents = useMemo(
		() => ({ "agent-suggestion": SidekickSuggestionHost }),
		[],
	);

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
							formSnapshot: getSnapshotRef.current(),
							messages,
						},
					};
				},
			}),
		[agentId, entityType],
	);

	const showLimitToast = useLimitToast();
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const { messages, status, sendMessage } = useChat({
		id: `sidekick-${agentId}`,
		transport,
		onError: (error) => {
			// AI usage-limit short-circuit.
			// The Sidekick stream route returns a 429 with
			// `code: "AI_USAGE_LIMIT_EXCEEDED"` when the chokepoint
			// blocks; AI SDK's `useChat` surfaces the JSON body via
			// `error.cause` (newer versions) or as `error` (older).
			// Probe both so the rich payload reaches the shared toast
			// regardless of SDK version, then short-circuit so the
			// generic limit-toast fallback below doesn't double-fire.
			const aiUsageLimitPayload =
				findAiUsageLimitPayloadFromUseChat(error);
			if (aiUsageLimitPayload) {
				showAiUsageLimitToast(aiUsageLimitPayload);
				return;
			}

			console.error("[AgentBuilderSidekick] Stream error:", error);
			// Surface provider / token-budget limit exhaustion.
			const limitSignal = classifyLimitError(error);
			if (limitSignal) {
				showLimitToast(limitSignal);
			}
		},
	});

	const isStreaming = status === "streaming" || status === "submitted";

	// Auto-start: send the opening message on mount
	useEffect(() => {
		if (hasAutoStartedRef.current || messages.length > 0) {
			return;
		}
		hasAutoStartedRef.current = true;

		// Small delay to let the form data settle
		const isNewAgent = agentId === "new";
		const openingMessage = isNewAgent
			? "I want to create a new agent. Help me get started."
			: "Help me improve this agent";
		const timer = setTimeout(() => {
			sendMessage({ text: openingMessage });
		}, 500);
		return () => clearTimeout(timer);
	}, [messages.length, sendMessage]);

	// Auto-scroll to bottom when new messages arrive
	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) {
			return;
		}

		// Only auto-scroll if user is near the bottom
		const threshold = 150;
		const isNearBottom =
			container.scrollHeight -
				container.scrollTop -
				container.clientHeight <
			threshold;

		if (isNearBottom) {
			container.scrollTo({
				top: container.scrollHeight,
				behavior: "smooth",
			});
		}
	}, [messages]);

	// Keep a ref to the form context so auto-apply can access it
	const formCtxRef = useRef(sidekickForm);
	formCtxRef.current = sidekickForm;

	// Auto-apply: when Sidekick returns instructions for new agents,
	// extract <sidekick_apply_*> from tool results and apply to the form.
	// Tracks all inspected message IDs (not just applied) to avoid rescanning.
	const inspectedMessagesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (isStreaming) {
			return;
		}

		for (const msg of messages) {
			if (msg.role !== "assistant") {
				continue;
			}
			if (inspectedMessagesRef.current.has(msg.id)) {
				continue;
			}
			if (!msg.parts) {
				continue;
			}

			// Collect all text from text parts and tool output parts
			let fullText = "";
			for (const part of msg.parts) {
				if (part.type === "text" && "text" in part) {
					fullText += part.text;
				} else if (
					typeof part.type === "string" &&
					part.type.startsWith("tool-")
				) {
					// AI SDK v6: tool parts use `output` property for results
					const p = part as Record<string, unknown>;
					if (typeof p.output === "string") {
						fullText += p.output;
					}
				}
			}

			if (!fullText) {
				// Don't mark as inspected — tool outputs may arrive later
				continue;
			}

			// Auto-apply instructions
			const instrMatch = fullText.match(
				/<sidekick_apply_instructions>\n([\s\S]*?)\n<\/sidekick_apply_instructions>/,
			);
			if (instrMatch?.[1]) {
				const htmlContent = instrMatch[1];
				const plainText = htmlContent
					.replace(
						/<\/?(h[1-6]|p|div|ul|ol|li|strong|em|code|pre|blockquote)[^>]*>/gi,
						"\n",
					)
					.replace(/<br\s*\/?>/gi, "\n")
					.replace(/<[^>]+>/g, "")
					.replace(/&amp;/g, "&")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&quot;/g, '"')
					.replace(/\n{3,}/g, "\n\n")
					.trim();
				// Update both fields: systemPromptHtml drives the TipTap
				// editor content, systemPromptMarkdown is the plain-text
				// fallback used by the form snapshot.
				formCtxRef.current?.setFormField(
					"systemPromptHtml",
					() => htmlContent,
				);
				formCtxRef.current?.setFormField(
					"systemPromptMarkdown",
					() => plainText,
				);
			}

			// Auto-apply tools (knowledge sources, capabilities, MCP servers)
			// All tool types use the same tools array as {id, name} objects
			// to match the BuilderFormData.tools shape. Handles both add and
			// remove — instance editing surfaces both shapes via Sidekick.
			const toolsMatch = fullText.match(
				/<sidekick_apply_tools>\n([\s\S]*?)\n<\/sidekick_apply_tools>/,
			);
			if (toolsMatch?.[1]) {
				try {
					const suggestions = JSON.parse(toolsMatch[1]) as Array<{
						action: "add" | "remove";
						toolId: string;
						toolName: string;
					}>;
					for (const s of suggestions) {
						if (s.action === "add") {
							const toolEntry = {
								id: s.toolId,
								name: s.toolName || s.toolId,
							};
							formCtxRef.current?.setFormField(
								"tools",
								(prev: unknown) => {
									const arr =
										(prev as Array<{
											id: string;
											name: string;
										}>) ?? [];
									if (
										arr.some((t) => t.id === toolEntry.id)
									) {
										return arr;
									}
									return [...arr, toolEntry];
								},
							);
						} else if (s.action === "remove") {
							formCtxRef.current?.setFormField(
								"tools",
								(prev: unknown) => {
									const arr =
										(prev as Array<{
											id: string;
											name: string;
										}>) ?? [];
									return arr.filter((t) => t.id !== s.toolId);
								},
							);
						}
					}
				} catch {
					// JSON parse failed — skip
				}
			}

			// Auto-apply name and description
			const metaMatch = fullText.match(
				/<sidekick_apply_metadata>\n([\s\S]*?)\n<\/sidekick_apply_metadata>/,
			);
			if (metaMatch?.[1]) {
				try {
					const meta = JSON.parse(metaMatch[1]) as {
						name?: string;
						description?: string;
					};
					if (meta.name) {
						formCtxRef.current?.setFormField(
							"name",
							() => meta.name as string,
						);
					}
					if (meta.description) {
						formCtxRef.current?.setFormField(
							"description",
							() => meta.description as string,
						);
					}
				} catch {
					// JSON parse failed — skip
				}
			}

			// Mark as inspected regardless of whether we applied anything,
			// so we never rescan this message.
			inspectedMessagesRef.current.add(msg.id);
		}
	}, [messages, isStreaming]);

	// Input state
	const [inputValue, setInputValue] = useState("");

	const handleSubmit = useCallback(
		(e?: React.FormEvent) => {
			e?.preventDefault();
			const trimmed = inputValue.trim();
			if (!trimmed || isStreaming) {
				return;
			}

			sendMessage({ text: trimmed });
			setInputValue("");
		},
		[inputValue, isStreaming, sendMessage],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit],
	);

	return (
		<div className="flex h-full flex-col">
			{/* Messages area */}
			<div
				ref={scrollContainerRef}
				className="flex-1 overflow-y-auto px-4 py-4"
			>
				{messages.length === 0 && !isStreaming && (
					<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
						<SparklesIcon className="size-8 text-muted-foreground/50" />
						<div>
							<p className="text-sm font-medium text-foreground">
								Sidekick
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								AI assistant to help you build and refine your
								agent configuration.
							</p>
						</div>
					</div>
				)}

				<div className="space-y-4">
					{messages.map((msg) => (
						<MessageBubble
							key={msg.id}
							message={msg}
							remarkPlugins={remarkPlugins}
							markdownComponents={markdownComponents}
						/>
					))}

					{isStreaming &&
						messages.length > 0 &&
						messages[messages.length - 1]?.role === "user" && (
							<div className="flex items-center gap-2 py-2">
								<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
								<span className="text-xs text-muted-foreground">
									Thinking...
								</span>
							</div>
						)}
				</div>
			</div>

			{/* Input area */}
			<div className="border-t border-border bg-card p-3">
				<form onSubmit={handleSubmit} className="flex items-end gap-2">
					<Textarea
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Ask Sidekick for suggestions..."
						disabled={isStreaming}
						className="max-h-48 min-h-[80px] flex-1 resize-none"
						rows={3}
						aria-label="Message Sidekick"
					/>
					<Button
						type="submit"
						size="icon"
						variant="default"
						disabled={isStreaming || !inputValue.trim()}
						aria-label="Send message"
						className="shrink-0"
					>
						{isStreaming ? (
							<Loader2Icon className="size-4 animate-spin" />
						) : (
							<SendIcon className="size-4" />
						)}
					</Button>
				</form>
			</div>
		</div>
	);
}

// ---- Helpers ----

function getTextContent(message: UIMessage): string {
	return (
		message.parts
			?.filter((p) => p.type === "text")
			.map((p) => ("text" in p ? p.text : ""))
			.join("\n") ?? ""
	);
}

// ---- Message bubble ----

const MessageBubble = memo(function MessageBubble({
	message,
	remarkPlugins,
	markdownComponents,
}: {
	message: UIMessage;
	remarkPlugins: NonNullable<
		React.ComponentProps<typeof Response>["remarkPlugins"]
	>;
	markdownComponents: Record<string, React.ComponentType<any>>;
}) {
	const textContent = getTextContent(message);

	if (message.role === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
					{textContent}
				</div>
			</div>
		);
	}

	return (
		<div className="flex justify-start">
			<div className="max-w-[95%]">
				<Response
					remarkPlugins={remarkPlugins}
					components={markdownComponents}
					streaming
				>
					{textContent}
				</Response>
			</div>
		</div>
	);
});
