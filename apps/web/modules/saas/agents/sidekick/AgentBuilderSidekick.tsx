"use client";

import { classifyLimitError } from "@repo/ai/limits";
import { AnsweredByModel } from "@saas/agents/components/FabricChat/shared/AnsweredByModel";
import { sidekickAnswerModels } from "@saas/agents/lib/sidekick-runtime-protocol";
import { useLimitToast } from "@saas/ai/hooks/useLimitToast";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { useAutoResizeTextarea } from "@saas/shared/hooks/use-auto-resize-textarea";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import type { UIMessage } from "ai";
import { Loader2Icon, SendIcon, SquareIcon } from "lucide-react";
import {
	memo,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import remarkDirective from "remark-directive";
import { Response } from "../../../../components/ai-elements/response";
import { SidekickSuggestionHost } from "./markdown/SidekickSuggestionHost";
import { sidekickSuggestionDirective } from "./markdown/sidekickSuggestionDirective";
import {
	parseSidekickDraftProposal,
	type SidekickDraftProposal,
} from "./proposals";
import {
	type SidekickFormSnapshot,
	useSidekickForm,
} from "./SidekickFormContext";
import type { SidekickEntityType } from "./SidekickSuggestionsContext";
import { sidekickDisplayText } from "./sidekick-display-text";
import { useSidekickChat } from "./useSidekickChat";

// ---- Types ----

interface AgentBuilderSidekickProps {
	agentId: string;
	entityType?: SidekickEntityType;
	organizationId?: string;
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

/**
 * The conversation fixes its transport when it mounts, from the organization
 * on screen. A full page load is still fetching that organization, so the
 * conversation mounts only once it is known; mounted earlier, it would stay
 * on the stream route for the panel's lifetime.
 */
export function AgentBuilderSidekick(props: AgentBuilderSidekickProps) {
	const { isResolvingOrganization } = useOrganizationContext();
	if (isResolvingOrganization) {
		return (
			<output className="flex h-full items-center justify-center text-muted-foreground">
				<Loader2Icon
					aria-hidden="true"
					className="size-4 motion-safe:animate-spin"
				/>
				<span className="sr-only">Loading Sidekick</span>
			</output>
		);
	}
	return (
		<SidekickConversation
			key={JSON.stringify([
				props.agentId,
				props.entityType,
				props.organizationId,
			])}
			{...props}
		/>
	);
}

function SidekickConversation({
	agentId,
	entityType = "registered",
	organizationId,
}: AgentBuilderSidekickProps) {
	const sidekickForm = useSidekickForm();
	const { getSnapshot } = sidekickForm;
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const sessionId = useId();
	const requestSnapshotRef = useRef<SidekickFormSnapshot | null>(null);
	const [proposals, setProposals] = useState<
		Record<
			string,
			{
				value: SidekickDraftProposal;
				base: SidekickFormSnapshot;
				state: "pending" | "applied" | "dismissed" | "stale";
			}
		>
	>({});

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

	const showLimitToast = useLimitToast();
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const handleChatError = (err: unknown) => {
		// AI usage-limit short-circuit.
		// The Sidekick stream route returns a 429 with
		// `code: "AI_USAGE_LIMIT_EXCEEDED"` when the chokepoint
		// blocks; AI SDK's `useChat` surfaces the JSON body via
		// `error.cause` (newer versions) or as `error` (older).
		// Probe both so the rich payload reaches the shared toast
		// regardless of SDK version, then short-circuit so the
		// generic limit-toast fallback below doesn't double-fire.
		const aiUsageLimitPayload = findAiUsageLimitPayloadFromUseChat(err);
		if (aiUsageLimitPayload) {
			showAiUsageLimitToast(aiUsageLimitPayload);
			return;
		}

		console.error("[AgentBuilderSidekick] Stream error:", err);
		// Surface provider / token-budget limit exhaustion.
		const limitSignal = classifyLimitError(err);
		if (limitSignal) {
			showLimitToast(limitSignal);
		}
	};

	const handleSendSnapshot = useCallback((snapshot: SidekickFormSnapshot) => {
		requestSnapshotRef.current = snapshot;
	}, []);

	// The hooks read the freshest form state and this handler at use time.
	const { messages, status, sendMessage, error, regenerate, stop } =
		useSidekickChat({
			agentId,
			entityType,
			organizationId,
			sessionId,
			getSnapshot,
			onSendSnapshot: handleSendSnapshot,
			onError: handleChatError,
		});

	const isStreaming = status === "streaming" || status === "submitted";

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

	// Keep a ref to the form context so proposal review can access it
	const formCtxRef = useRef(sidekickForm);
	formCtxRef.current = sidekickForm;

	// Responses may propose changes. Never treat model output as permission to edit.
	const inspectedMessagesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (isStreaming) {
			return;
		}
		for (const message of messages) {
			if (
				message.role !== "assistant" ||
				inspectedMessagesRef.current.has(message.id)
			) {
				continue;
			}
			const text =
				message.parts
					?.map((part) => {
						if (part.type === "text") {
							return part.text;
						}
						if (
							part.type.startsWith("tool-") &&
							"output" in part &&
							typeof part.output === "string"
						) {
							return part.output;
						}
						return "";
					})
					.join("") ?? "";
			if (!text) {
				continue;
			}
			inspectedMessagesRef.current.add(message.id);
			const value = parseSidekickDraftProposal(text);
			if (value) {
				const base =
					requestSnapshotRef.current ??
					formCtxRef.current.getSnapshot();
				setProposals((previous) => ({
					...previous,
					[message.id]: { value, base, state: "pending" },
				}));
			}
		}
	}, [messages, isStreaming]);

	function applyProposal(messageId: string) {
		const proposal = proposals[messageId];
		if (!proposal || proposal.state !== "pending" || isStreaming) {
			return;
		}
		const current = formCtxRef.current.getSnapshot();
		const { value, base } = proposal;
		const stale =
			(value.instructions &&
				(current.systemPromptHtml !== base.systemPromptHtml ||
					current.systemPromptMarkdown !==
						base.systemPromptMarkdown)) ||
			(value.name && current.name !== base.name) ||
			(value.description && current.description !== base.description) ||
			(value.tools.length > 0 &&
				JSON.stringify(current.tools) !== JSON.stringify(base.tools));
		if (stale) {
			setProposals((previous) => ({
				...previous,
				[messageId]: { ...proposal, state: "stale" },
			}));
			return;
		}
		if (value.instructions) {
			formCtxRef.current.setFormField(
				"systemPromptHtml",
				() => value.instructions?.html ?? "",
			);
			formCtxRef.current.setFormField(
				"systemPromptMarkdown",
				() => value.instructions?.text ?? "",
			);
		}
		if (value.name) {
			formCtxRef.current.setFormField("name", () => value.name);
		}
		if (value.description) {
			formCtxRef.current.setFormField(
				"description",
				() => value.description,
			);
		}
		if (value.tools.length) {
			formCtxRef.current.setFormField("tools", (previous) => {
				let tools = Array.isArray(previous)
					? ([...previous] as Array<{ id: string; name: string }>)
					: [];
				for (const tool of value.tools) {
					if (tool.action === "remove") {
						tools = tools.filter(
							(entry) => entry.id !== tool.toolId,
						);
					} else if (
						!tools.some((entry) => entry.id === tool.toolId)
					) {
						tools.push({ id: tool.toolId, name: tool.toolName });
					}
				}
				return tools;
			});
		}
		setProposals((previous) => ({
			...previous,
			[messageId]: { ...proposal, state: "applied" },
		}));
	}

	// Input state
	const [inputValue, setInputValue] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// 192px is the textarea's `max-h-48` class; keep the two in step.
	useAutoResizeTextarea(inputRef, inputValue, 192);

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
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			{/* Messages area */}
			<div
				role="log"
				aria-label="Sidekick conversation"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: The independently scrolling conversation must be keyboard reachable.
				tabIndex={0}
				ref={scrollContainerRef}
				className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
			>
				{messages.length === 0 && !isStreaming && (
					<div className="space-y-4">
						<p className="text-sm font-medium">Sidekick</p>
						<p className="max-w-prose text-sm leading-relaxed">
							What would you like this agent to do? I can help
							refine its instructions, suggest tools, or review
							its setup.
						</p>
						<p className="text-xs text-muted-foreground">
							You review changes before applying them to your
							draft.
						</p>
						<div className="flex flex-wrap gap-2">
							{[
								[
									"Improve instructions",
									"Review my current instructions and propose a clearer, complete version. Preserve the agent's purpose and explain the changes.",
								],
								[
									"Review tools and access",
									"Review the tools selected for this agent. Explain what is missing or unnecessary and propose only tools available to me. Do not claim access is granted before I accept a suggestion.",
								],
							].map(([label, prompt]) => (
								<Button
									key={label}
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										setInputValue(prompt);
										inputRef.current?.focus();
									}}
								>
									{label}
								</Button>
							))}
						</div>
					</div>
				)}

				<div className="space-y-4">
					{messages.map((msg) => (
						<div key={msg.id} className="space-y-3">
							<MessageBubble
								message={msg}
								remarkPlugins={remarkPlugins}
								markdownComponents={markdownComponents}
							/>
							{proposals[msg.id] &&
								proposals[msg.id].state !== "dismissed" && (
									<Alert>
										<AlertTitle>
											Review suggested changes
										</AlertTitle>
										<AlertDescription className="space-y-2">
											{proposals[msg.id].value.name && (
												<p>
													Name:{" "}
													{
														proposals[msg.id].value
															.name
													}
												</p>
											)}
											{proposals[msg.id].value
												.description && (
												<p>
													Description:{" "}
													{
														proposals[msg.id].value
															.description
													}
												</p>
											)}
											{proposals[msg.id].value
												.instructions && (
												<details>
													<summary>
														Review proposed
														instructions
													</summary>
													<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
														{
															proposals[msg.id]
																.value
																.instructions
																?.text
														}
													</pre>
												</details>
											)}
											{proposals[msg.id].value.tools
												.length > 0 && (
												<>
													<p>
														These changes affect the
														tools this agent can
														use. Review each
														addition or removal.
													</p>
													<ul className="list-disc space-y-1 pl-4">
														{proposals[
															msg.id
														].value.tools.map(
															(tool, index) => (
																<li
																	key={`${tool.toolId}-${index}`}
																>
																	{tool.action ===
																	"add"
																		? "Add"
																		: "Remove"}
																	:{" "}
																	{
																		tool.toolName
																	}{" "}
																	<span className="break-all">
																		(
																		{
																			tool.toolId
																		}
																		)
																	</span>
																</li>
															),
														)}
													</ul>
												</>
											)}
											{proposals[msg.id].state ===
												"pending" && (
												<div className="flex flex-wrap gap-2">
													<Button
														size="sm"
														type="button"
														disabled={isStreaming}
														onClick={() =>
															applyProposal(
																msg.id,
															)
														}
													>
														Apply suggested changes
													</Button>
													<Button
														size="sm"
														variant="outline"
														type="button"
														onClick={() =>
															setProposals(
																(previous) => ({
																	...previous,
																	[msg.id]: {
																		...previous[
																			msg
																				.id
																		],
																		state: "dismissed",
																	},
																}),
															)
														}
													>
														Dismiss changes
													</Button>
												</div>
											)}
											{proposals[msg.id].state ===
												"applied" && (
												<output className="block">
													Changes applied to the
													draft. Save the agent to
													retain them.
												</output>
											)}
											{proposals[msg.id].state ===
												"stale" && (
												<output className="block">
													The configuration changed.
													Request a new suggestion to
													keep your edits.
												</output>
											)}
										</AlertDescription>
									</Alert>
								)}
						</div>
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
				{error && !isStreaming && (
					<Alert variant="error" className="mx-3 mb-3 w-auto">
						<AlertTitle>Sidekick could not respond</AlertTitle>
						<AlertDescription className="space-y-2">
							<p>
								Your agent draft is preserved. Retry the
								response or send a new request.
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void regenerate()}
							>
								Retry response
							</Button>
						</AlertDescription>
					</Alert>
				)}
			</div>
			{/* Input area */}
			{isStreaming && (
				<div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
					<output className="text-xs text-muted-foreground">
						Sidekick is responding…
					</output>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void stop()}
					>
						<SquareIcon className="size-3" /> Stop response
					</Button>
				</div>
			)}
			<div className="shrink-0 border-t border-border bg-card p-3">
				<form onSubmit={handleSubmit} className="flex items-end gap-2">
					<Textarea
						ref={inputRef}
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Ask Sidekick for suggestions..."
						disabled={isStreaming}
						className="max-h-48 min-h-[80px] min-w-0 flex-1 resize-none"
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
	const textContent =
		message.role === "assistant"
			? sidekickDisplayText(getTextContent(message))
			: getTextContent(message);

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
				{sidekickAnswerModels(message.metadata).map((model) => (
					<AnsweredByModel
						key={`${model.provider}:${model.id}:${model.viaPlan}`}
						model={model}
					/>
				))}
			</div>
		</div>
	);
});
