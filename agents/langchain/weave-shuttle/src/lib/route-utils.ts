export function extractText(message: unknown): string {
	if (typeof message === "string") {
		return message;
	}
	if (!message || typeof message !== "object") {
		return "";
	}

	const maybeMessage = message as {
		parts?: Array<{ text?: string }>;
		content?: string;
	};
	if (typeof maybeMessage.content === "string") {
		return maybeMessage.content;
	}
	if (Array.isArray(maybeMessage.parts)) {
		return maybeMessage.parts
			.map((part) => part?.text ?? "")
			.filter(Boolean)
			.join("\n");
	}

	return "";
}

export function sseTextResponse(text: string): Response {
	const payload = `data: ${JSON.stringify({ text })}\n\n`;
	return new Response(payload, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
