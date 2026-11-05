import {
	type AgentPreviewAudit,
	agentPreviewIdentitySchema,
} from "@repo/api/modules/agents/lib/agent-preview-commands";
import {
	type AgentPreviewSelectionPolicy,
	agentPreviewSelectionScopePolicy,
} from "@repo/api/modules/agents/lib/agent-preview-selection-policy";
import {
	type AgentPreviewActor,
	agentPreviewStartSchema,
} from "@repo/temporal/agent-preview-contracts";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function createAgentPreviewTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	function add<S extends z.ZodType>(
		name: string,
		description: string,
		schema: S,
		scope: string,
		write: boolean,
		command: (
			actor: AgentPreviewActor,
			input: z.output<S>,
			audit: AgentPreviewAudit,
			selectionPolicy?: AgentPreviewSelectionPolicy,
		) => Promise<unknown>,
	) {
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
		definitions.push({
			name,
			description,
			inputSchema,
			scope,
			annotations: { readOnlyHint: !write, idempotentHint: true },
			...(write ? { confirm: "always" as const } : {}),
		});
		handlers.set(name, async (args, session) => {
			if (
				session.credential !== "session" &&
				!session.scopes.includes(scope) &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					`Draft previews require the declared ${scope} scope.`,
				);
			}
			if (
				!session.organizationId ||
				session.projectId ||
				session.pinnedProjectId ||
				session.credential === "service"
			) {
				return errorResult(
					"Draft previews require an organization connection for the current member. Project-bound and service connections are not supported.",
				);
			}
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return errorResult(
					"Use the declared draft preview schema. Actor and organization fields are not accepted.",
				);
			}
			try {
				return jsonResult(
					await command(
						{
							userId: session.userId,
							organizationId: session.organizationId,
						},
						parsed.data,
						async (event) => {
							const { recordAudit } = await import(
								"@repo/database"
							);
							return recordAudit({
								...event,
								actor: {
									type:
										session.credential === "session"
											? "user"
											: session.credential === "oauth"
												? "agent"
												: "api_key",
									userId: session.userId,
								},
								metadata: {
									...(event.metadata ?? {}),
									via: "mcp",
								},
							});
						},
						session.credential === "session"
							? undefined
							: agentPreviewSelectionScopePolicy(session.scopes),
					),
				);
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "";
				const reason =
					error &&
					typeof error === "object" &&
					"data" in error &&
					error.data &&
					typeof error.data === "object" &&
					"code" in error.data &&
					error.data.code === "INSUFFICIENT_SCOPE"
						? "INSUFFICIENT_SCOPE"
						: code;
				return errorResult(
					[
						"FORBIDDEN",
						"NOT_FOUND",
						"BAD_REQUEST",
						"CONFLICT",
						"SERVICE_UNAVAILABLE",
					].includes(code) && error instanceof Error
						? error.message
						: "Preview could not be confirmed. Inspect its state before retrying.",
					{ code: reason || "UNAVAILABLE" },
				);
			}
		});
	}
	add(
		"fabric_start_agent_preview",
		"Test a single-turn unsaved agent draft using current authorized knowledge and read-only project tools. Does not save the agent. Goal loops and external connections are refused. Reuse the UUID idempotencyKey only for an identical request.",
		agentPreviewStartSchema,
		"agents:execute",
		true,
		async (actor, input, audit, selectionPolicy) =>
			(
				await import(
					"@repo/api/modules/agents/lib/agent-preview-commands"
				)
			).startAgentPreviewCommand(actor, input, audit, selectionPolicy),
	);
	add(
		"fabric_get_agent_preview",
		"Read your draft preview's status, response, sources and tool activity. Current access to all selected knowledge remains required.",
		agentPreviewIdentitySchema,
		"agents:read",
		false,
		async (actor, input, _audit, selectionPolicy) =>
			(
				await import(
					"@repo/api/modules/agents/lib/agent-preview-commands"
				)
			).getAgentPreviewCommand(actor, input, selectionPolicy),
	);
	add(
		"fabric_cancel_agent_preview",
		"Request cooperative cancellation of your draft preview. Inspect status to confirm completion.",
		agentPreviewIdentitySchema,
		"agents:execute",
		true,
		async (actor, input, audit, selectionPolicy) =>
			(
				await import(
					"@repo/api/modules/agents/lib/agent-preview-commands"
				)
			).cancelAgentPreviewCommand(actor, input, audit, selectionPolicy),
	);
	return toolFamily(definitions, handlers);
}
