import { Permissions } from "@repo/permissions";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { agentResultCommands } from "../context-quality/lib/agent-result";
import { contextQualityError } from "../context-quality/lib/transport-errors";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { resolveContextProject } from "./contexts";
import { ok } from "./helpers";

export function registerAgentResultQualityRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	const root =
		"/projects/:projectId/context-quality/agent-results/:executionId";
	for (const operation of ["inspect", "evaluate"] as const) {
		const route = operation === "inspect" ? root : `${root}/evaluate`;
		app.on(
			operation === "inspect" ? "GET" : "POST",
			route,
			async (c, next) => {
				c.header("Cache-Control", "private, no-store");
				await next();
			},
			requireScope("projects:read"),
			requireScope("agents:read"),
			bodyLimit({ maxSize: 128 * 1024 }),
			async (c) => {
				const projectId = c.req.param("projectId") ?? "";
				const actor = await resolveContextProject(
					projectId,
					c.get("externalApiContext"),
					{ org: c.req.query("org"), personal: false },
					{
						permission: Permissions.CONTEXT_READ,
						refusal:
							"Current project context permission is required.",
					},
				);
				if ("error" in actor) {
					return c.json({ error: actor.error }, actor.status);
				}
				try {
					let body: unknown = {};
					if (operation === "evaluate") {
						try {
							body = await c.req.json();
						} catch {
							return c.json(
								{
									error: {
										code: "BAD_REQUEST",
										message:
											"Use valid bounded run expectations.",
									},
								},
								400,
							);
						}
					}
					// A client cannot override the path identity or supply a recorded answer/actor.
					if (
						!body ||
						typeof body !== "object" ||
						Array.isArray(body) ||
						"executionId" in body
					) {
						return c.json(
							{
								error: {
									code: "BAD_REQUEST",
									message:
										"Use the declared run-check schema.",
								},
							},
							400,
						);
					}
					return c.json(
						ok(
							await (await agentResultCommands())[operation](
								{ ...actor, projectId },
								{
									...body,
									executionId: c.req.param("executionId"),
								},
							),
						),
					);
				} catch (error) {
					const safe = contextQualityError(error);
					return c.json(
						{
							error: {
								code: safe?.code ?? "SERVICE_UNAVAILABLE",
								message:
									safe?.message ??
									"The agent result could not be verified.",
							},
						},
						safe?.status ?? 503,
					);
				}
			},
		);
	}
}
