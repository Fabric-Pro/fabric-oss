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
		"Search the owner's authorized saved-agent run history by agent, outcome, trigger, time or task. Results are paged metadata; inspect an individual run for output and traces. Return nextCursor unchanged with identical filters; it does not grant access.",
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
		"List the saved agent owner's recent runs, verified status and schedule. Instance ID comes from Fabric's Agents page.",
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
		"Read an authorized saved-agent execution's verified status, partial output and final result.",
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
		"Request cooperative cancellation at the next safe point. requested:true is not completion; completed actions are not undone. Inspect status afterwards.",
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
		"Read the saved agent owner's recurring schedule and whether its engine state is confirmed.",
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
		"Save the owner's one recurring schedule, or pause an existing one with enabled:false. Requires agents:schedule AND agents:execute and current update authority. Enabling requires explicit agent API exposure. An unconfirmed acknowledgement requires inspecting/reconciling the same schedule.",
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
