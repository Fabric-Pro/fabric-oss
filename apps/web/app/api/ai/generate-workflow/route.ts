/**
 * AI Workflow Generation API
 * Converts natural language descriptions into structured workflows
 * Supports both creation and modification modes
 * Based on Vercel workflow-builder-template pattern
 * Uses Next.js after for non-blocking usage logging.
 * See: server-after-nonblocking rule from Vercel React Best Practices
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { auth } from "@repo/auth";
import { logAiUsage } from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import { generateText } from "ai";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";

// Schema for existing workflow nodes/edges (input)
const ExistingNodeSchema = z.object({
	id: z.string(),
	type: z.string(),
	position: z.object({
		x: z.number(),
		y: z.number(),
	}),
	data: z
		.object({
			label: z.string().optional(),
			config: z.record(z.string(), z.unknown()).optional(),
		})
		.passthrough(),
});

const ExistingEdgeSchema = z.object({
	id: z.string(),
	source: z.string(),
	target: z.string(),
	sourceHandle: z.string().optional().nullable(),
	targetHandle: z.string().optional().nullable(),
});

const ExistingWorkflowSchema = z.object({
	nodes: z.array(ExistingNodeSchema),
	edges: z.array(ExistingEdgeSchema),
});

// Input schema for workflow generation
const GenerateWorkflowSchema = z.object({
	prompt: z.string().min(10, "Prompt must be at least 10 characters"),
	organizationId: z.string().optional(),
	// NEW: Support for modification mode
	existingWorkflow: ExistingWorkflowSchema.optional(),
	mode: z.enum(["create", "modify"]).optional().default("create"),
});

// Output schema for generated workflow nodes
const WorkflowNodeSchema = z.object({
	id: z.string(),
	type: z.string(),
	position: z.object({
		x: z.number(),
		y: z.number(),
	}),
	data: z.object({
		label: z.string(),
		config: z.record(z.string(), z.unknown()).optional(),
	}),
});

const WorkflowEdgeSchema = z.object({
	id: z.string(),
	source: z.string(),
	target: z.string(),
	sourceHandle: z.string().optional(),
	targetHandle: z.string().optional(),
});

// Schema for node updates (preserves ID, changes config)
const NodeUpdateSchema = z.object({
	nodeId: z.string().describe("The existing node ID to update"),
	newLabel: z.string().optional().describe("New label for the node"),
	newConfig: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("New config values to merge"),
});

// Enhanced response schema supporting both create and modify modes
const GeneratedWorkflowSchema = z.object({
	// Action tells the frontend how to apply changes
	action: z
		.enum(["replace", "update", "append"])
		.describe(
			"replace: replace entire workflow, update: modify existing nodes, append: add new nodes",
		),
	// For 'update' action - which nodes to modify in place
	updates: z
		.array(NodeUpdateSchema)
		.optional()
		.describe("Nodes to update in place (keep same ID, change config)"),
	// For 'append' or 'replace' action - new nodes to add
	nodes: z
		.array(WorkflowNodeSchema)
		.optional()
		.describe("New nodes to add or entire workflow nodes for replace"),
	// For 'append' or 'replace' action - edges
	edges: z
		.array(WorkflowEdgeSchema)
		.optional()
		.describe("Edges for new nodes or entire workflow edges for replace"),
	// Node IDs to remove (for modify mode)
	removals: z
		.array(z.string())
		.optional()
		.describe("Node IDs to remove from the workflow"),
	// Human-readable description
	description: z
		.string()
		.optional()
		.describe("Brief description of changes made"),
});

export async function POST(req: NextRequest) {
	const startTime = Date.now();

	try {
		console.log("[AI Workflow Generation] Request started");

		// Get user session
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			console.log("[AI Workflow Generation] Unauthorized - no session");
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Parse request body
		const body = await req.json();
		const validation = GenerateWorkflowSchema.safeParse(body);

		if (!validation.success) {
			console.log(
				"[AI Workflow Generation] Invalid request:",
				validation.error,
			);
			return new Response(
				JSON.stringify({
					error: "Invalid request",
					details: validation.error.issues,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const { prompt, organizationId, existingWorkflow, mode } =
			validation.data;
		console.log("[AI Workflow Generation] Prompt:", prompt, "Mode:", mode);

		const userId = session.user.id;

		// Get AI model using centralized entry point
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{ userId, organizationId },
		);

		// Track provider last-used timestamp (fire-and-forget)
		trackUsage();

		// Generate workflow using AI
		const { workflow, usage } = await generateWorkflowFromPrompt(
			prompt,
			model,
			metadata.modelString,
			mode,
			existingWorkflow,
		);

		const latencyMs = Date.now() - startTime;

		console.log("[AI Workflow Generation] Generated workflow:", {
			action: workflow.action,
			nodes: workflow.nodes?.length ?? 0,
			edges: workflow.edges?.length ?? 0,
			updates: workflow.updates?.length ?? 0,
			removals: workflow.removals?.length ?? 0,
		});

		// Log AI usage after response is sent (non-blocking)
		// See: server-after-nonblocking rule from Vercel React Best Practices
		after(() => {
			logAiUsage({
				userId,
				organizationId: organizationId ?? undefined,
				provider: metadata.provider,
				providerModelId: metadata.modelString,
				modelCanonicalName: metadata.canonicalName,
				billingCategory:
					metadata.billingMode === "included_credit"
						? "INCLUDED_CREDIT"
						: metadata.billingMode === "metered_stripe"
							? "STRIPE_METERED"
							: metadata.billingMode === "platform_unbilled"
								? "PLATFORM_UNBILLED"
								: "EXTERNAL_BYOK",
				billingCustomerId: metadata.billingCustomerId,
				taskType: "COMPLEX",
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: usage.totalTokens,
				latencyMs,
				success: true,
			}).catch((error) => {
				console.error(
					"[AI Workflow Generation] Failed to log usage:",
					error,
				);
			});
		});

		return new Response(JSON.stringify(workflow), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (error: unknown) {
		const latencyMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : "Internal server error";

		// AI usage-limit chokepoint hit a HARD limit.
		// Surface the rich payload so the workflow
		// builder client renders the shared destructive toast.
		if (error instanceof AiUsageLimitExceededError) {
			return new Response(
				JSON.stringify({
					error: error.message,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: {
						limitId: error.limitId,
						dimension: error.dimension,
						window: error.window,
						used: error.used.toString(),
						max: error.max.toString(),
						manageLimitsUrl: error.manageLimitsUrl,
					},
				}),
				{
					status: 429,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		console.error("[AI Workflow Generation] Error:", error);

		// Log failed request (non-blocking)
		after(() => {
			logAiUsage({
				provider: "UNKNOWN" as any,
				providerModelId: "unknown",
				taskType: "COMPLEX",
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				latencyMs,
				success: false,
				errorMessage,
			}).catch(() => {
				// Silent failure for error logging
			});
		});

		return new Response(
			JSON.stringify({
				error: errorMessage,
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

// Base system prompt with available node types
const BASE_SYSTEM_PROMPT = `You are a workflow automation expert.

Available node types:
1. trigger - Start point (triggerType: manual, schedule, webhook, event)
2. ai-generate-text - Generate text using AI (aiModel, aiPrompt, aiFormat)
3. ai-generate-image - Generate images (imageModel, imagePrompt)
4. firecrawl-scrape - Scrape URL content (url)
5. firecrawl-search - Search the web (query, limit)
6. http-request - Make HTTP requests (method, url)
7. condition - Branch based on conditions (expression)
8. linear-create-ticket - Create Linear ticket (ticketTitle, ticketDescription, priority)
9. linear-find-issues - Find Linear issues (assignee, teamId, status, label)
10. email-send - Send email via Resend (to, subject, body)
11. slack-send - Send Slack message (slackChannel, slackMessage)
12. mcp-tool - Execute MCP server tool (mcpServers, toolName, toolArgs)

Position nodes from left to right (x: 0, 250, 500, etc.) with staggered y positions.
Use variable syntax {{NodeLabel.field}} to reference previous node outputs.`;

// System prompt for creating new workflows
const CREATE_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You are creating a NEW workflow from scratch.

Response format:
- action: "replace" (always for new workflows)
- nodes: array of all workflow nodes
- edges: array of connections between nodes
- description: brief description of the workflow

Rules:
1. Always start with a trigger node
2. Connect nodes in logical execution order
3. Use descriptive labels for nodes`;

// System prompt for modifying existing workflows
const MODIFY_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You are MODIFYING an existing workflow. The user wants to change something specific.

IMPORTANT RULES FOR MODIFICATION:
1. PRESERVE existing node IDs when updating nodes - use the "updates" array
2. Only use "nodes" array for truly NEW nodes that don't exist yet
3. Use "removals" array for nodes to delete
4. Analyze what the user wants to change and make MINIMAL modifications

Response format based on the change type:

For UPDATES to existing nodes (e.g., "change email to different address"):
- action: "update"
- updates: [{nodeId: "existing-id", newConfig: {to: "new@example.com"}}]
- description: what was changed

For ADDING new nodes while keeping existing:
- action: "append"
- nodes: [only the new nodes to add]
- edges: [edges connecting new nodes]
- description: what was added

For REMOVING nodes:
- action: "update"
- removals: ["node-id-to-remove"]
- description: what was removed

For REPLACING entire workflow (only when user explicitly asks):
- action: "replace"
- nodes: [complete new workflow]
- edges: [all new edges]
- description: why workflow was replaced

CRITICAL: When user says things like "change X to Y", "update the email", "modify the message":
- Find the existing node that matches
- Use action: "update" with the updates array
- DO NOT create new duplicate nodes`;

/** Usage data from AI SDK (normalized to numbers) */
interface UsageData {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/**
 * Generate workflow from natural language prompt using AI
 * Supports both create and modify modes
 * Returns workflow object and usage data for logging
 * Uses generateText instead of generateObject to avoid OpenAI structured output
 * restrictions on z.record (which generates 'propertyNames' — not permitted).
 */
async function generateWorkflowFromPrompt(
	prompt: string,
	model: import("ai").LanguageModel,
	modelString: string,
	mode: "create" | "modify" = "create",
	existingWorkflow?: z.infer<typeof ExistingWorkflowSchema>,
): Promise<{
	workflow: z.infer<typeof GeneratedWorkflowSchema>;
	usage: UsageData;
}> {
	// Select system prompt based on mode
	const systemPrompt =
		mode === "modify" ? MODIFY_SYSTEM_PROMPT : CREATE_SYSTEM_PROMPT;

	// Build user prompt
	let userPrompt: string;
	if (mode === "modify" && existingWorkflow) {
		// Include existing workflow context for modifications
		const existingContext = JSON.stringify(
			{
				nodes: existingWorkflow.nodes.map((n) => ({
					id: n.id,
					type: n.type,
					label: n.data.label,
					config: n.data.config,
				})),
				edges: existingWorkflow.edges.map((e) => ({
					id: e.id,
					source: e.source,
					target: e.target,
				})),
			},
			null,
			2,
		);

		userPrompt = `EXISTING WORKFLOW:
${existingContext}

USER REQUEST: ${prompt}

Analyze the existing workflow and make the requested changes. Remember to use "updates" for modifying existing nodes (keeping their IDs) and only use "nodes" for truly new nodes.

Respond with a JSON object only, no markdown or code fences.`;
	} else {
		userPrompt = `Create a workflow for: ${prompt}

Respond with a JSON object only, no markdown or code fences.`;
	}

	try {
		console.log("[AI Workflow Generation] Using model:", modelString);
		const result = await generateText({
			model,
			system: systemPrompt,
			prompt: userPrompt,
		});

		// Parse JSON from text response
		const responseText = result.text.trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(responseText);
		} catch {
			// Try to extract JSON from markdown code block
			const jsonMatch = responseText.match(
				/```(?:json)?\s*([\s\S]*?)```/,
			);
			if (jsonMatch) {
				parsed = JSON.parse(jsonMatch[1].trim());
			} else {
				throw new Error("Could not parse AI response as JSON");
			}
		}

		// Validate with Zod schema
		const workflow = GeneratedWorkflowSchema.parse(parsed);

		return {
			workflow,
			usage: {
				inputTokens: result.usage.inputTokens ?? 0,
				outputTokens: result.usage.outputTokens ?? 0,
				totalTokens: result.usage.totalTokens ?? 0,
			},
		};
	} catch (error: unknown) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[AI Workflow Generation] AI SDK error:", error);
		throw new Error(`Failed to generate workflow: ${errorMessage}`);
	}
}

export const runtime = "nodejs";
