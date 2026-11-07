import type { RecordAuditFromRequestInput } from "@repo/api/lib/audit";
import {
	type AgentPreviewSelectionPolicy,
	agentPreviewSelectionScopePolicy,
} from "@repo/api/modules/agents/lib/agent-preview-selection-policy";
import {
	AGENT_TEST_MAX_BYTES,
	type AgentTestActor,
	AgentTestError,
	agentTestCaseArchiveSchema,
	agentTestCaseCreateSchema,
	agentTestCaseListSchema,
	agentTestCaseUpdateSchema,
	agentTestCompareSchema,
	agentTestErrorDataSchema,
	agentTestRunIdentitySchema,
	agentTestRunListSchema,
	agentTestRunStartSchema,
} from "@repo/temporal/agent-test-contracts";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

type Audit = (event: RecordAuditFromRequestInput) => unknown;
export function createAgentTestTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	function add<S extends z.ZodType>(
		name: string,
		description: string,
		schema: S,
		write: boolean,
		command: (
			actor: AgentTestActor,
			input: z.output<S>,
			audit: Audit,
			policy?: AgentPreviewSelectionPolicy,
		) => Promise<unknown>,
	) {
		const scope = write ? "agents:execute" : "agents:read";
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
		definitions.push({
			name,
			description,
			inputSchema,
			scope,
			annotations: {
				readOnlyHint: !write,
				idempotentHint:
					!write ||
					name === "fabric_start_agent_test_run" ||
					name === "fabric_cancel_agent_test_run",
			},
			...(write ? { confirm: "always" as const } : {}),
		});
		handlers.set(name, async (args, session) => {
			if (
				session.credential !== "session" &&
				!session.scopes.includes(scope) &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					`Agent tests require the declared ${scope} scope.`,
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			if (
				!session.organizationId ||
				session.projectId ||
				session.pinnedProjectId ||
				session.pageProjectId ||
				session.credential === "service"
			) {
				return errorResult(
					"Agent tests require an organization connection for the current member. Project-bound and runtime-service connections are not supported.",
					{ code: "FORBIDDEN" },
				);
			}
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return errorResult(
					"Use the declared agent-test schema. Actor, owner and organization fields are not accepted.",
					{ code: "BAD_REQUEST" },
				);
			}
			try {
				if (
					new TextEncoder().encode(JSON.stringify(args)).byteLength >
					AGENT_TEST_MAX_BYTES
				) {
					return errorResult("Agent-test input exceeds 128 KiB.", {
						code: "BAD_REQUEST",
					});
				}
				return jsonResult(
					await command(
						{
							userId: session.userId,
							organizationId: session.organizationId,
							external: session.credential !== "session",
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
				const admissionData =
					error instanceof AgentTestError
						? agentTestErrorDataSchema.safeParse(error.data)
						: undefined;
				const code =
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "";
				const data =
					error && typeof error === "object" && "data" in error
						? error.data
						: undefined;
				const insufficient =
					data &&
					typeof data === "object" &&
					"code" in data &&
					data.code === "INSUFFICIENT_SCOPE";
				return errorResult(
					[
						"BAD_REQUEST",
						"FORBIDDEN",
						"NOT_FOUND",
						"CONFLICT",
						"SERVICE_UNAVAILABLE",
					].includes(code) && error instanceof Error
						? error.message
						: "Agent test could not be confirmed. Inspect its state before retrying.",
					{
						...(admissionData?.success
							? { data: admissionData.data }
							: {}),
						code: insufficient
							? "INSUFFICIENT_SCOPE"
							: code || "UNAVAILABLE",
					},
				);
			}
		});
	}
	add(
		"fabric_list_agent_test_cases",
		"List your saved recorded-result regression examples for an agent family.",
		agentTestCaseListSchema,
		false,
		async (actor, input, _audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).listAgentTestCasesCommand(actor, input, policy),
	);
	add(
		"fabric_create_agent_test_case",
		"Save an agent test case with a sample task and versioned deterministic checks (exact phrases or bounded JSON assertions). Does not run the agent.",
		agentTestCaseCreateSchema,
		true,
		async (actor, input, audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).createAgentTestCaseCommand(actor, input, audit, policy),
	);
	add(
		"fabric_update_agent_test_case",
		"Update a saved test case using its expected revision. Existing runs retain their frozen revision.",
		agentTestCaseUpdateSchema,
		true,
		async (actor, input, audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).updateAgentTestCaseCommand(actor, input, audit, policy),
	);
	add(
		"fabric_archive_agent_test_case",
		"Archive your saved test case using its expected revision. Does not cancel a running execution.",
		agentTestCaseArchiveSchema,
		true,
		async (actor, input, audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).archiveAgentTestCaseCommand(actor, input, audit, policy),
	);
	add(
		"fabric_start_agent_test_run",
		"Run a saved case against the chosen saved agent version with its live connections and normal permissions. Reuse the UUID key only for an identical retry.",
		agentTestRunStartSchema,
		true,
		async (actor, input, audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).startAgentTestRunCommand(actor, input, audit, policy),
	);
	add(
		"fabric_get_agent_test_run",
		"Read your actual agent test status and deterministic check results. Current source access remains required.",
		agentTestRunIdentitySchema,
		false,
		async (actor, input, _audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).getAgentTestRunCommand(actor, input, policy),
	);
	add(
		"fabric_list_agent_test_runs",
		"List your test history for one saved case across agent versions.",
		agentTestRunListSchema,
		false,
		async (actor, input, _audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).listAgentTestRunsCommand(actor, input, policy),
	);
	add(
		"fabric_cancel_agent_test_run",
		"Request cancellation of your agent test. Inspect status to confirm completion.",
		agentTestRunIdentitySchema,
		true,
		async (actor, input, audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).cancelAgentTestRunCommand(actor, input, audit, policy),
	);
	add(
		"fabric_compare_agent_test_runs",
		"Compare two actual runs of the same frozen case revision; does not execute an agent.",
		agentTestCompareSchema,
		false,
		async (actor, input, _audit, policy) =>
			(
				await import("@repo/api/modules/agents/lib/agent-test-commands")
			).compareAgentTestRunsCommand(actor, input, policy),
	);
	return toolFamily(definitions, handlers);
}
