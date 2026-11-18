import { mergeConfigs, type RunnableConfig } from "@langchain/core/runnables";

export function conversationIdForUsage(
	config?: RunnableConfig,
): string | undefined {
	const fields = {
		...config?.configurable?.fabric_usage,
		...config?.configurable,
	};
	if (typeof fields.usage_conversation_id === "string") {
		return undefined;
	}
	const threadId = config?.configurable?.thread_id;
	return typeof threadId === "string" &&
		/^[A-Za-z0-9_-]{8,128}$/.test(threadId)
		? threadId
		: undefined;
}

function carriesModelOutput(
	token: string,
	fields?: { chunk?: unknown },
): boolean {
	if (token.length > 0) {
		return true;
	}
	const chunk = fields?.chunk as
		| { message?: { content?: unknown; tool_call_chunks?: unknown[] } }
		| undefined;
	const message = chunk?.message;
	if (message?.tool_call_chunks?.length) {
		return true;
	}
	const content = message?.content;
	if (typeof content === "string") {
		return content.length > 0;
	}
	return (
		Array.isArray(content) &&
		content.some(
			(block) =>
				(block.type === "text" &&
					typeof block.text === "string" &&
					block.text.length > 0) ||
				(block.type === "reasoning" &&
					typeof block.reasoning === "string" &&
					block.reasoning.length > 0) ||
				(block.type === "thinking" &&
					typeof block.thinking === "string" &&
					block.thinking.length > 0),
		)
	);
}

// Measures the first streamed text or tool-call output, or reasoning when the provider streams it as message content.
export function firstTokenTiming(origin: number) {
	let firstTokenAt: number | undefined;
	return {
		config(config: RunnableConfig): RunnableConfig {
			return mergeConfigs(config, {
				callbacks: [
					{
						name: "assistant_first_token",
						handleLLMNewToken(
							token,
							_indices,
							_runId,
							_parentRunId,
							_tags,
							fields,
						) {
							if (carriesModelOutput(token, fields)) {
								firstTokenAt ??= Date.now();
							}
						},
					},
				],
			});
		},
		get firstTokenMs() {
			if (firstTokenAt === undefined || firstTokenAt < origin) {
				return undefined;
			}
			return firstTokenAt - origin;
		},
	};
}
