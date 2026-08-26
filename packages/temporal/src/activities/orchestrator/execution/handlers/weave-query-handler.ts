/**
 * Weave Query Handler
 *
 * Executes the `weave_query` tool by delegating to the Weave thread reader and
 * asking it to return strict JSON describing entities and relationships.
 */

import { requireServiceUrl } from "@repo/utils";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

interface WeaveEntity {
	name: string;
	type: string;
	description: string;
	relationships: Array<{
		target: string;
		relation: string;
	}>;
}

function getReadersUrl(): string {
	// Throws a clear config error when unset in a deployed environment —
	// never a silent localhost fallback outside local dev.
	return requireServiceUrl("WEAVE_READERS_URL", "http://localhost:8140");
}

function extractJsonPayload(raw: string): { entities: WeaveEntity[] } {
	const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
	const candidate = fencedMatch?.[1] ?? raw;
	const startIndex = candidate.indexOf("{");
	const endIndex = candidate.lastIndexOf("}");
	if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
		throw new Error("No JSON payload returned");
	}

	const parsed = JSON.parse(candidate.slice(startIndex, endIndex + 1)) as {
		entities?: WeaveEntity[];
	};
	return {
		entities: Array.isArray(parsed.entities) ? parsed.entities : [],
	};
}

export class WeaveQueryHandler implements StepHandler {
	readonly name = "weave-query";
	readonly capabilities = ["weave_query"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;
		return app === "weave_query" || executor === "weave_query";
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		try {
			return {
				handled: true,
				output: await this.executeWeaveQuery(context.input),
			};
		} catch (error) {
			return {
				handled: false,
				error: error instanceof Error ? error.message : String(error),
				shouldFallback: false,
			};
		}
	}

	private async executeWeaveQuery(
		input: ExecuteStepInput,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = (input.step.inputs ?? {}) as Record<string, unknown>;
		const query =
			typeof stepInputs.query === "string"
				? stepInputs.query
				: input.step.description || "";
		const entityType =
			typeof stepInputs.entityType === "string"
				? stepInputs.entityType
				: undefined;

		if (!input.projectId) {
			throw new Error("weave_query requires a projectId");
		}
		if (!query) {
			throw new Error("weave_query requires a query");
		}

		const { db } = await import("@repo/database");
		const { SecureA2AClient } = await import("@repo/agent-core");

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { name: true, description: true, techStack: true },
		});

		const prompt = [
			"You are returning structured knowledge graph results for Fabric.",
			"Return strict JSON only, with shape:",
			'{"entities":[{"name":"string","type":"string","description":"string","relationships":[{"target":"string","relation":"string"}]}]}',
			"Do not include markdown fences unless absolutely necessary.",
			`User query: ${query}`,
			entityType ? `Entity type filter: ${entityType}` : undefined,
		]
			.filter(Boolean)
			.join("\n");

		const client = new SecureA2AClient({
			timeout: 60_000,
			sourceAgent: "temporal",
		});

		const response = await client.sendMessageSecure(
			`${getReadersUrl()}/thread`,
			{
				role: "user",
				parts: [{ type: "text", text: prompt }],
				metadata: {
					tenantContext: {
						userId: input.userId,
						organizationId: input.organizationId ?? null,
					},
					projectContext: {
						projectId: input.projectId,
						projectName: project?.name || "Unknown",
						description: project?.description || undefined,
						techStack: project?.techStack?.join(", ") || undefined,
					},
				},
			},
			{
				userId: input.userId,
				organizationId: input.organizationId ?? null,
			},
		);

		const responseObj = response as unknown as Record<string, unknown>;
		const rawText =
			typeof response === "string"
				? response
				: typeof responseObj?.text === "string"
					? responseObj.text
					: JSON.stringify(response);
		const parsed = extractJsonPayload(rawText);

		const toolCall: ToolCallRecord = {
			id: `weave-query-${Date.now()}`,
			name: "weave_query",
			args: { query, entityType, projectId: input.projectId },
			result: parsed,
			status: "success",
			durationMs: Date.now() - startTime,
		};

		return {
			outputs: {
				response: JSON.stringify(parsed, null, 2),
				entities: parsed.entities,
				toolResults: [toolCall],
			},
			variables: {},
			toolCalls: [toolCall],
			response: JSON.stringify(parsed, null, 2),
		};
	}
}
