import { generateText, stepCountIs } from "ai";
import type { Context } from "hono";
import { Hono } from "hono";
import { resolveReaderModel } from "../lib/llm.js";
import { withRetry } from "../lib/retry.js";
import {
	extractText,
	getVerifiedTenant,
	normalizeMetadata,
	sseTextResponse,
} from "../lib/route-utils.js";
import { SPINDLE_SYSTEM_PROMPT } from "../prompts/spindle-system.js";
import { createWebSearchTools } from "../tools/web-search.js";

export const spindleRoute = new Hono();

const DEFAULT_TOOL_STEPS = 8;
const MAX_TOOL_STEPS = Number(
	process.env.SPINDLE_MAX_TOOL_STEPS || DEFAULT_TOOL_STEPS,
);

async function buildSpindleResponse(
	body: unknown,
	honoCtx?: Context,
): Promise<string> {
	const parsed = body as { message?: unknown; metadata?: unknown };
	const prompt = extractText(parsed.message);
	const metadata = normalizeMetadata(parsed.metadata);
	const tenant = honoCtx
		? getVerifiedTenant(honoCtx, metadata)
		: metadata.tenantContext;
	const model = await resolveReaderModel(tenant);

	const projectContext = metadata.projectContext || {};
	const techStack =
		typeof projectContext.techStack === "string"
			? projectContext.techStack
			: Array.isArray(projectContext.techStack)
				? (projectContext.techStack as string[]).join(", ")
				: undefined;

	const contextParts: string[] = [
		`Research request: ${prompt || "Research relevant documentation and best practices."}`,
	];
	if (typeof projectContext.projectName === "string") {
		contextParts.push(`Project: ${projectContext.projectName}`);
	}
	if (techStack) {
		contextParts.push(`Tech stack: ${techStack}`);
	}
	if (typeof projectContext.description === "string") {
		contextParts.push(`Description: ${projectContext.description}`);
	}

	const tools = createWebSearchTools();

	const result = await withRetry(
		() =>
			generateText({
				model,
				system: SPINDLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: contextParts.join("\n") }],
				tools,
				stopWhen: stepCountIs(MAX_TOOL_STEPS),
			}),
		{ label: "spindle-generateText", circuitKey: "spindle" },
	);

	return result.text;
}

spindleRoute.post("/", async (c) => {
	try {
		const body = await c.req.json();
		return sseTextResponse(await buildSpindleResponse(body, c));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

spindleRoute.post("/research", async (c) => {
	try {
		const body = await c.req.json();
		const response = await buildSpindleResponse(body, c);
		return c.json({ success: true, response, toolCalls: [] });
	} catch (error) {
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
				response:
					"Research unavailable - proceeding with general knowledge",
			},
			500,
		);
	}
});

spindleRoute.get("/health", (c) =>
	c.json({
		status: "healthy",
		agent: "spindle",
		capabilities: [
			"web-search",
			"fetch-url",
			"npm-search",
			"github-search",
			"llm-reasoning",
		],
	}),
);
