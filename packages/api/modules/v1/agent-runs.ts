import { ORPCError } from "@orpc/server";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { recordAuditFromRequest } from "../../lib/audit";
import {
	cancelAgentRunCommand,
	getAgentRunCommand,
	listAgentRunCommand,
	type RunCommandActor,
	readAgentRunScheduleCommand,
	scheduleAgentRunCommand,
} from "../agent-deployments/lib/run-commands";
import { searchAgentRunCommand } from "../agent-deployments/lib/run-history";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { ok, resolveV1Context } from "./helpers";

type Env = { Variables: ExternalApiVariables };
/** External controls never call the Portal-only start command or synthesize an oRPC session. */
export function registerAgentRunRoutes(app: Hono<Env>) {
	async function invoke(
		c: Context<Env>,
		command: (actor: RunCommandActor) => Promise<unknown>,
	) {
		c.header("Cache-Control", "private, no-store");
		const api = c.get("externalApiContext");
		const resolved = await resolveV1Context(api, c.req.query("org"));
		if ("error" in resolved) {
			return c.json(
				{
					error: {
						code: "ORGANIZATION_REQUIRED",
						message: resolved.error,
					},
				},
				resolved.status,
			);
		}
		if (!resolved.organizationId) {
			return c.json(
				{
					error: {
						code: "ORGANIZATION_REQUIRED",
						message: "An organization is required.",
					},
				},
				403,
			);
		}
		try {
			return c.json(
				ok(
					await command({
						...resolved,
						organizationId: resolved.organizationId,
						external: true,
					}),
				),
			);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "Invalid run control input.",
						},
					},
					400,
				);
			}
			if (error instanceof ORPCError) {
				return c.json(
					{
						error: {
							code: error.code,
							message: error.message,
							...(error.code === "SERVICE_UNAVAILABLE" &&
							typeof error.data === "object" &&
							error.data !== null &&
							"scheduleSaved" in error.data &&
							error.data.scheduleSaved === true
								? {
										data: {
											scheduleSaved: true,
											schedulingState: "UNKNOWN",
										},
									}
								: {}),
						},
					},
					error.code === "FORBIDDEN"
						? 403
						: error.code === "NOT_FOUND"
							? 404
							: error.code === "CONFLICT"
								? 409
								: error.code === "SERVICE_UNAVAILABLE"
									? 503
									: error.code === "TOO_MANY_REQUESTS"
										? 429
										: 400,
				);
			}
			throw error;
		}
	}
	const audit =
		(c: Context<Env>) =>
		async (event: Parameters<typeof recordAuditFromRequest>[1]) =>
			recordAuditFromRequest(
				{ headers: c.req.raw.headers },
				{
					...event,
					actor: {
						type:
							c.get("externalApiContext").keyType === "oauth"
								? "agent"
								: "api_key",
						userId: c.get("externalApiContext").userId,
					},
				},
			);
	app.get("/agent-runs", requireScope("agents:read"), (c) =>
		invoke(c, (actor) =>
			searchAgentRunCommand(actor, {
				instanceId: c.req.query("instanceId"),
				status: c.req.query("status"),
				triggerType: c.req.query("triggerType"),
				from: c.req.query("from"),
				to: c.req.query("to"),
				query: c.req.query("query"),
				cursor: c.req.query("cursor"),
				limit:
					c.req.query("limit") === undefined
						? 25
						: Number(c.req.query("limit")),
			}),
		),
	);

	app.get("/agent-instances/:id/runs", requireScope("agents:read"), (c) =>
		invoke(c, (actor) =>
			listAgentRunCommand(actor, {
				instanceId: c.req.param("id"),
				limit:
					c.req.query("limit") === undefined
						? 20
						: Number(c.req.query("limit")),
			}),
		),
	);
	app.get(
		"/agent-instances/:id/run-schedule",
		requireScope("agents:read"),
		(c) =>
			invoke(c, (actor) =>
				readAgentRunScheduleCommand(actor, {
					instanceId: c.req.param("id"),
				}),
			),
	);
	app.put(
		"/agent-instances/:id/run-schedule",
		requireScope("agents:execute"),
		requireScope("agents:schedule"),
		bodyLimit({ maxSize: 128 * 1024 }),
		async (c) => {
			const body: unknown = await c.req.json().catch(() => null);
			return invoke(c, (actor) =>
				scheduleAgentRunCommand(
					actor,
					body && typeof body === "object" && !Array.isArray(body)
						? { ...body, instanceId: c.req.param("id") }
						: body,
					audit(c),
				),
			);
		},
	);
	app.post(
		"/agent-executions/:executionId/cancel",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: 1024 }),
		async (c) => {
			const raw = await c.req.text();
			// No input may change the pinned run or actor. Empty body and {} are equivalent.
			if (raw.trim() && raw.trim() !== "{}") {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "Cancellation accepts no request body.",
						},
					},
					400,
				);
			}
			return invoke(c, (actor) =>
				cancelAgentRunCommand(
					actor,
					{ executionId: c.req.param("executionId") },
					audit(c),
				),
			);
		},
	);
	app.get(
		"/agent-executions/:executionId",
		requireScope("agents:read"),
		(c) =>
			invoke(c, (actor) =>
				getAgentRunCommand(actor, {
					executionId: c.req.param("executionId"),
				}),
			),
	);
}
