import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
	getAgentModelAsync,
	logAgentUsageFromRunnableConfig,
} from "@repo/agent-core";
import { db } from "@repo/database/prisma/client";
import { savePlanNode } from "./persistence.js";
import { ANALYSIS_PROMPT, PLAN_CREATION_PROMPT } from "./prompts/system.js";

/**
 * Best-effort progress indicator. Updates by planId only — tenant access was
 * already validated when the plan was created. Only writes a description stage
 * marker, never reads or returns sensitive data.
 */
async function updatePlanProgress(planId: string | undefined, stage: string) {
	if (!planId) {
		return;
	}
	try {
		await db.weavePlan.update({
			where: { id: planId },
			data: { description: `[${stage}]` },
		});
	} catch {
		// Non-critical — progress updates are best-effort
	}
}

const PatternState = Annotation.Root({
	messages: Annotation<BaseMessage[]>({
		reducer: (x, y) => x.concat(y),
		default: () => [],
	}),
	projectContext: Annotation<{
		projectId: string;
		projectName: string;
		description?: string;
		techStack?: string;
	}>(),
	tenantContext: Annotation<{
		userId: string;
		organizationId: string | null;
	}>(),
	research: Annotation<string | undefined>(),
	analysis: Annotation<string | undefined>(),
	checkboxes: Annotation<
		| Array<{
				id: string;
				text: string;
				agent: string;
				category?: string;
				requiresReview?: boolean;
				reviewType?: string;
		  }>
		| undefined
	>(),
	planId: Annotation<string | undefined>(),
});

/**
 * Delegate to a reader agent via A2A protocol with HMAC-signed tenant context.
 * Falls back to raw fetch if SecureA2AClient is not available.
 */
type ReaderPayload = {
	message?: {
		role?: string;
		parts?: Array<{ text?: string }>;
	};
	metadata?: Record<string, unknown>;
};

