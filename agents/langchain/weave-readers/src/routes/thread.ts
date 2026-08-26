import { generateText, stepCountIs } from "ai";
import { Hono } from "hono";
import { resolveReaderModel } from "../lib/llm.js";
import { withRetry } from "../lib/retry.js";
import {
	extractText,
	getVerifiedTenant,
	normalizeMetadata,
	sseTextResponse,
} from "../lib/route-utils.js";
import { createSandboxClient } from "../lib/sandbox-client.js";
import { THREAD_SYSTEM_PROMPT } from "../prompts/thread-system.js";
import { createReadOnlySandboxTools } from "../tools/sandbox.js";

export const threadRoute = new Hono();

const DEFAULT_TOOL_STEPS = 12;
const MAX_TOOL_STEPS = Number(
	process.env.THREAD_MAX_TOOL_STEPS || DEFAULT_TOOL_STEPS,
);

import type { Context } from "hono";

async function buildThreadResponse(
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
	const contextParts: string[] = [
		`Request: ${prompt || "Explore the codebase."}`,
		"",
		`Project name: ${typeof projectContext.projectName === "string" ? projectContext.projectName : "Unknown"}`,
		`Project description: ${typeof projectContext.description === "string" ? projectContext.description : "Unknown"}`,
		`Tech stack: ${typeof projectContext.techStack === "string" ? projectContext.techStack : "Unknown"}`,
	];

	if (metadata.sandboxSessionId && metadata.workDir) {
		const sandbox = createSandboxClient({
			sessionId: metadata.sandboxSessionId,
			workDir: metadata.workDir,
			branch: "",
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		});

		const tools = createReadOnlySandboxTools(sandbox);

		const result = await withRetry(
			() =>
				generateText({
					model,
					system: THREAD_SYSTEM_PROMPT,
					messages: [
						{ role: "user", content: contextParts.join("\n") },
					],
					tools,
					stopWhen: stepCountIs(MAX_TOOL_STEPS),
				}),
			{ label: "thread-generateText", circuitKey: "thread" },
		);

		return result.text;
	}

	// No sandbox — fall back to single-shot LLM reasoning with degradation notice
	contextParts.push(
		"",
		"No sandbox session is available. Reason from the provided project context and request only.",
	);

	const result = await withRetry(
		() =>
			generateText({
				model,
				system: THREAD_SYSTEM_PROMPT,
				messages: [{ role: "user", content: contextParts.join("\n") }],
			}),
		{ label: "thread-generateText", circuitKey: "thread" },
	);

	return `${result.text}\n\n> **Note:** This analysis was performed without sandbox access. Results may be less thorough than a full codebase inspection.`;
}

threadRoute.post("/", async (c) => {
	try {
		const body = await c.req.json();
		return sseTextResponse(await buildThreadResponse(body, c));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

threadRoute.post("/inspect", async (c) => {
	try {
		const body = await c.req.json();
		return c.json({
			success: true,
			response: await buildThreadResponse(body, c),
		});
	} catch (error) {
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			},
			500,
		);
	}
});

threadRoute.post("/a2a/send", async (c) => threadRoute.fetch(c.req.raw));

threadRoute.get("/health", (c) =>
	c.json({
		status: "healthy",
		agent: "thread",
		capabilities: [
			"workspace-exploration",
			"code-search",
			"tool-calling",
			"llm-reasoning",
		],
	}),
);
