import {
	convertToModelMessages,
	stepCountIs,
	streamText,
	type LanguageModel,
	type ToolSet,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createMCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { DEFAULT_MODEL } from "@/lib/constants";
import { handleClaudeAgentsFramework } from "@/lib/frameworks/claude-agents";
import { handleLangchainFramework } from "@/lib/frameworks/langchain";
import { handleOpenAIAgentsFramework } from "@/lib/frameworks/openai-agents";
import { getFabricToolSession } from "@/lib/fabric-tools";

export const maxDuration = 60;

const rateLimit = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

function checkRateLimit(userId: string) {
	const now = Date.now();
	const record = rateLimit.get(userId);

	if (!record || now - record.lastReset > RATE_LIMIT_WINDOW_MS) {
		rateLimit.set(userId, { count: 1, lastReset: now });
		return true;
	}

	if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
		return false;
	}

	record.count++;
	return true;
}

function getModel(modelId: string): LanguageModel {
	const [provider, ...modelParts] = modelId.split("/");
	const modelName = modelParts.join("/");

	switch (provider) {
		case "openai":
			return openai(modelName);
		case "anthropic":
			return anthropic(modelName);
		case "google":
			return google(modelName);
		default:
			return getModel(DEFAULT_MODEL);
	}
}

// System prompt for all frameworks
const SYSTEM_PROMPT = `You are a data analysis agent with access to MCP tools via Fabric. Your job is to help users analyze data and generate insights.

CRITICAL - IMAGE EMBEDDING FORMAT:
When you receive ANY image URL from a tool result, you MUST embed it using markdown syntax:
![Description](https://the-image-url.com/image.png)

Example: If a tool returns an image at "https://example.com/chart.png", write:
![Sales Chart](https://example.com/chart.png)

NEVER just write the URL as text. ALWAYS use ![alt](url) format so images display in the chat.

THEME COLORS:
Light Mode:
- Background: #fbf9f7
- Primary Text: #000000
- Secondary Text: #696969
- Cards/UI: #f5f0ea
- Border: #e2d2d2

Dark Mode:
- Background: #1a1a1a
- Primary Text: #f7f4f0
- Secondary Text: #a0a0a0
- Cards/UI: #2a2a2a
- Border: #3a3a3a

CHART GENERATION:
- When creating charts, visualizations, or graphs, apply a professional color scheme
- Use neutral, accessible colors readable on both light and dark backgrounds
- Include proper contrast and ensure text is always readable

TOOL USAGE:
- Always use available tools to help complete user requests
- Be autonomous in tool selection and execution
- Handle tool errors gracefully and retry when appropriate
- Provide clear feedback on what actions you're taking

EXECUTION:
- Execute user requests directly without asking for unnecessary clarification
- Use tools proactively to gather information and complete tasks
- Report results clearly and concisely
- ALWAYS embed images with ![alt](url) markdown syntax`;

// Model compatibility mapping
function getCompatibleModel(framework: string, requestedModel: string): string {
	const [provider] = requestedModel.split("/");

	if (framework === "openai-agents") {
		// OpenAI Agents SDK only supports OpenAI models
		if (provider === "openai") return requestedModel;
		// Fallback to GPT-4o if non-OpenAI model requested
		return "openai/gpt-4o";
	}

	if (framework === "claude-agents") {
		// Claude Agents SDK only supports Anthropic models
		if (provider === "anthropic") return requestedModel;
		// Fallback to Claude 3.5 Sonnet if non-Anthropic model requested
		return "anthropic/claude-3-5-sonnet-20241022";
	}

	// LangChain and AI SDK support both
	return requestedModel;
}

interface FrameworkContext {
	mcpUrl: string;
	mcpHeaders: Record<string, string> | undefined;
	systemPrompt: string;
	messages: unknown[];
	model: string;
	chatId?: string;
}

// Framework handler functions
async function handleLangchain(context: FrameworkContext): Promise<Response> {
	try {
		const stream = await handleLangchainFramework(
			context.mcpUrl,
			context.mcpHeaders,
			context.messages,
			context.systemPrompt,
			context.model,
		);

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "LangChain framework error";

		const encoder = new TextEncoder();
		const errorStream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(message));
				controller.close();
			},
		});

		return new Response(errorStream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}
}

