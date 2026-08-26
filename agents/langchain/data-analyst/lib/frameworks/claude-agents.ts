import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

interface StreamMessage {
	type: string;
	message?: {
		content: Array<{
			type: string;
			text?: string;
			name?: string;
			input?: any;
		}>;
	};
	result?: string;
	thinking?: string;
	event?: any;
}

export async function handleClaudeAgentsFramework(
	mcpUrl: string,
	mcpHeaders: Record<string, string> | undefined,
	messages: unknown[],
	systemPrompt: string,
	_chatId?: string, // Not used in V1 - history is passed in prompt
	model?: string,
): Promise<ReadableStream<string>> {
	// Extract model name from "anthropic/claude-xxx" format
	const modelId = model?.startsWith("anthropic/")
		? model.replace("anthropic/", "")
		: model || "claude-sonnet-4-5-20250929";

	const options: Options = {
		model: modelId,
		systemPrompt,
		mcpServers: {
			fabric: {
				type: "http",
				url: mcpUrl,
				headers: mcpHeaders || {},
			},
		},
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		maxTurns: 10,
	};

	// Build prompt with chat history
	let userPrompt = "";

	if (Array.isArray(messages) && messages.length > 0) {
		// Include previous messages as context
		const conversationHistory: string[] = [];

		for (const msg of messages) {
			if (msg && typeof msg === "object") {
				const role = (msg as any).role;
				let text = "";

				if ("content" in msg) {
					text = (msg as any).content as string;
				} else if (
					"parts" in msg &&
					Array.isArray((msg as any).parts)
				) {
					const textParts = ((msg as any).parts as any[]).filter(
						(p) => p.type === "text",
					);
					text = textParts.map((p) => p.text).join("");
				}

				if (text && role) {
					if (role === "user") {
						conversationHistory.push(`User: ${text}`);
					} else if (role === "assistant") {
						conversationHistory.push(`Assistant: ${text}`);
					}
				}
			}
		}

		// If there's history, include it in the prompt
		if (conversationHistory.length > 1) {
			userPrompt = `Previous conversation:\n${conversationHistory.slice(0, -1).join("\n\n")}\n\nCurrent request:\n${conversationHistory[conversationHistory.length - 1]?.replace("User: ", "") || ""}`;
		} else if (conversationHistory.length === 1) {
			userPrompt = conversationHistory[0]?.replace("User: ", "") || "";
		}
	}

	if (!userPrompt.trim()) {
		throw new Error("No user message provided");
	}

	// Create a readable stream for streaming responses
	return new ReadableStream({
		async start(controller) {
			try {
				controller.enqueue(
					JSON.stringify({
						type: "status",
						content: "Processing with Claude Agent SDK...",
					}) + "\n",
				);

				for await (const stream of query({
					prompt: userPrompt,
					options,
				})) {
					const streamMessage = stream as StreamMessage;

					if (streamMessage.type === "stream_event") {
						const event = streamMessage.event;
						if (
							event?.type === "content_block_delta" &&
							event?.delta?.type === "text_delta"
						) {
							controller.enqueue(
								JSON.stringify({
									type: "text_delta",
									content: event.delta.text,
								}) + "\n",
							);
						} else if (event?.type === "content_block_start") {
							const block = event?.content_block;
							if (block?.type === "text") {
								controller.enqueue(
									JSON.stringify({
										type: "text_start",
										id: event.index,
									}) + "\n",
								);
							} else if (block?.type === "tool_use") {
								controller.enqueue(
									JSON.stringify({
										type: "tool_use_start",
										id: block.id,
										name: block.name,
									}) + "\n",
								);
							}
						} else if (event?.type === "content_block_stop") {
							controller.enqueue(
								JSON.stringify({
									type: "content_block_stop",
									index: event.index,
								}) + "\n",
							);
						}
					} else if (streamMessage.type === "assistant") {
						const blocks = streamMessage.message?.content;
						if (Array.isArray(blocks)) {
							for (const block of blocks) {
								if (block.type === "text" && block.text) {
									controller.enqueue(
										JSON.stringify({
											type: "text",
											content: block.text,
										}) + "\n",
									);
								} else if (block.type === "tool_use") {
									controller.enqueue(
										JSON.stringify({
											type: "tool_use",
											name: block.name,
											id: (block as any).id,
											input: block.input,
										}) + "\n",
									);
								}
							}
						}
					} else if (streamMessage.type === "tool_result") {
						const toolResultBlocks = streamMessage.message?.content;
						if (Array.isArray(toolResultBlocks)) {
							for (const block of toolResultBlocks) {
								if (block.type === "text" && block.text) {
									controller.enqueue(
										JSON.stringify({
											type: "tool_result",
											content: block.text,
										}) + "\n",
									);
								}
							}
						}
					} else if (streamMessage.type === "result") {
						if (typeof streamMessage.result === "string") {
							controller.enqueue(
								JSON.stringify({
									type: "final",
									content: streamMessage.result,
								}) + "\n",
							);
						}
					} else if (streamMessage.type === "thinking") {
						if (streamMessage.thinking) {
							controller.enqueue(
								JSON.stringify({
									type: "thinking",
									content: streamMessage.thinking,
								}) + "\n",
							);
						}
					}
				}

				controller.close();
			} catch (error) {
				const msg =
					error instanceof Error
						? error.message
						: "Claude Agents SDK error";
				controller.enqueue(
					JSON.stringify({
						type: "error",
						content: msg,
					}) + "\n",
				);
				controller.close();
			}
		},
	});
}
