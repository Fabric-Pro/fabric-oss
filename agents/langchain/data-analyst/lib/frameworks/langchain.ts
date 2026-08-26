import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

export async function handleLangchainFramework(
	mcpUrl: string,
	mcpHeaders: Record<string, string> | undefined,
	messages: unknown[],
	systemPrompt: string,
	model: string,
): Promise<ReadableStream<string>> {
	const client = new MultiServerMCPClient({
		fabric: {
			transport: "http",
			url: mcpUrl,
			headers: mcpHeaders || {},
		},
	});

	const tools = await client.getTools();
	const [provider, ...modelParts] = model.split("/");
	const modelName = modelParts.join("/");

	let llm: ChatAnthropic | ChatOpenAI;

	if (provider === "openai") {
		llm = new ChatOpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			modelName,
			temperature: 0,
		});
	} else if (provider === "anthropic") {
		llm = new ChatAnthropic({
			apiKey: process.env.ANTHROPIC_API_KEY,
			modelName,
			temperature: 0,
		});
	} else {
		llm = new ChatAnthropic({
			apiKey: process.env.ANTHROPIC_API_KEY,
			modelName: "claude-sonnet-4-5-20250929",
			temperature: 0,
		});
	}

	// Create agent with tools
	const agent = createReactAgent({
		llm,
		tools,
	});

	// Convert messages to LangChain format, preserving full chat history
	let langchainMessages: BaseMessage[] = Array.isArray(messages)
		? messages
				.filter((msg: any) => msg && msg.content && msg.content.trim()) // Filter out empty messages
				.map((msg: any) => {
					if (msg.role === "user") {
						return new HumanMessage(msg.content);
					} else if (msg.role === "assistant") {
						return new AIMessage(msg.content);
					}
					return new HumanMessage(msg.content);
				})
		: [];

	// Ensure we have at least one user message
	if (langchainMessages.length === 0) {
		langchainMessages.push(new HumanMessage("Help me analyze data"));
	}

	// Create a readable stream for streaming responses
	return new ReadableStream({
		async start(controller) {
			try {
				const response = await agent.invoke(
					{
						messages: langchainMessages,
					},
					{
						configurable: {
							systemPrompt,
						},
					},
				);

				let output = "";

				// Check for output field first
				if (
					response &&
					typeof response === "object" &&
					"output" in response
				) {
					output = String(response.output);
				}
				// Check for messages array (agent returns full message history)
				else if (
					response &&
					typeof response === "object" &&
					"messages" in response &&
					Array.isArray(response.messages)
				) {
					const msgs = response.messages as any[];
					// Get the last assistant message
					for (let i = msgs.length - 1; i >= 0; i--) {
						const msg = msgs[i];
						if (msg && typeof msg === "object") {
							if ("content" in msg && msg.content) {
								output = String(msg.content);
								break;
							}
						}
					}
				}

				if (output) {
					controller.enqueue(output);
				} else {
					controller.enqueue("No response from LangChain agent");
				}

				controller.close();
			} catch (error) {
				const msg =
					error instanceof Error ? error.message : "LangChain error";
				controller.enqueue(msg);
				controller.close();
			}
		},
	});
}
