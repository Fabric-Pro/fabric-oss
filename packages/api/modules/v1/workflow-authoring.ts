import type { Hono } from "hono";
import { ZodError } from "zod";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	checkWorkflowReadiness,
	createWorkflowFromStarter,
	listWorkflowStarters,
} from "../workflows/lib/workflow-authoring";
import { WorkflowCommandError } from "../workflows/lib/workflow-command-context";
import { ok, resolveV1Context } from "./helpers";
export function registerWorkflowAuthoringRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	for (const [path, scope, method] of [
		["/workflows/starters", "workflows:read", "list"],
		["/workflows/starters", "workflows:write", "create"],
		["/workflows/:id/readiness", "workflows:read", "check"],
	] as const) {
		app.on(
			method === "create" ? "POST" : "GET",
			path,
			requireScope(scope),
			async (c) => {
				c.header("Cache-Control", "private, no-store");
				const api = c.get("externalApiContext");
				const ctx = await resolveV1Context(api, c.req.query("org"));
				if ("error" in ctx)
					return c.json(
						{ error: { message: ctx.error } },
						ctx.status,
					);
				if (!ctx.organizationId)
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
				const actor = {
					userId: ctx.userId,
					organizationId: ctx.organizationId,
				};
				try {
					const result =
						method === "list"
							? await listWorkflowStarters(actor)
							: method === "check"
								? await checkWorkflowReadiness(actor, {
										id: c.req.param("id"),
									})
								: await createWorkflowFromStarter(
										actor,
										JSON.parse(await c.req.text()),
									);
					return c.json(ok(result));
				} catch (error) {
					if (
						error instanceof SyntaxError ||
						error instanceof ZodError
					)
						return c.json(
							{
								error: {
									code: "BAD_REQUEST",
									message:
										"Use the declared workflow request schema.",
								},
							},
							400,
						);
					if (error instanceof WorkflowCommandError)
						return c.json(
							{
								error: {
									code: error.code,
									message: error.message,
								},
							},
							error.code === "FORBIDDEN"
								? 403
								: error.code === "NOT_FOUND"
									? 404
									: 400,
						);
					return c.json(
						{
							error: {
								code: "SERVICE_UNAVAILABLE",
								message:
									"The workflow request could not finish.",
							},
						},
						503,
					);
				}
			},
		);
	}
}
