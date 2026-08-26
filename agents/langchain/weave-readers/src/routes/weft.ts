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
import {
	formatQualityReport,
	generateVerdict,
	type ReviewMode,
	runQualityChecks,
} from "../lib/weft-quality.js";
import { WEFT_SYSTEM_PROMPT } from "../prompts/weft-system.js";
import { createReadOnlySandboxTools } from "../tools/sandbox.js";

export const weftRoute = new Hono();

const DEFAULT_TOOL_STEPS = 10;
const MAX_TOOL_STEPS = Number(
	process.env.WEFT_MAX_TOOL_STEPS || DEFAULT_TOOL_STEPS,
);

import type { Context } from "hono";

interface ReviewContext {
	reviewMode: ReviewMode;
	taskDescription?: string;
	acceptanceCriteria?: string;
	originalPlan?: string;
	changedFiles?: string[];
}

async function buildWeftResponse(
	body: unknown,
	honoCtx?: Context,
): Promise<string> {
	const parsed = body as {
		message?: unknown;
		metadata?: unknown;
		reviewMode?: ReviewMode;
		taskContext?: ReviewContext;
	};
	const prompt = extractText(parsed.message);
	const metadata = normalizeMetadata(parsed.metadata);
	const reviewMode: ReviewMode = parsed.reviewMode || "WORK";
	const taskContext = parsed.taskContext;

	const tenant = honoCtx
		? getVerifiedTenant(honoCtx, metadata)
		: metadata.tenantContext;
	const model = await resolveReaderModel(tenant);

	// Build enhanced context based on review mode
	let userContent = "";

	if (reviewMode === "PLAN") {
		userContent = `## Plan Review Request
Review the implementation plan for quality, correctness, and best practices.

Task: ${taskContext?.taskDescription || prompt || "Review implementation plan"}
Acceptance Criteria: ${taskContext?.acceptanceCriteria || "Not specified"}
Original Plan: ${taskContext?.originalPlan || "Not provided"}
Changed Files: ${taskContext?.changedFiles?.join(", ") || "All files"}`;
	} else {
		userContent = `## Work Review Request
Review the implementation for quality, correctness, and best practices.

Task: ${taskContext?.taskDescription || prompt || "Review implementation"}
Changed Files: ${taskContext?.changedFiles?.join(", ") || "All files"}`;
	}

	// If sandbox is available, run quality checks first
	if (metadata.sandboxSessionId && metadata.workDir) {
		const sandbox = createSandboxClient({
			sessionId: metadata.sandboxSessionId,
			workDir: metadata.workDir,
			branch: "",
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		});

		const tools = createReadOnlySandboxTools(sandbox);

		// Build mode-specific context
		let modeContext = "";
		if (reviewMode === "PLAN") {
			modeContext = `\n\n## Review Mode: PLAN
Focus on:
- Stub/TODO/Placeholder detection in plan
- Scope creep detection
- Task context verification
- Implementation completeness`;
		} else {
			modeContext = `\n\n## Review Mode: WORK
Focus on:
- Fake test detection
- Contradiction checks
- Test coverage
- Code quality`;
		}

		// Run LLM with enhanced context
		const result = await withRetry(
			() =>
				generateText({
					model: model,
					system: WEFT_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: `${userContent}${modeContext}`,
						},
					],
					tools,
					stopWhen: stepCountIs(MAX_TOOL_STEPS),
				}),
			{ label: "weft-generateText", circuitKey: "weft" },
		);

		return result.text;
	}

	// No sandbox — run quick quality checks without sandbox if content provided
	if (prompt && reviewMode === "WORK") {
		// For work mode without sandbox, run basic quality checks on the prompt content
		const quickReport = runQualityChecks(prompt, reviewMode);
		const verdict = generateVerdict(reviewMode, quickReport.checks);
		const formatted = formatQualityReport({
			...quickReport,
			verdict: verdict.verdict,
			recommendation: verdict.recommendation,
		});

		return `${formatted}\n\n> **Note:** This quality review was performed without sandbox access. File-level analysis was not possible.`;
	}

	// No sandbox — single-shot reasoning with degradation notice
	const result = await withRetry(
		() =>
			generateText({
				model: model,
				system: WEFT_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `${userContent}\n\nReview Mode: ${reviewMode}\n\nNo sandbox provided; review only the request context.`,
					},
				],
			}),
		{ label: "weft-generateText", circuitKey: "weft" },
	);

	return `${result.text}\n\n> **Note:** This quality review was performed without sandbox access. File-level quality checks were not possible.`;
}

weftRoute.post("/", async (c) => {
	try {
		const body = await c.req.json();
		return sseTextResponse(await buildWeftResponse(body, c));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

weftRoute.get("/health", (c) =>
	c.json({
		status: "healthy",
		agent: "weft",
		bias: "approval-oriented",
		capabilities: [
			"quality-review",
			"code-analysis",
			"tool-calling",
			"llm-reasoning",
			"review-mode",
			"plan-review",
			"work-review",
		],
	}),
);