async function fetchReaderSummary(
	path: string,
	payload: ReaderPayload,
	tenantContext?: { userId: string; organizationId: string | null },
) {
	const readersUrl = process.env.WEAVE_READERS_URL || "http://localhost:8140";

	// Use SecureA2AClient for HMAC-signed requests when tenant context is available
	if (tenantContext?.userId) {
		try {
			const { SecureA2AClient } = await import("@repo/agent-core");
			const client = new SecureA2AClient({
				timeout: 120_000,
				sourceAgent: "pattern",
			});

			const task = await client.sendMessageSecure(
				readersUrl,
				{
					role: "user",
					parts: [
						{
							type: "text",
							text:
								(
									payload.message as {
										parts?: Array<{ text?: string }>;
									}
								)?.parts?.[0]?.text || "",
						},
					],
					metadata: payload.metadata,
				},
				tenantContext,
			);

			// Extract text from A2A task response
			const agentMessages = (
				task as {
					messages?: Array<{
						role: string;
						parts: Array<{ text?: string }>;
					}>;
				}
			).messages?.filter((m) => m.role === "agent");
			const lastMsg = agentMessages?.[agentMessages.length - 1];
			const responseText =
				lastMsg?.parts?.map((p) => p.text || "").join("") || "";

			return { response: responseText, success: true };
		} catch (error) {
			console.warn(
				`[Pattern] SecureA2AClient failed for ${path}, falling back to direct fetch:`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	// Fallback: direct HTTP (dev mode without HMAC)
	const response = await fetch(`${readersUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`Reader request failed: ${response.statusText}`);
	}

	return response.json() as Promise<{
		response?: string;
		success?: boolean;
		error?: string;
	}>;
}

async function researchNode(state: typeof PatternState.State) {
	console.log("[Pattern] Step 1: Researching...");
	await updatePlanProgress(
		state.planId,
		"Researching codebase and documentation...",
	);

	const promptText = `Research best practices and patterns for: ${state.projectContext.description || "software development"}

Tech stack: ${state.projectContext.techStack || "Not specified"}

Focus on:
1. Architecture patterns
2. Implementation approaches
3. Common pitfalls to avoid
4. Best practices`;

	const payload = {
		message: { role: "user", parts: [{ text: promptText }] },
		metadata: {
			tenantContext: state.tenantContext,
			projectContext: state.projectContext,
		},
	};

	const sections: string[] = [];

	// RAG: Retrieve project context (requirements, architecture, decisions)
	try {
		const { retrieveProjectContexts, contextMetaHeader } = await import(
			"@repo/rag"
		);

		const userMessage =
			state.messages[state.messages.length - 1]?.content || "";
		const results = await retrieveProjectContexts({
			projectId: state.projectContext.projectId,
			query:
				typeof userMessage === "string"
					? userMessage
					: String(userMessage),
			userId: state.tenantContext.userId,
			organizationId: state.tenantContext.organizationId ?? undefined,
			topK: 5,
		});

		if (results && results.length > 0) {
			const ragContent = results
				.map(
					(
						r: {
							content: string;
							metadata?: { filename?: string; type?: string };
							sourceType?: string;
							aiInstructions?: string;
						},
						i: number,
					) => {
						const source =
							r.metadata?.filename ??
							r.metadata?.type ??
							`Context ${i + 1}`;
						// Type label + AI guidance (#1888): metadata arrives
						// flag-gated; header is "" when unset.
						return `### ${source}\n${contextMetaHeader(r)}${r.content}`;
					},
				)
				.join("\n\n");
			sections.push(`## Project context (RAG)\n${ragContent}`);
		}
	} catch {
		// RAG is best-effort — embedding model may not be configured
	}

	try {
		const spindle = await fetchReaderSummary(
			"/spindle/research",
			payload,
			state.tenantContext,
		);
		if (spindle.response) {
			sections.push(`## External research\n${spindle.response}`);
		}
	} catch (error) {
		sections.push(
			`## External research\nUnavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}

	try {
		const thread = await fetchReaderSummary(
			"/thread/inspect",
			payload,
			state.tenantContext,
		);
		if (thread.response) {
			sections.push(`## Codebase grounding\n${thread.response}`);
		}
	} catch (error) {
		sections.push(
			`## Codebase grounding\nUnavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}

	return {
		research:
			sections.join("\n\n") ||
			"Research unavailable - proceeding with general knowledge",
	};
}

async function analyzeNode(
	state: typeof PatternState.State,
	config: RunnableConfig,
) {
	console.log("[Pattern] Step 2: Analyzing requirements...");
	await updatePlanProgress(
		state.planId,
		"Analyzing requirements and complexity...",
	);

	const model = await getAgentModelAsync(config);
	const userMessage =
		state.messages[state.messages.length - 1]?.content || "";

	const generationStart = Date.now();
	const response = await model.invoke([
		["system", ANALYSIS_PROMPT],
		[
			"human",
			`User Request: ${userMessage}

Project Context:
- Name: ${state.projectContext.projectName}
- Description: ${state.projectContext.description || "N/A"}
- Tech Stack: ${state.projectContext.techStack || "N/A"}

Research Findings:
${state.research}

Analyze this request and break down what's needed. Be specific about:
1. Core functionality required
2. Components/modules needed
3. Dependencies
4. Complexity assessment`,
		],
	]);
	await logAgentUsageFromRunnableConfig(config, response, {
		taskType: "COMPLEX",
		agentId: "pattern_planner",
		latencyMs: Date.now() - generationStart,
	});

	return {
		analysis:
			typeof response.content === "string"
				? response.content
				: JSON.stringify(response.content),
	};
}

async function createCheckboxesNode(
	state: typeof PatternState.State,
	config: RunnableConfig,
) {
	console.log("[Pattern] Step 3: Creating plan checkboxes...");
	await updatePlanProgress(state.planId, "Generating execution plan...");

	const model = await getAgentModelAsync(config);
	const generationStart = Date.now();
	const response = await model.invoke([
		["system", PLAN_CREATION_PROMPT],
		[
			"human",
			`Analysis:
${state.analysis}

Create a detailed execution plan with checkboxes. Each checkbox should:
- Have a clear, actionable description
- Be assigned to the right agent (thread/spindle/shuttle/weft/warp)
- Include category for shuttle if applicable
- Flag if review is needed

Format as JSON array:
[
  {
    "id": "uuid",
    "text": "Actionable task description",
    "agent": "thread|spindle|shuttle|weft|warp",
    "category": "frontend|backend|database|devops" (for shuttle only),
    "requiresReview": boolean,
    "reviewType": "weft|warp|both" (if requiresReview)
  }
]`,
		],
	]);
	await logAgentUsageFromRunnableConfig(config, response, {
		taskType: "COMPLEX",
		agentId: "pattern_planner",
		latencyMs: Date.now() - generationStart,
	});

	let checkboxes: Array<{
		id: string;
		text: string;
		agent: string;
		category?: string;
		requiresReview?: boolean;
		reviewType?: string;
	}> = [];

	try {
		const content = response.content.toString();
		const jsonMatch = content.match(/\[[\s\S]*\]/);
		if (jsonMatch) {
			checkboxes = JSON.parse(jsonMatch[0]);
		}
	} catch (error) {
		console.error("[Pattern] Failed to parse checkboxes:", error);
		checkboxes = [
			{
				id: crypto.randomUUID(),
				text: "Implement requested feature",
				agent: "shuttle",
				requiresReview: true,
				reviewType: "weft",
			},
		];
	}

	return { checkboxes };
}

const workflow = new StateGraph(PatternState)
	.addNode("researchNode", researchNode)
	.addNode("analyzeNode", analyzeNode)
	.addNode("createCheckboxesNode", createCheckboxesNode)
	.addNode("savePlanNode", savePlanNode)
	.addEdge(START, "researchNode")
	.addEdge("researchNode", "analyzeNode")
	.addEdge("analyzeNode", "createCheckboxesNode")
	.addEdge("createCheckboxesNode", "savePlanNode")
	.addEdge("savePlanNode", END);

export const patternGraph = workflow.compile();
