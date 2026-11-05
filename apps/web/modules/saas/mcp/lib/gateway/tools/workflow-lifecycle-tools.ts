import {
	workflowIdentitySchema,
	workflowRollbackSchema,
	workflowScheduleSchema,
	workflowVersionsSchema,
} from "@repo/api/modules/workflows/lib/lifecycle-contracts";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";
export function createWorkflowLifecycleTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	for (const [name, scope, schema] of [
		[
			"fabric_list_workflow_versions",
			"workflows:read",
			workflowVersionsSchema,
		],
		["fabric_rollback_workflow", "workflows:write", workflowRollbackSchema],
		[
			"fabric_get_workflow_schedule",
			"workflows:read",
			workflowIdentitySchema,
		],
		[
			"fabric_configure_workflow_schedule",
			"workflows:write",
			workflowScheduleSchema,
		],
	] as const) {
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema, {
			io: "input",
		});
		const writes = scope === "workflows:write";
		definitions.push({
			name,
			scope,
			inputSchema,
			description:
				name === "fabric_configure_workflow_schedule"
					? "Save a workflow schedule draft. Publishing is a separate deliberate activation step."
					: name === "fabric_rollback_workflow"
						? "Restore a previously published workflow version after current authorization and validation checks."
						: name === "fabric_list_workflow_versions"
							? "List an owned workflow's saved versions."
							: "Read the draft and published schedule and actual Temporal schedule state. Does not change execution.",
			annotations: {
				readOnlyHint: !writes,
				destructiveHint: name === "fabric_rollback_workflow",
				idempotentHint: !writes,
			},
			...(writes ? { confirm: "always" as const } : {}),
		});
		handlers.set(name, async (args, session) => {
			if (
				!session.organizationId ||
				session.projectId ||
				session.pinnedProjectId ||
				session.pageProjectId ||
				session.credential === "service"
			) {
				return errorResult(
					"A member organization connection is required.",
					{ code: "FORBIDDEN" },
				);
			}
			if (
				session.credential !== "session" &&
				!session.scopes.includes(scope) &&
				!session.scopes.includes("*")
			) {
				return errorResult(`This operation requires ${scope} scope.`, {
					code: "INSUFFICIENT_SCOPE",
				});
			}
			const input = schema.safeParse(args);
			if (!input.success) {
				return errorResult(
					"Use the declared workflow lifecycle schema.",
					{ code: "BAD_REQUEST" },
				);
			}
			try {
				const core = await import(
					"@repo/api/modules/workflows/lib/workflow-lifecycle-commands"
				);
				const actor = {
					userId: session.userId,
					organizationId: session.organizationId,
				};
				return jsonResult(
					await (name === "fabric_list_workflow_versions"
						? core.listWorkflowVersionsCommand(actor, input.data)
						: name === "fabric_get_workflow_schedule"
							? core.getWorkflowScheduleCommand(actor, input.data)
							: name === "fabric_configure_workflow_schedule"
								? core.configureWorkflowScheduleCommand(
										actor,
										input.data,
									)
								: core.changeWorkflowLifecycleCommand(
										actor,
										"rollback",
										input.data,
									)),
				);
			} catch (error) {
				const { WorkflowCommandError } = await import(
					"@repo/api/modules/workflows/lib/workflow-command-context"
				);
				return error instanceof WorkflowCommandError
					? errorResult(error.message, { code: error.code })
					: errorResult(
							"The workflow action could not finish. Check its state before retrying.",
							{ code: "SERVICE_UNAVAILABLE" },
						);
			}
		});
	}
	return toolFamily(definitions, handlers);
}
