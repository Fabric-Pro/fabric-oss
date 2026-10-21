/** Normalize the CopilotKit and OpenAI wire shapes before LangGraph coercion. */
export function normalizeMessages(messages: any[]) {
	return messages.map((msg: any) => {
		const role =
			msg.role ||
			(msg.type === "tool"
				? "tool"
				: msg.type === "ai" || msg.type === "assistant"
					? "assistant"
					: "user");
		if (role === "tool") {
			return {
				role,
				id: msg.id,
				name: msg.name,
				content:
					typeof msg.content === "string"
						? msg.content
						: JSON.stringify(msg.content ?? ""),
				tool_call_id: msg.toolCallId || msg.tool_call_id || msg.id,
			};
		}
		const calls = msg.tool_calls ?? msg.toolCalls;
		if (role === "assistant" && Array.isArray(calls)) {
			return {
				role,
				id: msg.id,
				content: msg.content || "",
				tool_calls: calls.map((call: any) => {
					let args =
						call.args ??
						call.function?.arguments ??
						call.arguments ??
						{};
					if (typeof args === "string") {
						try {
							args = JSON.parse(args);
						} catch {
							args = {};
						}
					}
					if (
						!args ||
						typeof args !== "object" ||
						Array.isArray(args)
					) {
						args = {};
					}
					return {
						id: call.id,
						name: call.name || call.function?.name,
						args,
						type: "tool_call" as const,
					};
				}),
			};
		}
		return { ...msg, role };
	});
}
