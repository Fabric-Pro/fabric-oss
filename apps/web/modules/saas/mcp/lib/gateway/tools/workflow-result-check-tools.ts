import {
	applyWorkflowCheckSchema,
	checkIdentitySchema,
	inspectWorkflowResultSchema,
	previewWorkflowCheckSchema,
	removeWorkflowCheckSchema,
	saveWorkflowCheckSchema,
} from "@repo/api/modules/workflows/lib/result-check-contracts";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";
export function createWorkflowResultCheckTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	for (const [name, operation, schema, write] of [
		[
			"fabric_inspect_workflow_result",
			"inspectWorkflowResult",
			inspectWorkflowResultSchema,
			false,
		],
		[
			"fabric_list_workflow_checks",
			"listWorkflowChecks",
			checkIdentitySchema,
			false,
		],
		[
			"fabric_preview_workflow_check",
			"previewWorkflowCheck",
			previewWorkflowCheckSchema,
			false,
		],
		[
			"fabric_save_workflow_check",
			"saveWorkflowCheck",
			saveWorkflowCheckSchema,
			true,
		],
		[
			"fabric_apply_workflow_check",
			"applyWorkflowCheck",
			applyWorkflowCheckSchema,
			false,
		],
		[
			"fabric_remove_workflow_check",
			"removeWorkflowCheck",
			removeWorkflowCheckSchema,
			true,
		],
	] as const) {
		const scope = write ? "workflows:write" : "workflows:read";
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema, {
			io: "input",
		});
		definitions.push({
			name,
			scope,
			inputSchema,
			description:
				operation === "saveWorkflowCheck"
					? "Save a passing recorded result as a reusable deterministic result check. Requires an inspected revision. Never runs a workflow or invokes a model."
					: operation === "applyWorkflowCheck"
						? "Compare a completed workflow result with a saved baseline using identical versioned deterministic checks. No target or retrieval is invoked."
						: operation === "removeWorkflowCheck"
							? "Remove a saved workflow result check. Does not delete its original run."
							: operation === "previewWorkflowCheck"
								? "Preview exact-phrase or versioned bounded JSON checks against an inspected recorded workflow result. No target is invoked or evidence exported."
								: operation === "inspectWorkflowResult"
									? "Inspect an authorized completed workflow step's exact text and revision for checking."
									: "List an owned workflow's reusable recorded-result checks.",
			annotations: {
				readOnlyHint: !write,
				destructiveHint: operation === "removeWorkflowCheck",
				idempotentHint: !write,
			},
			...(write ? { confirm: "always" as const } : {}),
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
			if (
				write &&
				session.credential !== "session" &&
				!session.scopes.includes("workflows:read") &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					"Saved check changes require workflows:read as well as workflows:write.",
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			const input = schema.safeParse(args);
			if (!input.success) {
				return errorResult(
					"Use the declared recorded-result check schema.",
					{ code: "BAD_REQUEST" },
				);
			}
			try {
				const commands = await import(
					"@repo/api/modules/workflows/lib/workflow-result-checks"
				);
				return jsonResult(
					await commands[operation](
						{
							userId: session.userId,
							organizationId: session.organizationId,
						},
						input.data,
					),
				);
			} catch (error) {
				const { WorkflowCommandError } = await import(
					"@repo/api/modules/workflows/lib/workflow-command-context"
				);
				return error instanceof WorkflowCommandError
					? errorResult(error.message, { code: error.code })
					: errorResult(
							"The result check could not finish. No workflow or model was invoked.",
							{ code: "SERVICE_UNAVAILABLE" },
						);
			}
		});
	}
	return toolFamily(definitions, handlers);
}