async function handleOpenAIAgents(
	context: FrameworkContext,
): Promise<Response> {
	try {
		const stream = await handleOpenAIAgentsFramework(
			context.mcpUrl,
			context.model,
			context.mcpHeaders,
			context.messages,
			context.systemPrompt,
		);

		// Return the raw stream directly
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "OpenAI Agents framework error";
		console.error("OpenAI Agents error:", message);

		const encoder = new TextEncoder();
		const errorStream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(message));
				controller.close();
			},
		});

		return new Response(errorStream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}
}

async function handleClaudeAgents(
	context: FrameworkContext,
): Promise<Response> {
	try {
		const stream = await handleClaudeAgentsFramework(
			context.mcpUrl,
			context.mcpHeaders,
			context.messages,
			context.systemPrompt,
			context.chatId,
			context.model,
		);

		// Transform the newline-delimited JSON stream into a proper format
		const encoder = new TextEncoder();
		const transformedStream = new ReadableStream({
			async start(controller) {
				const reader = stream.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						// value is a string, enqueue it as-is (already newline-delimited JSON)
						controller.enqueue(encoder.encode(value));
					}
				} catch (error) {
					controller.error(error);
				} finally {
					reader.releaseLock();
				}
			},
		});

		return new Response(transformedStream, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Claude Agents framework error";
		console.error("Claude Agents error:", message);

		const encoder = new TextEncoder();
		const errorResponse = JSON.stringify({
			type: "error",
			content: message,
		});

		const errorStream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(errorResponse + "\n"));
				controller.close();
			},
		});

		return new Response(errorStream, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}
}

const chatRequestSchema = z.object({
	messages: z.array(z.record(z.unknown())).min(1).max(100),
	model: z.string().optional(),
	framework: z.string().optional(),
	chatId: z.string().optional(),
	organizationId: z.string().nullable().optional(),
});

export async function POST(req: Request) {
	const session = await auth();
	if (!session?.user?.id) {
		return new Response("Unauthorized", { status: 401 });
	}

	if (!checkRateLimit(session.user.id)) {
		return new Response("Too Many Requests", { status: 429 });
	}

	let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;

	try {
		const body = await req.json();
		const parsed = chatRequestSchema.safeParse(body);
		if (!parsed.success) {
			return new Response("Invalid request body", { status: 400 });
		}

		const { messages } = body;
		const framework = parsed.data.framework ?? "ai-sdk";
		const requestedModel = parsed.data.model ?? DEFAULT_MODEL;
		const chatId = parsed.data.chatId;
		const organizationId = parsed.data.organizationId ?? null;

		const compatibleModel = getCompatibleModel(framework, requestedModel);
		const model = getModel(compatibleModel);

		// Get MCP session from Fabric tool router
		const toolSession = await getFabricToolSession(
			session.user.id,
			organizationId,
		);

		const context: FrameworkContext = {
			mcpUrl: toolSession.mcp.url,
			mcpHeaders: toolSession.mcp.headers,
			systemPrompt: SYSTEM_PROMPT,
			messages,
			model: compatibleModel,
			chatId,
		};

		// Route to appropriate framework handler
		if (framework === "langchain") {
			return handleLangchain(context);
		} else if (framework === "openai-agents") {
			return handleOpenAIAgents(context);
		} else if (framework === "claude-agents") {
			return handleClaudeAgents(context);
		}

		// Default: Vercel AI SDK with MCP
		client = await createMCPClient({
			transport: {
				type: "http",
				url: toolSession.mcp.url,
				headers: toolSession.mcp.headers,
			},
		});

		const mcpTools = await client.tools();
		const coreMessages = convertToModelMessages(messages);

		const result = streamText({
			model,
			messages: coreMessages,
			system: SYSTEM_PROMPT,
			tools: mcpTools as ToolSet,
			stopWhen: stepCountIs(20),
			onFinish: async () => {
				await client?.close().catch(() => {});
			},
		});

		return result.toUIMessageStreamResponse();
	} catch (error) {
		await client?.close().catch(() => {});
		console.error("Chat API Error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
}
