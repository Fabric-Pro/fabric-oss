/**
 * A2A Protocol Handler for weave-readers
 *
 * Routes A2A messages to the correct reader agent with LLM-backed
 * tool-calling loops for iterative exploration.
 */

import { generateText, stepCountIs } from "ai";
import { Hono } from "hono";
import { resolveReaderModel } from "../lib/llm.js";
import { withRetry } from "../lib/retry.js";
import {
	extractText,
	getVerifiedTenant,
	normalizeMetadata,
} from "../lib/route-utils.js";
import { createSandboxClient } from "../lib/sandbox-client.js";
import { SPINDLE_SYSTEM_PROMPT } from "../prompts/spindle-system.js";
import { THREAD_SYSTEM_PROMPT } from "../prompts/thread-system.js";
import { WARP_SYSTEM_PROMPT } from "../prompts/warp-system.js";
import { WEFT_SYSTEM_PROMPT } from "../prompts/weft-system.js";
import { createReadOnlySandboxTools } from "../tools/sandbox.js";
import { createWebFetchTools } from "../tools/web-fetch.js";
import { createWebSearchTools } from "../tools/web-search.js";
import { SECURITY_PATTERNS } from "./warp.js";

export const a2aRoute = new Hono();

const DEFAULT_TOOL_STEPS = 10;
const ENV_MAX_TOOL_STEPS = Number(
	process.env.A2A_MAX_TOOL_STEPS || DEFAULT_TOOL_STEPS,
);

function resolveAgent(
	body: Record<string, unknown>,
): "thread" | "spindle" | "weft" | "warp" {
	const metadata = (body.metadata ?? {}) as Record<string, unknown>;
	const skillId =
		typeof metadata.skillId === "string" ? metadata.skillId : "";
	const delegationContext = (metadata.delegationContext ?? {}) as Record<
		string,
		unknown
	>;
	const agentId =
		typeof delegationContext.agentId === "string"
			? delegationContext.agentId
			: typeof metadata.agentId === "string"
				? metadata.agentId
				: "";
	const text = `${skillId} ${agentId}`.toLowerCase();
	if (text.includes("spindle")) {
		return "spindle";
	}
	if (text.includes("weft")) {
		return "weft";
	}
	if (text.includes("warp")) {
		return "warp";
	}
	return "thread";
}

const SYSTEM_PROMPTS: Record<string, string> = {
	thread: THREAD_SYSTEM_PROMPT,
	spindle: SPINDLE_SYSTEM_PROMPT,
	weft: WEFT_SYSTEM_PROMPT,
	warp: WARP_SYSTEM_PROMPT,
};

function buildUserContent(
	agent: string,
	prompt: string,
	metadata: ReturnType<typeof normalizeMetadata>,
	delegationContext: Record<string, unknown>,
): string {
	const parts: string[] = [];
	const pc = metadata.projectContext || {};

	// Extract enhanced context from delegation context
	const reviewMode = delegationContext.reviewMode as string | undefined;
	const taskDescription = delegationContext.taskDescription as
		| string
		| undefined;
	const acceptanceCriteria = delegationContext.acceptanceCriteria as
		| string
		| undefined;
	const originalPlan = delegationContext.originalPlan as string | undefined;
	const changedFiles = delegationContext.changedFiles as string[] | undefined;

	switch (agent) {
		case "thread":
			parts.push(`Request: ${prompt || "Explore the codebase."}`);
			if (typeof pc.projectName === "string") {
				parts.push(`Project: ${pc.projectName}`);
			}
			if (typeof pc.techStack === "string") {
				parts.push(`Stack: ${pc.techStack}`);
			}
			break;

		case "spindle":
			parts.push(
				`Research request: ${prompt || "Research relevant documentation and best practices."}`,
			);
			if (typeof pc.projectName === "string") {
				parts.push(`Project: ${pc.projectName}`);
			}
			if (typeof pc.techStack === "string") {
				parts.push(`Stack: ${pc.techStack}`);
			}
			if (typeof pc.description === "string") {
				parts.push(`Description: ${pc.description}`);
			}
			break;

		case "weft":
			parts.push(
				`Review request: ${prompt || "Review the implementation."}`,
			);
			// Pass review mode context if provided
			if (reviewMode) {
				parts.push(`Review Mode: ${reviewMode.toUpperCase()}`);
			}
			if (taskDescription) {
				parts.push(`Task: ${taskDescription}`);
			}
			if (acceptanceCriteria) {
				parts.push(`Acceptance Criteria: ${acceptanceCriteria}`);
			}
			if (originalPlan) {
				parts.push(`Original Plan: ${originalPlan}`);
			}
			if (changedFiles) {
				parts.push(`Changed Files: ${changedFiles.join(", ")}`);
			}
			break;

		case "warp":
			parts.push(
				`Security review request: ${prompt || "Review for security issues."}`,
			);
			// Pass changed files for triage if provided
			if (changedFiles) {
				parts.push(
					"",
					"Changed files for triage:",
					...changedFiles.map((f) => `- ${f}`),
				);
			}
			parts.push(
				"",
				"Common security patterns to search for (explore broadly beyond these):",
			);
			for (const p of SECURITY_PATTERNS) {
				parts.push(`- ${p}`);
			}
			parts.push(
				"",
				"Use the searchCode and readFile tools to thoroughly investigate.",
			);
			break;
	}

	return parts.join("\n");
}

