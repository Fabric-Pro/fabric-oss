/**
 * Generate Workflow from Prompt Procedure
 *
 * Generates a workflow from a natural language description using AI.
 * Based on Vercel workflow-builder-template AI generation pattern.
 * @see https://github.com/vercel-labs/workflow-builder-template
 */

import { ORPCError } from "@orpc/client";
import {
	generateText,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
// Imported from the SUBPATH so callers clamp output-token budgets identically to
// the merged reference site. See the helper for the Databricks 8,192 /
// Anthropic-direct 4,096 truncation this guards against.
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// Define the node type definitions for context with full config field details
const NODE_TYPES = `
Available node types with their required configuration fields:

1. trigger
   - Start point for workflow
   - config fields:
     - triggerType: "manual" | "schedule" | "webhook" | "event" (required)
     - scheduleExpression: cron expression (when triggerType is "schedule")

2. ai-generate-text
   - Generate text using AI
   - config fields:
     - aiModel: "gpt-4o" | "gpt-4o-mini" | "claude-3-5-sonnet-latest" | "claude-3-5-haiku-latest" (required)
     - aiPrompt: The prompt text, can reference other nodes with {{NodeLabel.field}} (required)
     - systemPrompt: Optional system instructions
   - outputs: { text: string }

3. ai-generate-image
   - Generate images using AI
   - config fields:
     - imageModel: "openai/dall-e-3" | "fal/flux-pro" | "fal/flux-dev" (required)
     - imagePrompt: Image generation prompt (required)
     - imageSize: "1024x1024" | "1792x1024" | "1024x1792"
   - outputs: { imageUrl: string, revisedPrompt: string }

4. http-request
   - Make HTTP/REST API requests
   - config fields:
     - url: Full URL (required)
     - method: "GET" | "POST" | "PUT" | "DELETE" (required)
     - headers: JSON object of headers
     - body: Request body for POST/PUT
   - outputs: { data: any, status: number }

5. firecrawl-scrape
   - Scrape content from URLs (requires Firecrawl integration configured)
   - config fields:
     - scrapeUrl: URL to scrape (required)
     - scrapeFormats: ["markdown", "html", "text"]
   - outputs: { content: string, metadata: object }

6. firecrawl-search
   - Search the web (requires Firecrawl integration configured)
   - config fields:
     - searchQuery: Search query (required)
     - searchLimit: Number of results (default: 5)
   - outputs: { results: array }

7. condition
   - Branch based on condition
   - config fields:
     - expression: JavaScript expression that evaluates to true/false (required)
       Example: "{{PreviousNode.text}}.includes('success')"
   - outputs: { result: boolean }
   - Creates two branches: "true" and "false" edges. Each branch edge must have
     sourceHandle "true" or "false" and must target a DIFFERENT node — a branch
     that points back at the condition is a cycle and the workflow will not run.
     If a branch has nothing to do, omit its edge rather than looping it back.

8. linear-create-ticket
   - Create Linear tickets (requires Linear integration configured)
   - config fields:
     - linearTeam: Team ID or key (required)
     - linearTitle: Issue title (required)
     - linearDescription: Issue description
     - linearPriority: 0-4 (0=none, 1=urgent, 4=low)
   - outputs: { issueId: string, issueUrl: string }

9. email-send
   - Send emails via Resend (requires Resend integration configured)
   - config fields:
     - emailTo: Recipient email (required)
     - emailSubject: Email subject (required)
     - emailBody: Email body HTML/text (required)
     - emailFrom: Sender email (defaults to configured sender)
   - outputs: { messageId: string }

10. slack-send
    - Send Slack messages (requires Slack integration with Bot OAuth Token)
    - IMPORTANT: Slack requires a Bot User OAuth Token starting with "xoxb-"
    - The token must have "chat:write" scope
    - config fields:
      - slackChannel: Channel name (#general) or ID (required)
      - slackMessage: Message text, supports {{NodeLabel.field}} references (required)
    - outputs: { ok: boolean, ts: string, channel: string }

11. mcp-tool
    - Execute MCP server tools (requires MCP servers configured)
    - config fields:
      - mcpServers: Array of configured MCP server IDs (required)
      - toolName: Name of the tool to execute (required)
      - toolArgs: JSON arguments for the tool, supports {{NodeLabel.field}} references
    - outputs: { output: string, text: string, result: any, data: any, toolName: string, serverName: string }
    - Use {{MCP Tool.output}} or {{MCP Tool.text}} for the result as string

Variable References - IMPORTANT:
- Use {{NodeLabel.field}} to reference outputs from previous nodes
- The NodeLabel is the label shown in the node (e.g., "Generate Text", "MCP Tool", "Firecrawl Search")
- Common output fields by node type:
  - ai-generate-text: {{NodeLabel.text}}
  - ai-generate-image: {{NodeLabel.imageUrl}}, {{NodeLabel.revisedPrompt}}
  - http-request: {{NodeLabel.data}}, {{NodeLabel.status}}
  - firecrawl-scrape: {{NodeLabel.content}}, {{NodeLabel.metadata}}
  - firecrawl-search: {{NodeLabel.results}}
  - mcp-tool: {{NodeLabel.output}}, {{NodeLabel.text}}, {{NodeLabel.result}}
  - linear-create-ticket: {{NodeLabel.issueId}}, {{NodeLabel.issueUrl}}
  - slack-send: {{NodeLabel.ts}}, {{NodeLabel.channel}}
  - email-send: {{NodeLabel.messageId}}
  - condition: {{NodeLabel.result}}

Edge connections:
- source: Node ID where edge starts
- target: Node ID where edge ends
- sourceHandle: "true" or "false" for condition nodes to create branches

IMPORTANT Integration Requirements:
- Integrations (Slack, Linear, Resend, Firecrawl) require credentials configured in the Integration Settings
- For Slack specifically: users need a Bot User OAuth Token (xoxb-...) with chat:write scope
- Always remind users to configure integrations before using integration-dependent nodes
`;

/**
 * The node types this procedure will accept back from the model.
 *
 * Derived from `NODE_TYPES` rather than written out a second time: that block
 * is the list the model is told it may use, so parsing it keeps the promise and
 * the enforcement identical by construction. Maintaining a separate array is
 * how the two drift, and a drifted allow-list either rejects valid output or
 * admits a node nothing can execute.
 */
export const SUPPORTED_GENERATED_NODE_TYPES: ReadonlySet<string> = new Set(
	Array.from(NODE_TYPES.matchAll(/^\s*\d+\.\s+([a-z0-9-]+)\s*$/gm)).map(
		(m) => m[1],
	),
);

/**
 * Remove edges whose source and target are the same node.
 *
 * The model reaches for these when a branch has nowhere to go: asked to "branch
 * on whether the status is 200", it emitted `condition_1 -> condition_1` on
 * both the true and the false handle. That is a cycle, and the API's own
 * validation refuses to run a cyclic graph — so the commonest way to ask for a
 * branch produced a workflow that saved and could never execute.
 *
 * Dropping beats refusing here, unlike an unknown node type. A node is never
 * its own successor, so the edge carried no meaning to lose, and what is left
 * is a runnable graph with an unwired branch the author can point somewhere.
 */
export function dropSelfEdges<T>(edges: T[] | undefined): {
	edges: T[];
	dropped: number;
} {
	if (!Array.isArray(edges)) {
		return { edges: [], dropped: 0 };
	}
	const kept = edges.filter((edge) => {
		// The model's output is validated for node types, not edge shape, so
		// read defensively rather than asserting one.
		const { source, target } = (edge ?? {}) as {
			source?: unknown;
			target?: unknown;
		};
		return source == null || source !== target;
	});
	return { edges: kept, dropped: edges.length - kept.length };
}

/** Node types in a generated graph that this workspace has no executor for. */
export function collectUnknownNodeTypes(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) {
		return [];
	}
	const unknown = new Set<string>();
	for (const node of nodes) {
		const type = (node as { type?: unknown })?.type;
		if (
			typeof type !== "string" ||
			!SUPPORTED_GENERATED_NODE_TYPES.has(type)
		) {
			unknown.add(typeof type === "string" ? type : String(type));
		}
	}
	return [...unknown];
}

