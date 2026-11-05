import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	workflowIdentitySchema,
	workflowPublishSchema,
	workflowRollbackSchema,
	workflowScheduleSchema,
} from "../workflows/lib/lifecycle-contracts";
import { WorkflowCommandError } from "../workflows/lib/workflow-command-context";
import {
	changeWorkflowLifecycleCommand,
	configureWorkflowScheduleCommand,
	getWorkflowScheduleCommand,
	listWorkflowVersionsCommand,
} from "../workflows/lib/workflow-lifecycle-commands";
import { ok, resolveV1Context } from "./helpers";

const operations = [
	"publish",
	"unpublish",
	"pause",
	"resume",
	"rollback",
	"schedule",
	"versions",
] as const;
export function registerWorkflowLifecycleRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	for (const operation of operations) {
		const reads = operation === "versions" || operation === "schedule";
		const methods =
			operation === "schedule"
				? ["GET", "PUT"]
				: reads
					? ["GET"]
					: ["POST"];
		for (const method of methods) {
			app.on(
				method,
				`/workflows/:id/${operation}`,
				bodyLimit({ maxSize: 16384 }),
				requireScope(
					method === "GET" ? "workflows:read" : "workflows:write",
				),
				async (c) => {
					c.header("Cache-Control", "private, no-store");
					const context = await resolveV1Context(
						c.get("externalApiContext"),
						c.req.query("org"),
					);
					if ("error" in context) {
						return c.json(
							{ error: { message: context.error } },
							context.status,
						);
					}
					if (!context.organizationId) {
						return c.json(
							{
								error: {
									code: "FORBIDDEN",
									message:
										"An organization connection is required.",
								},
							},
							403,
						);
					}
					const actor = {
						userId: context.userId,
						organizationId: context.organizationId,
					};
					try {
						const workflowId = c.req.param("id");
						let result: unknown;
						if (operation === "versions") {
							result = await listWorkflowVersionsCommand(actor, {
								workflowId,
								limit: Number(c.req.query("limit") ?? 20),
								offset: Number(c.req.query("offset") ?? 0),
							});
						} else if (
							operation === "schedule" &&
							method === "GET"
						) {
							result = await getWorkflowScheduleCommand(actor, {
								workflowId,
							});
						} else {
							const text = await c.req.text();
							if (Buffer.byteLength(text) > 16384) {
								return c.json(
									{
										error: {
											code: "BAD_REQUEST",
											message:
												"The lifecycle request exceeds 16 KiB.",
										},
									},
									400,
								);
							}
							const schema = (
								operation === "publish"
									? workflowPublishSchema
									: operation === "rollback"
										? workflowRollbackSchema
										: operation === "schedule"
											? workflowScheduleSchema
											: workflowIdentitySchema
							).omit({ workflowId: true });
							const body = schema.parse(
								text ? JSON.parse(text) : {},
							);
							result =
								operation === "schedule"
									? await configureWorkflowScheduleCommand(
											actor,
											{ ...body, workflowId },
										)
									: await changeWorkflowLifecycleCommand(
											actor,
											operation,
											{ ...body, workflowId },
										);
						}
						return c.json(ok(result));
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
											"Use the declared workflow lifecycle schema.",
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
											: error.code === "TOO_MANY_REQUESTS"
												? 429
												: error.code ===
														"INTERNAL_SERVER_ERROR"
													? 500
													: 400,
							);
						}
						return c.json(
							{
								error: {
									code: "SERVICE_UNAVAILABLE",
									message:
										"The workflow action could not finish. Check its current state before retrying.",
								},
							},
							503,
						);
					}
				},
			);
		}
	}
}