a2aRoute.post("/send", async (c) => {
	const taskId = crypto.randomUUID();

	try {
		const body = (await c.req.json()) as Record<string, unknown>;
		const prompt = extractText(body.message);
		const agent = resolveAgent(body);
		const metadata = normalizeMetadata(body.metadata);
		const tenant = getVerifiedTenant(c, metadata);
		const model = await resolveReaderModel(tenant);

		// Allow orchestrator to override step limit per-request
		const delegationCtx = (metadata.delegationContext ?? {}) as Record<
			string,
			unknown
		>;
		const requestedSteps =
			typeof delegationCtx.maxToolSteps === "number"
				? delegationCtx.maxToolSteps
				: ENV_MAX_TOOL_STEPS;
		// Cap at 50 to prevent runaway token spend
		const maxSteps = Math.min(requestedSteps, 50);

		const systemPrompt = SYSTEM_PROMPTS[agent];
		const userContent = buildUserContent(
			agent,
			prompt,
			metadata,
			delegationCtx,
		);

		// Build tools based on agent type
		let tools:
			| ReturnType<typeof createReadOnlySandboxTools>
			| ReturnType<typeof createWebSearchTools>
			| (ReturnType<typeof createReadOnlySandboxTools> &
					ReturnType<typeof createWebFetchTools>)
			| undefined;
		let sandboxAvailable = false;

		if (agent === "spindle") {
			tools = createWebSearchTools();
		} else if (
			agent === "warp" &&
			metadata.sandboxSessionId &&
			metadata.workDir
		) {
			// Warp gets both sandbox tools (for code analysis) and web-fetch (for RFC verification)
			sandboxAvailable = true;
			const sandbox = createSandboxClient({
				sessionId: metadata.sandboxSessionId,
				workDir: metadata.workDir,
				branch: "",
				userId: tenant.userId,
				organizationId: tenant.organizationId,
			});
			tools = {
				...createReadOnlySandboxTools(sandbox),
				...createWebFetchTools(),
			};
		} else if (metadata.sandboxSessionId && metadata.workDir) {
			sandboxAvailable = true;
			const sandbox = createSandboxClient({
				sessionId: metadata.sandboxSessionId,
				workDir: metadata.workDir,
				branch: "",
				userId: tenant.userId,
				organizationId: tenant.organizationId,
			});
			tools = createReadOnlySandboxTools(sandbox);
		}

		const result = await withRetry(
			() =>
				generateText({
					model,
					system: systemPrompt,
					messages: [{ role: "user", content: userContent }],
					...(tools
						? { tools, stopWhen: stepCountIs(maxSteps) }
						: {}),
				}),
			{ label: `${agent}-a2a-generateText`, circuitKey: agent },
		);

		// Fix 8: Append degradation notice if sandbox was expected but not available
		let responseText = result.text;
		if (
			!sandboxAvailable &&
			agent !== "spindle" &&
			metadata.sandboxSessionId === undefined
		) {
			responseText +=
				"\n\n> **Note:** This analysis was performed without sandbox access. Results may be less thorough than a full codebase inspection.";
		}

		return c.json({
			task: {
				id: taskId,
				status: "completed",
				messages: [
					{
						role: "agent",
						parts: [{ type: "text", text: responseText }],
					},
				],
			},
		});
	} catch (error) {
		return c.json(
			{
				task: {
					id: taskId,
					status: "failed",
					messages: [
						{
							role: "agent",
							parts: [
								{
									type: "text",
									text: `Agent error: ${error instanceof Error ? error.message : "Unknown error"}`,
								},
							],
						},
					],
				},
			},
			500,
		);
	}
});