export const generateFromPromptProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/generate-from-prompt",
		tags: ["Workflows"],
		summary: "Generate workflow from natural language prompt",
		description:
			"Use AI to generate a workflow structure from a user description",
	})
	.input(
		z.object({
			prompt: z.string().min(1).max(2000),
			organizationId: z.string().nullable().optional(),
			existingNodes: z.array(z.any()).optional(),
			existingEdges: z.array(z.any()).optional(),
			action: z.enum(["create", "modify", "append"]).default("create"),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			action: z.enum(["replace", "update", "append"]),
			nodes: z.array(z.any()).optional(),
			edges: z.array(z.any()).optional(),
			updates: z
				.array(
					z.object({
						nodeId: z.string(),
						newLabel: z.string().optional(),
						newConfig: z.record(z.string(), z.unknown()).optional(),
					}),
				)
				.optional(),
			removals: z.array(z.string()).optional(),
			explanation: z.string().optional(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		try {
			// Get AI model using centralized entry point
			let aiModelResult:
				| Awaited<ReturnType<typeof getAIModelWithMetadata>>
				| undefined;
			try {
				aiModelResult = await getAIModelWithMetadata(
					{ taskType: "SIMPLE" },
					{ userId: user.id, organizationId },
				);
			} catch (error) {
				return {
					success: false,
					action: "replace" as const,
					error:
						error instanceof Error
							? error.message
							: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
				};
			}

			const { model, metadata, trackUsage } = aiModelResult;

			// Track usage (fire-and-forget)
			trackUsage();

			// Build context for AI
			const existingWorkflowContext = input.existingNodes?.length
				? `\n\nExisting workflow:\n${JSON.stringify(input.existingNodes, null, 2)}\n\nExisting edges:\n${JSON.stringify(input.existingEdges, null, 2)}`
				: "";

			const actionContext =
				input.action === "modify"
					? "Modify the existing workflow based on the user's request. You can update existing nodes or remove nodes."
					: input.action === "append"
						? "Append new nodes to the existing workflow. Keep all existing nodes."
						: "Create a completely new workflow.";

			const systemPrompt = `You are an expert workflow builder assistant. Generate workflow configurations based on user descriptions.

${NODE_TYPES}

${actionContext}

Guidelines:
- Use unique IDs for nodes (use format like "trigger_1", "ai_1", "slack_1", etc.)
- Position nodes vertically: first node at {x: 250, y: 100}, increase y by 150 for each subsequent node
- Connect nodes logically with edges from source to target
- For conditions, create TWO edges: one with sourceHandle "true" and one with sourceHandle "false"
- Always include required config fields for each node type
- Use descriptive labels that explain what the node does
- Reference previous node outputs using {{NodeLabel.field}} format

When using integrations (Slack, Linear, Resend, Firecrawl, MCP):
- Include a note in the explanation that the integration must be configured first
- Use correct config field names as specified above
- For Slack: use slackChannel and slackMessage fields

Respond with a JSON object only, no markdown or code fences:
{
  "action": "replace" | "update" | "append",
  "nodes": [
    {
      "id": "unique_node_id",
      "type": "node-type",
      "position": { "x": 250, "y": 100 },
      "data": {
        "label": "Descriptive Node Label",
        "config": { /* required config fields for this node type */ }
      }
    }
  ],
  "edges": [
    { "id": "edge_1", "source": "source_node_id", "target": "target_node_id" }
  ],
  "explanation": "Description of workflow. Note: [Integration Name] must be configured in Integration Settings before running."
}`;

			const userPrompt = `${input.prompt}${existingWorkflowContext}`;

			// Generate workflow using centralized AI model
			const generationStart = Date.now();
			// The workflow JSON is the entire product of this call — maximal mode
			// (mirrors aggregation.ts). Without an explicit budget Databricks/
			// Anthropic-direct truncate at their injected defaults (8,192 / 4,096),
			// which then throws in JSON.parse below.
			const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
				promptChars: systemPrompt.length + userPrompt.length,
			});
			const response = await generateText({
				model,
				system: systemPrompt,
				prompt: userPrompt,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			});
			logModelUsageAsync({
				context: { userId: user.id, organizationId },
				metadata,
				taskType: "SIMPLE",
				usage: response.usage,
				latencyMs: Date.now() - generationStart,
			});

			// Parse response
			const responseText = response.text.trim();

			// Extract JSON from response
			let parsedResponse: {
				action: "replace" | "update" | "append";
				nodes?: unknown[];
				edges?: unknown[];
				updates?: {
					nodeId: string;
					newLabel?: string;
					newConfig?: Record<string, unknown>;
				}[];
				removals?: string[];
				explanation?: string;
			};

			try {
				// Try to parse directly
				parsedResponse = JSON.parse(responseText);
			} catch {
				// Try to extract JSON from markdown code block
				const jsonMatch = responseText.match(
					/```(?:json)?\s*([\s\S]*?)```/,
				);
				if (jsonMatch) {
					parsedResponse = JSON.parse(jsonMatch[1].trim());
				} else {
					throw new Error("Could not parse AI response as JSON");
				}
			}

			// The palette only ever offers actions that declare a step binding,
			// so a node with no executor cannot be dragged onto a canvas. This
			// path bypasses the palette entirely: whatever the model emits goes
			// straight back to the builder. Without this check a generated
			// graph can contain node types nothing can run, and the author only
			// finds out when the workflow fails mid-execution.
			//
			// Refusing beats silently dropping the unknown nodes: the edges
			// reference them, so a filtered graph is a broken graph, and the
			// caller can simply generate again.
			const { edges: cleanedEdges, dropped } = dropSelfEdges(
				parsedResponse.edges,
			);
			if (dropped > 0) {
				console.warn(
					`[Generate Workflow] Dropped ${dropped} self-referencing edge(s) from the generated graph`,
				);
				parsedResponse.edges = cleanedEdges;
			}

			const unknown = collectUnknownNodeTypes(parsedResponse.nodes);
			if (unknown.length > 0) {
				console.warn(
					`[Generate Workflow] Model emitted unsupported node types: ${unknown.join(", ")}`,
				);
				return {
					success: false,
					action: "replace" as const,
					error: `The generated workflow used node types this workspace cannot run: ${unknown.join(", ")}. Try describing the automation again.`,
				};
			}

			return {
				success: true,
				action: parsedResponse.action || "replace",
				nodes: parsedResponse.nodes,
				edges: parsedResponse.edges,
				updates: parsedResponse.updates,
				removals: parsedResponse.removals,
				explanation: parsedResponse.explanation,
			};
		} catch (error) {
			console.error("[Generate Workflow] Error:", error);
			return {
				success: false,
				action: "replace" as const,
				error:
					error instanceof Error
						? error.message
						: "Failed to generate workflow",
			};
		}
	});
