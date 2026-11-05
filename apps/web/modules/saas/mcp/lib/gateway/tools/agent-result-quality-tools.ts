import {
	evaluateAgentResultSchema,
	inspectAgentResultSchema,
} from "@repo/api/modules/context-quality/agent-run-contracts";
import { agentResultCommands } from "@repo/api/modules/context-quality/lib/agent-result";
import { contextQualityError } from "@repo/api/modules/context-quality/lib/transport-errors";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function createAgentResultQualityTools(
	authorize: (
		projectId: string,
		session: GatewaySession,
	) => Promise<{ organizationId: string | null } | null>,
) {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	for (const operation of ["inspect", "evaluate"] as const) {
		const name =
			operation === "inspect"
				? "fabric_inspect_agent_run_result"
				: "fabric_check_agent_run_result";
		const schema = (
			operation === "inspect"
				? inspectAgentResultSchema
				: evaluateAgentResultSchema
		).safeExtend({ projectId: z.string().trim().min(1).max(128) });
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
		definitions.push({
			name,
			description:
				operation === "inspect"
					? "Inspect your completed project-bound agent run's actual recorded answer and revision. Requires projects:read, agents:read and current owner/project permission. Private read only; no rerun, save or export."
					: "Check literal required/forbidden phrases in your actual agent run. Inspect first, supply expectedRevision; the server reloads the answer. No client-supplied answer, model rerun, factual/citation judge, version replay or shared save. Requires projects:read and agents:read plus current owner/project permission.",
			inputSchema,
			annotations: { readOnlyHint: true, idempotentHint: true },
			scope: "projects:read",
		});
		handlers.set(name, async (raw, session) => {
			if (session.credential === "service") {
				return errorResult(
					"Run-result checks require an explicit owner connection.",
					{ code: "FORBIDDEN" },
				);
			}
			if (
				session.credential !== "session" &&
				!session.scopes.includes("*") &&
				(!session.scopes.includes("agents:read") ||
					!session.scopes.includes("projects:read"))
			) {
				return errorResult(
					"Explicit projects:read and agents:read scopes are required.",
					{
						code: "INSUFFICIENT_SCOPE",
					},
				);
			}
			const parsed = schema.safeParse(raw);
			if (!parsed.success) {
				return errorResult(
					"Use the declared bounded run-result check schema.",
					{ code: "BAD_REQUEST" },
				);
			}
			const { projectId, ...input } = parsed.data;
			if (!sessionMayReachProject(session, projectId)) {
				return errorResult("Project not found or access denied.", {
					code: "NOT_FOUND",
				});
			}
			try {
				const access = await authorize(projectId, session);
				if (!access?.organizationId) {
					return errorResult("Project not found or access denied.", {
						code: "NOT_FOUND",
					});
				}
				return jsonResult(
					await (await agentResultCommands())[operation](
						{
							userId: session.userId,
							organizationId: access.organizationId,
							projectId,
						},
						input,
					),
				);
			} catch (error) {
				const safe = contextQualityError(error);
				return errorResult(
					safe?.message ?? "The agent result could not be verified.",
					{ code: safe?.code ?? "SERVICE_UNAVAILABLE" },
				);
			}
		});
	}
	return toolFamily(definitions, handlers);
}
