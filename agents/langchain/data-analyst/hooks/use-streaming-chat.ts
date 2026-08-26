import { useState, useCallback } from "react";
import type { UIMessage } from "ai";
import type { UIMessagePart } from "@/lib/types";

export function useStreamingChat() {
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [status, setStatus] = useState<
		"idle" | "submitted" | "streaming" | "error"
	>("idle");
	const [error, setError] = useState<Error | null>(null);

	const sendMessage = useCallback(
		async (
			input: string | { text: string },
			options?: { body: Record<string, unknown> },
		) => {
			const text = typeof input === "string" ? input : input.text;

			const userMessage: UIMessage = {
				id: `msg-${Date.now()}-user`,
				role: "user",
				parts: [{ type: "text", text }],
			};

			setMessages((prev) => [...prev, userMessage]);
			setStatus("streaming");
			setError(null);

			try {
				const response = await fetch("/api/chat", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						messages: [...messages, userMessage],
						...options?.body,
					}),
				});

				if (!response.ok) {
					throw new Error(`API error: ${response.statusText}`);
				}

				let fullText = "";
				const parts: UIMessagePart[] = [];
				let currentBuffer = "";
				let currentTextDelta = ""; // Accumulate text deltas
				let assistantMessage: UIMessage | null = null;
				let lastUpdateTime = Date.now();
				let streamFinished = false;
				let showHourglassUi = false;

				const reader = response.body?.getReader();
				if (!reader) throw new Error("No response body");

				const decoder = new TextDecoder();

				while (!streamFinished) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}

					currentBuffer += decoder.decode(value, { stream: true });

					// Parse newline-delimited JSON (Claude Agents format)
					const lines = currentBuffer.split("\n");
					currentBuffer = lines[lines.length - 1]; // Keep incomplete line in buffer

					for (let i = 0; i < lines.length - 1; i++) {
						const line = lines[i].trim();
						if (!line) continue;

						try {
							const parsed = JSON.parse(line);

							// Check for final event - Claude Agent SDK doesn't close the stream properly
							if (parsed.type === "final") {
								streamFinished = true;
								break;
							}

							if (parsed.type === "status") {
								// Skip status messages - we'll create the message when we get actual content
							} else if (parsed.type === "text_delta") {
								// If a tool just showed hourglass, add newlines to separate the tool from text
								if (showHourglassUi) {
									fullText += "\n\n";
									showHourglassUi = false;
									// Reset delta counter since we're starting fresh text after the tool
									currentTextDelta = "";
									lastUpdateTime = Date.now();
								}

								// Accumulate streaming text deltas
								currentTextDelta += parsed.content;
								fullText += parsed.content;

								// Create assistant message on first text delta if needed
								if (!assistantMessage) {
									assistantMessage = {
										id: `msg-${Date.now()}-assistant`,
										role: "assistant",
										parts: [
											{ type: "text", text: fullText },
										],
									};
									setMessages((prev) => [
										...prev,
										assistantMessage!,
									]);
									lastUpdateTime = Date.now(); // Reset timer after creating message
								} else if (
									Date.now() - lastUpdateTime > 200 ||
									currentTextDelta.length > 100
								) {
									// Update UI every 200ms or when buffer gets large
									const updatedMessage: UIMessage = {
										...assistantMessage,
										parts: [
											{ type: "text", text: fullText },
										],
									};
									setMessages((prev) => {
										const updated = [...prev];
										updated[updated.length - 1] =
											updatedMessage;
										return updated;
									});
									lastUpdateTime = Date.now();
									currentTextDelta = ""; // Reset for next threshold
								}
							} else if (parsed.type === "text") {
								// Complete text block - only add if we haven't been streaming
								// (text_delta already adds content, so this would duplicate it)
								if (!assistantMessage) {
									fullText += parsed.content;
								}
								parts.push({
									type: "text",
									text: parsed.content,
								});
							} else if (parsed.type === "text_start") {
								// Reset delta for new text block
								currentTextDelta = "";
							} else if (parsed.type === "content_block_stop") {
								// Block finished - add accumulated text if any
								if (currentTextDelta) {
									parts.push({
										type: "text",
										text: currentTextDelta,
									});
									currentTextDelta = "";
								}
							} else if (parsed.type === "tool_use") {
								parts.push({
									type: "tool-invocation",
									toolCallId:
										parsed.id || `tool-${Date.now()}`,
									toolName: parsed.name,
									args: parsed.input || {},
									state: "input-available",
								});
							} else if (parsed.type === "tool_use_start") {
								// Tool is being invoked - show loading indicator
								showHourglassUi = true;
								if (assistantMessage) {
									setMessages((prev) => {
										const updated = [...prev];
										if (
											updated.length > 0 &&
											assistantMessage
										) {
											updated[updated.length - 1] = {
												id: assistantMessage.id,
												role: "assistant",
												parts: [
													{
														type: "text",
														text: fullText + " ⏳",
													},
												],
											} as UIMessage;
										}
										return updated;
									});
								}
								parts.push({
									type: "tool-invocation",
									toolCallId:
										parsed.id || `tool-${Date.now()}`,
									toolName: parsed.name,
									args: {},
									state: "input-available",
								});
							} else if (parsed.type === "tool_result") {
								// Tool result - just accumulate the content
								fullText += parsed.content + "\n";
							} else if (parsed.type === "error") {
								throw new Error(parsed.content);
							}
						} catch (parseErr) {
							// Not JSON, treat as plain text (OpenAI/LangChain format)
							fullText += line + "\n";
							parts.push({ type: "text", text: line + "\n" });
						}
					}
				}

				// Process remaining buffer (if any incomplete JSON left)
				if (currentBuffer.trim()) {
					try {
						const parsed = JSON.parse(currentBuffer);
						if (parsed.type === "text_delta") {
							fullText += parsed.content;
						} else if (parsed.type === "error") {
							throw new Error(parsed.content);
						}
					} catch {
						// Ignore parse errors for incomplete buffer
					}
				}

				// Final UI update to ensure all content is displayed
				if (assistantMessage) {
					const finalMessage: UIMessage = {
						...assistantMessage,
						parts: [{ type: "text", text: fullText }],
					};
					setMessages((prev) => {
						const updated = [...prev];
						updated[updated.length - 1] = finalMessage;
						return updated;
					});
				} else if (fullText) {
					// Fallback: create message if we never got text deltas
					const finalMessage: UIMessage = {
						id: `msg-${Date.now()}-assistant`,
						role: "assistant",
						parts: [{ type: "text", text: fullText }],
					};
					setMessages((prev) => [...prev, finalMessage]);
				}
				setStatus("idle");
			} catch (err) {
				const error =
					err instanceof Error ? err : new Error("Unknown error");
				setError(error);
				setStatus("error");
			}
		},
		[messages],
	);

	return {
		messages,
		sendMessage,
		status,
		error,
		setMessages,
	};
}
