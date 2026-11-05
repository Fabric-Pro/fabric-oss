import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	applyWorkflowCheckSchema,
	inspectWorkflowResultSchema,
	previewWorkflowCheckSchema,
	removeWorkflowCheckSchema,
	saveWorkflowCheckSchema,
} from "../workflows/lib/result-check-contracts";
import { WorkflowCommandError } from "../workflows/lib/workflow-command-context";
import * as commands from "../workflows/lib/workflow-result-checks";
import { ok, resolveV1Context } from "./helpers";

const actions = {
	inspect: {
		schema: inspectWorkflowResultSchema,
		run: commands.inspectWorkflowResult,
		write: false,
	},
	preview: {
		schema: previewWorkflowCheckSchema,
		run: commands.previewWorkflowCheck,
		write: false,
	},
	save: {
		schema: saveWorkflowCheckSchema,
		run: commands.saveWorkflowCheck,
		write: true,
	},
	apply: {
		schema: applyWorkflowCheckSchema,
		run: commands.applyWorkflowCheck,
		write: false,
	},
	remove: {
		schema: removeWorkflowCheckSchema,
		run: commands.removeWorkflowCheck,
		write: true,
	},
};
export function registerWorkflowResultCheckRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	for (const action of ["list", ...Object.keys(actions)] as const) {
		const write =
			action !== "list" && actions[action as keyof typeof actions].write;
		app.on(
			action === "list" ? "GET" : "POST",
			`/workflows/:id/checks${action === "list" ? "" : `/${action}`}`,
			bodyLimit({ maxSize: 128 * 1024 }),
			requireScope(write ? "workflows:write" : "workflows:read"),
			async (c, next) => {
				if (write) {
					return requireScope("workflows:read")(c, next);
				}
				await next();
			},
			async (c) => {
				c.header("Cache-Control", "private, no-store");
				const resolved = await resolveV1Context(
					c.get("externalApiContext"),
					c.req.query("org"),
				);
				if ("error" in resolved) {
					return c.json(
						{ error: { message: resolved.error } },
						resolved.status,
					);
				}
				if (!resolved.organizationId) {
					return c.json(
						{
							error: {
								code: "FORBIDDEN",
								message: "An organization is required.",
							},
						},
						403,
					);
				}
				const actor = {
					userId: resolved.userId,
					organizationId: resolved.organizationId,
				};
				const workflowId = c.req.param("id");
				try {
					if (action === "list") {
						return c.json(
							ok(
								await commands.listWorkflowChecks(actor, {
									workflowId,
								}),
							),
						);
					}
					const entry = actions[action as keyof typeof actions];
					const body = await c.req.json();
					if (
						!body ||
						typeof body !== "object" ||
						Array.isArray(body) ||
						"workflowId" in body ||
						"organizationId" in body
					) {
						throw new WorkflowCommandError(
							"BAD_REQUEST",
							"Use the workflow in the route, without authority overrides.",
						);
					}
					return c.json(
						ok(
							await entry.run(
								actor,
								entry.schema.parse({ ...body, workflowId }),
							),
						),
					);
				} catch (error) {
					if (
						error instanceof ZodError ||
						error instanceof SyntaxError
					) {
						return c.json(
							{
								error: {
									code: "BAD_REQUEST",
									message:
										"Use the declared result-check schema.",
								},
							},
							400,
						);
					}
					if (error instanceof WorkflowCommandError) {
						return c.json(
							{
								error: {
									code: error.code,
									message: error.message,
								},
							},
							error.code === "NOT_FOUND"
								? 404
								: error.code === "FORBIDDEN"
									? 403
									: error.code === "CONFLICT"
										? 409
										: 400,
						);
					}
					return c.json(
						{
							error: {
								code: "SERVICE_UNAVAILABLE",
								message:
									"The result check could not finish. No workflow or model was invoked.",
							},
						},
						503,
					);
				}
			},
		);
	}
}
