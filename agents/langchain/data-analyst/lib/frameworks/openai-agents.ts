import { Agent, run, hostedMcpTool, MemorySession } from "@openai/agents";

export async function handleOpenAIAgentsFramework(
	mcpUrl: string,
	model: string,
	mcpHeaders: Record<string, string> | undefined,
	messages: unknown[],
	systemPrompt: string,
): Promise<ReadableStream<string>> {
	// Extract the latest user message
	const lastMessage = Array.isArray(messages)
		? messages[messages.length - 1]
		: null;
	const userMessage =
		lastMessage &&
		typeof lastMessage === "object" &&
		"content" in lastMessage
			? (lastMessage.content as string)
			: "Help me analyze data";
	// Extract model name from "openai/gpt-4o" format
	const modelName = typeof model === "string" ? model.split("/").pop() : "";

	// Check if it's a GPT model
	if (!modelName || !modelName.toLowerCase().startsWith("gpt")) {
		return new ReadableStream<string>({
			async start(controller) {
				controller.enqueue(
					"This model is not supported. OpenAI Agents SDK only supports GPT models.",
				);
				controller.close();
			},
		});
	}

	const agent = new Agent({
		name: "Data Analyst",
		instructions: systemPrompt,
		model: modelName,
		tools: [
			hostedMcpTool({
				serverLabel: "fabric",
				serverUrl: mcpUrl,
				headers: mcpHeaders || {},
			}),
		],
	});

	const memory = new MemorySession();

	return new ReadableStream<string>({
		async start(controller) {
			try {
				const result = await run(agent, userMessage, {
					session: memory,
				});

				// Extract text from RunResult
				let text = "";
				if (result && typeof result === "object") {
					if ("state" in result && "output" in result) {
						const resultTyped = result as {
							state: { _currentStep: { output: string } };
						};
						if (
							resultTyped.state._currentStep &&
							resultTyped.state._currentStep.output
						) {
							text = String(
								resultTyped.state._currentStep.output,
							);
						}
					} else if ("output" in result) {
						const resultTyped = result as { output: string };
						text = String(resultTyped.output);
					}
				} else if (typeof result === "string") {
					text = result;
				}

				if (text) {
					controller.enqueue(text);
				}
				controller.close();
			} catch (error) {
				controller.error(
					error instanceof Error
						? error
						: new Error("OpenAI Agents SDK error"),
				);
			}
		},
	});
}
