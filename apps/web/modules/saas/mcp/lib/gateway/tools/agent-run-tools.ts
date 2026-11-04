import type {
	RunCommandActor,
	RunCommandAudit,
} from "@repo/api/modules/agent-deployments/lib/run-commands";
import {
	agentRunHistorySchema,
	agentRunIdentitySchema,
	agentRunInstanceSchema,
	agentRunListSchema,
	agentRunScheduleSchema,
} from "@repo/api/modules/agent-deployments/lib/run-contracts";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

/** Organization-level owner controls, intentionally unavailable on project-bound connections. */
export function createAgentRunTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	function add<S extends z.ZodType>(
		name: string,
		description: string,
		schema: S,
		scope: string,
		write: boolean,
		command: (
			actor: RunCommandActor,
			input: z.output<S>,
			audit: RunCommandAudit,
		) => Promise<unknown>,
	) {
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
		definitions.push({
			name,
			description,
			inputSchema,
			scope,
			annotations: {
				readOnlyHint: !write,
				...(write ? { idempotentHint: true } : {}),
			},
			...(write ? { confirm: "always" as const } : {}),
		});
		handlers.set(name, async (args, session) => {
			if (
				name === "fabric_search_agent_runs" &&
				session.credential !== "session" &&
				!session.scopes.includes("agents:read") &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					"Run history requires the declared agents:read scope.",
				);
			}
			// A coarse legacy mcp:write credential must not silently gain recurring execution authority.
			if (
				name === "fabric_set_agent_run_schedule" &&
				session.credential !== "session" &&
				!["agents:execute", "agents:schedule"].every(
					(scope) =>
						session.scopes.includes(scope) ||
						session.scopes.includes("*"),
				)
			) {
				return errorResult(
					"Scheduling requires explicit agents:execute and agents:schedule scopes. Grant them deliberately; existing MCP write access does not include recurring work.",
				);
			}
			if (
				!session.organizationId ||
				session.projectId ||
				session.pinnedProjectId ||
				session.credential === "service"
			) {
				return errorResult(
					"Run controls require an organization connection for the agent owner. Project-bound and service connections are not supported.",
				);
			}
			const input = schema.safeParse(args);
			if (!input.success) {
				return errorResult(
					"Use the declared run control schema. Actor, organization and workflow identity fields are not accepted.",
				);
			}
			try {
				return jsonResult(
					await command(
						{
							userId: session.userId,
							organizationId: session.organizationId,
							external: session.credential !== "session",
						},
						input.data,
						(event) => audit(session, event),
					),
				);
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error
						? error.code
						: undefined;
				return errorResult(
					[
						"FORBIDDEN",
						"NOT_FOUND",
						"BAD_REQUEST",
						"CONFLICT",
						"SERVICE_UNAVAILABLE",
					].includes(String(code)) && error instanceof Error
						? error.message
						: "Run control could not be confirmed. Inspect current run or schedule state before retrying.",
				);
			}
		});
	}
	add(
		"fabric_search_agent_runs",
		"Searches your saved-agent run history by agent/status/trigger/time/task. Paged metadata only; use fabric_get_agent_run for output. Pass nextCursor unchanged with same filters.",
		agentRunHistorySchema,
		"agents:read",
		false,
		async (actor, input) =>
			(
				await import(
					"@repo/api/modules/agent-deployments/lib/run-history"
				)
			).searchAgentRunCommand(actor, input),
	);

	add(
		"fabric_list_agent_runs",
		"Lists your saved agent's recent runs, verified status and schedule by Agents-page id.",
		agentRunListSchema,
		"agents:read",
		false,
		async (actor, input) =>
			(
				await import(
					"@repo/api/modules/agent-deployments/lib/run-commands"
				)
			).listAgentRunCommand(actor, input),
	);
	add(
		"fabric_get_agent_run",
		"Reads your saved-agent run's verified status, partial output and result.",
		agentRunIdentitySchema,
		"agents:read",
		false,
		async (actor, input) =>
			(
				await import(
					"@repo/api/modules/agent-deployments/lib/run-commands"
				)
			).getAgentRunCommand(actor, input),
	);
	add(
		"fabric_cancel_agent_run",
		"Requests cooperative cancellation. requested:true is not completion and completed actions are not undone; inspect status next.",
		agentRunIdentitySchema,
		"agents:execute",
		true,
		async (actor, input, audit) =>
			(
				await import(
					"@repo/api/modules/agent-deployments/lib/run-commands"
				)
			).cancelAgentRunCommand(actor, input, audit),
	);
	add(
		"fabric_get_agent_run_schedule",
		"Reads your saved agent's recurring schedule and confirmed engine state.",
		agentRunInstanceSchema,
		"agents:read",
		false,
		async (actor, input) =>
			(
				await import(
					"@repo/api/modules/agent-deployments/lib/run-commands"
				)
			).readAgentRunScheduleCommand(actor, input),
	);
	add(
		"fabric_set_agent_run_schedule",
		"Saves your agent's recurring schedule, or pauses it with enabled:false. Needs agents:schedule AND agents:execute; enabling needs API exposure. If unconfirmed, inspect/reconcile that same schedule.",
		agentRunScheduleSchema,
		"agents:schedule",
		true,
		async (actor, input, audit) =>
			(
				await import(
					"@repo/api/modules/agent-deployments/lib/run-commands"
				)
			).scheduleAgentRunCommand(actor, input, audit),
	);
	return toolFamily(definitions, handlers);
}
async function audit(
	session: GatewaySession,
	event: Parameters<RunCommandAudit>[0],
) {
	const { recordAudit } = await import("@repo/database");
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
		metadata: { ...(event.metadata ?? {}), via: "mcp" },
	});
}
