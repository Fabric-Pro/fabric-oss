/**
 * OpenAPI Documentation
 *
 * Dynamically generates an OpenAPI spec for all agents exposed
 * to the authenticated API key's tenant.
 */

import { getBaseUrl } from "@repo/utils";
import type { ExternalApiContext } from "../types";
import { listExposedAgents } from "./list-agents";

interface OpenApiSpec {
	openapi: string;
	info: { title: string; version: string; description: string };
	servers: { url: string; description: string }[];
	paths: Record<string, unknown>;
	components: Record<string, unknown>;
	security: unknown[];
}

export async function generateOpenApiSpec(
	ctx: ExternalApiContext,
): Promise<OpenApiSpec> {
	const agents = await listExposedAgents(ctx);
	const baseUrl = getBaseUrl();

	const paths: Record<string, unknown> = {
		"/agents/files": {
			post: {
				summary: "Upload a file for agent execution",
				description:
					"Uploads an image file to be referenced in agent execution requests. Returns a fileId that can be passed in the images array of the execute endpoint.",
				operationId: "uploadFile",
				tags: ["Files"],
				requestBody: {
					required: true,
					content: {
						"multipart/form-data": {
							schema: {
								type: "object",
								required: ["file"],
								properties: {
									file: {
										type: "string",
										format: "binary",
										description:
											"Image file (PNG, JPEG, WebP, GIF, max 10MB)",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "File uploaded successfully",
						content: {
							"application/json": {
								schema: {
									$ref: "#/components/schemas/UploadedFile",
								},
							},
						},
					},
					"400": {
						description:
							"Invalid file (unsupported type or too large)",
					},
				},
			},
		},
		"/agents": {
			get: {
				summary: "List available agents",
				operationId: "listAgents",
				tags: ["Agents"],
				responses: {
					"200": {
						description: "List of API-exposed agents",
						content: {
							"application/json": {
								schema: {
									type: "array",
									items: {
										$ref: "#/components/schemas/AgentSummary",
									},
								},
							},
						},
					},
				},
			},
		},
		"/executions/{executionId}": {
			get: {
				summary: "Get execution status and result",
				operationId: "getExecution",
				tags: ["Executions"],
				parameters: [
					{
						name: "executionId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						description: "Execution status and result",
						content: {
							"application/json": {
								schema: {
									$ref: "#/components/schemas/ExecutionResult",
								},
							},
						},
					},
					"404": { description: "Execution not found" },
				},
			},
		},
		"/executions/{executionId}/stream": {
			get: {
				summary: "Stream execution progress (SSE)",
				description:
					"Returns a Server-Sent Events stream with rich event types including phase transitions, text deltas, tool call completions, and final results. Uses hybrid Redis pub/sub + Temporal query polling for real-time updates.",
				operationId: "streamExecution",
				tags: ["Executions"],
				parameters: [
					{
						name: "executionId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						description:
							"SSE stream with ExecutionStreamEvent payloads",
						content: {
							"text/event-stream": {
								schema: {
									$ref: "#/components/schemas/ExecutionStreamEvent",
								},
							},
						},
					},
				},
			},
		},
	};

	// Add per-agent endpoints
	for (const agent of agents) {
		const inputSchema = agent.apiConfig?.inputSchema || {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Input message or query",
				},
			},
		};

		paths[`/agents/${agent.id}`] = {
			get: {
				summary: `Get ${agent.name} metadata`,
				operationId: `getAgent_${agent.sId}`,
				tags: [agent.template.displayName || "Agents"],
				responses: {
					"200": {
						description: "Agent metadata and input schema",
						content: {
							"application/json": {
								schema: {
									$ref: "#/components/schemas/AgentDetail",
								},
							},
						},
					},
				},
			},
		};

		paths[`/agents/${agent.id}/execute`] = {
			post: {
				summary: `Execute ${agent.name}`,
				description:
					agent.description || agent.apiConfig?.description || "",
				operationId: `executeAgent_${agent.sId}`,
				tags: [agent.template.displayName || "Agents"],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["input"],
								properties: {
									input: inputSchema,
									priority: {
										type: "string",
										enum: [
											"LOW",
											"NORMAL",
											"HIGH",
											"CRITICAL",
										],
										default: "NORMAL",
									},
									idempotencyKey: {
										type: "string",
										description:
											"Optional key to prevent duplicate executions",
									},
									stream: {
										type: "boolean",
										default: false,
										description:
											"If true, returns an SSE stream instead of a 202 JSON response",
									},
									images: {
										type: "array",
										description:
											"Optional image references from the file upload endpoint",
										items: {
											$ref: "#/components/schemas/ImageRef",
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "SSE event stream (when stream=true)",
						content: { "text/event-stream": {} },
					},
					"202": {
						description: "Execution queued",
						content: {
							"application/json": {
								schema: {
									$ref: "#/components/schemas/ExecutionQueued",
								},
							},
						},
					},
					"404": { description: "Agent not found" },
					"409": { description: "Agent deployment not active" },
					"429": { description: "Rate limit or quota exceeded" },
				},
			},
		};
	}

	return {
		openapi: "3.1.0",
		info: {
			title: "Fabric Agent API",
			version: "1.0.0",
			description:
				"External API for executing agent template instances. Authenticate with a Bearer token (fab_* for personal, org_* for organization keys).",
		},
		servers: [
			{
				url: `${baseUrl}/api/v1/external`,
				description: "API server",
			},
		],
		paths,
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: "API key (fab_* or org_*)",
				},
			},
			schemas: {
				AgentSummary: {
					type: "object",
					properties: {
						id: { type: "string" },
						sId: { type: "string" },
						name: { type: "string" },
						description: { type: "string", nullable: true },
						executionMode: { type: "string" },
						template: {
							type: "object",
							properties: {
								slug: { type: "string" },
								displayName: { type: "string" },
								category: { type: "string", nullable: true },
							},
						},
						deploymentId: { type: "string", nullable: true },
					},
				},
				AgentDetail: {
					type: "object",
					properties: {
						id: { type: "string" },
						name: { type: "string" },
						description: { type: "string", nullable: true },
						executionMode: { type: "string" },
						inputSchema: { type: "object" },
						exampleInput: { nullable: true },
						exampleOutput: { nullable: true },
					},
				},
				ExecutionQueued: {
					type: "object",
					properties: {
						executionId: { type: "string" },
						status: { type: "string", enum: ["PENDING"] },
						deploymentId: { type: "string" },
					},
				},
				ExecutionResult: {
					type: "object",
					properties: {
						executionId: { type: "string" },
						status: {
							type: "string",
							enum: [
								"PENDING",
								"RUNNING",
								"COMPLETED",
								"FAILED",
								"CANCELLED",
								"TIMED_OUT",
							],
						},
						output: { nullable: true },
						error: { type: "string", nullable: true },
						durationMs: { type: "integer", nullable: true },
						tokenUsage: {
							type: "object",
							properties: {
								inputTokens: { type: "integer" },
								outputTokens: { type: "integer" },
								totalCost: { type: "number", nullable: true },
							},
						},
						artifacts: {
							type: "array",
							nullable: true,
							description:
								"Image artifacts produced during execution (with signed download URLs)",
							items: {
								$ref: "#/components/schemas/Artifact",
							},
						},
					},
				},
				UploadedFile: {
					type: "object",
					properties: {
						fileId: {
							type: "string",
							description:
								"Opaque ID to reference this file in execute requests",
						},
						name: { type: "string" },
						size: { type: "integer" },
						mimeType: { type: "string" },
					},
				},
				ImageRef: {
					type: "object",
					required: ["fileId", "mimeType"],
					properties: {
						fileId: {
							type: "string",
							description:
								"File ID returned from POST /agents/files",
						},
						mimeType: {
							type: "string",
							description: "MIME type (e.g., image/png)",
						},
						name: {
							type: "string",
							description: "Optional display name",
						},
					},
				},
				Artifact: {
					type: "object",
					properties: {
						id: { type: "string" },
						name: { type: "string" },
						mimeType: { type: "string" },
						url: {
							type: "string",
							description:
								"Signed download URL (expires in 1 hour)",
						},
					},
				},
				ExecutionStreamEvent: {
					type: "object",
					description: "SSE event types for execution streaming",
					properties: {
						event: {
							type: "string",
							enum: [
								"execution.started",
								"execution.phase_changed",
								"execution.text_delta",
								"execution.tool_call_completed",
								"execution.tool_calls_summary",
								"execution.knowledge_completed",
								"execution.plan_created",
								"execution.step_started",
								"execution.step_completed",
								"execution.completed",
								"execution.failed",
								"execution.cancelled",
								"execution.artifact_created",
							],
						},
						data: { type: "object" },
					},
				},
			},
		},
		security: [{ bearerAuth: [] }],
	};
}
