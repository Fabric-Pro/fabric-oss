import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";
export function createWorkflowAuthoringTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	for (const [name, scope, schema] of [
		[
			"fabric_list_workflow_starters",
			"workflows:read",
			z.object({}).strict(),
		],
		[
			"fabric_create_workflow_from_starter",
			"workflows:write",
			z
				.object({
					starterId: z.enum([
						"delivery-brief",
						"action-plan",
						"release-notes",
						"decision-digest",
						"risk-review",
					]),
					name: z.string().trim().min(1).max(255).optional(),
				})
				.strict(),
		],
		[
			"fabric_check_workflow_readiness",
			"workflows:read",
			z.object({ id: z.string().min(1).max(255) }).strict(),
		],
	] as const) {
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
		const creates = name === "fabric_create_workflow_from_starter";
		definitions.push({
			name,
			scope,
			inputSchema,
			description: creates
				? "Create a delivery workflow draft from a built-in starter. Does not publish, schedule, call AI or run."
				: name === "fabric_list_workflow_starters"
					? "List delivery workflow starters available to the current organization member."
					: "Check saved workflow configuration. Does not live-test credentials or external services. Runtime checks remain mandatory.",
			annotations: {
				readOnlyHint: !creates,
				destructiveHint: false,
				idempotentHint: !creates,
			},
			...(creates ? { confirm: "always" as const } : {}),
		});
		handlers.set(name, async (args, session) => {
			if (
				!session.organizationId ||
				session.projectId ||
				session.pinnedProjectId ||
				session.pageProjectId ||
				session.credential === "service"
			)
				return errorResult(
					"A current member organization connection is required.",
					{ code: "FORBIDDEN" },
				);
			if (
				session.credential !== "session" &&
				!session.scopes.includes(scope) &&
				!session.scopes.includes("*")
			)
				return errorResult(`This operation requires ${scope} scope.`, {
					code: "INSUFFICIENT_SCOPE",
				});
			const parsed = schema.safeParse(args);
			if (!parsed.success)
				return errorResult(
					"Use the declared workflow request schema.",
					{ code: "BAD_REQUEST" },
				);
			try {
				const core = await import(
					"@repo/api/modules/workflows/lib/workflow-authoring"
				);
				const actor = {
					userId: session.userId,
					organizationId: session.organizationId,
				};
				return jsonResult(
					await (name === "fabric_list_workflow_starters"
						? core.listWorkflowStarters(actor)
						: creates
							? core.createWorkflowFromStarter(actor, parsed.data)
							: core.checkWorkflowReadiness(actor, parsed.data)),
				);
			} catch (error) {
				const { WorkflowCommandError } = await import(
					"@repo/api/modules/workflows/lib/workflow-command-context"
				);
				return error instanceof WorkflowCommandError
					? errorResult(error.message, { code: error.code })
					: errorResult("The workflow request could not finish.", {
							code: "SERVICE_UNAVAILABLE",
						});
			}
		});
	}
	return toolFamily(definitions, handlers);
}
