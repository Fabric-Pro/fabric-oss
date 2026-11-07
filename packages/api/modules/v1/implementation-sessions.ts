import { ORPCError } from "@orpc/client";
import { type Permission, Permissions } from "@repo/permissions";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { recordAuditFromRequest } from "../../lib/audit";
import type { CodingRunActor } from "../coding-runs/lib/commands-access";

import type { ExternalApiVariables } from "../external-api/types";
import { resolveContextProject } from "./contexts";
import { badRequest, ok } from "./helpers";

type Env = { Variables: ExternalApiVariables };
/** Project execution is authorized by current object grants, including invited guests.
 * requireApiKey already validates the live credential creator; an organization-only
 * execution floor here would accidentally deny a valid explicit project grant. */
function requireImplementationScope(scope: "agents:read" | "agents:execute") {
	return async (c: Context<Env>, next: Next) => {
		const actor = c.get("externalApiContext");
		if (!actor) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (!actor.scopes.includes(scope) && !actor.scopes.includes("*")) {
			return c.json({ error: `Missing required scope: ${scope}` }, 403);
		}
		await next();
	};
}
const sharedCommands = () =>
	import("../coding-runs/lib/implementation-commands");
const readCommand =
	(
		name:
			| "listImplementationSessions"
			| "getImplementationSession"
			| "getImplementationMessages",
	) =>
	async (actor: CodingRunActor, input: Record<string, unknown>) =>
		(await sharedCommands())[name](actor, input);
const BASE = "/projects/:projectId/implementation-sessions";
export function registerImplementationSessionRoutes(app: Hono<Env>) {
	const audit =
		(c: Context<Env>, actor: CodingRunActor) =>
		(event: Parameters<typeof recordAuditFromRequest>[1]) =>
			recordAuditFromRequest(
				{ headers: c.req.raw.headers },
				{
					...event,
					actor: {
						type:
							c.get("externalApiContext").keyType === "oauth"
								? "agent"
								: "api_key",
						userId: actor.userId,
					},
				},
			);
	async function invoke(
		c: Context<Env>,
		permission: Permission,
		command: (
			actor: CodingRunActor,
			input: Record<string, unknown>,
		) => Promise<unknown>,
		body: Record<string, unknown> = {},
	) {
		c.header("Cache-Control", "private, no-store");
		const projectId = c.req.param("projectId") ?? "";
		const actor = await resolveContextProject(
			projectId,
			c.get("externalApiContext"),
			{
				org: c.req.query("org"),
				personal: c.req.query("personal") === "1",
			},
			{
				permission,
				refusal:
					"Your current role does not permit this implementation-session operation.",
			},
		);
		if ("error" in actor) {
			return c.json({ error: actor.error }, actor.status);
		}
		try {
			return c.json(
				ok(
					await command(
						{
							userId: actor.userId,
							organizationId: actor.organizationId,
						},
						{
							...body,
							projectId,
							...(c.req.param("id")
								? { id: c.req.param("id") }
								: {}),
						},
					),
				),
			);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return c.json(
					badRequest(
						"Use the declared implementation-session schema.",
					),
					400,
				);
			}
			if (error instanceof ORPCError) {
				return c.json(
					{
						error: {
							code: error.code,
							message: [
								"INTERNAL_SERVER_ERROR",
								"SERVICE_UNAVAILABLE",
							].includes(error.code)
								? "The session outcome is unavailable. Inspect the existing session before retrying; do not start a replacement."
								: error.message,
						},
					},
					error.code === "NOT_FOUND"
						? 404
						: error.code === "FORBIDDEN"
							? 403
							: error.code === "CONFLICT" ||
									error.code === "PRECONDITION_FAILED"
								? 409
								: error.code === "INTERNAL_SERVER_ERROR" ||
										error.code === "SERVICE_UNAVAILABLE"
									? 503
									: 400,
				);
			}
			throw error;
		}
	}
	app.get(BASE, requireImplementationScope("agents:read"), (c) =>
		invoke(
			c,
			Permissions.AGENT_READ,
			readCommand("listImplementationSessions"),
			{
				storyId: c.req.query("storyId"),
				cursor: c.req.query("cursor"),
				limit:
					c.req.query("limit") === undefined
						? 20
						: Number(c.req.query("limit")),
			},
		),
	);
	app.get(`${BASE}/:id`, requireImplementationScope("agents:read"), (c) =>
		invoke(
			c,
			Permissions.AGENT_READ,
			readCommand("getImplementationSession"),
		),
	);
	app.get(
		`${BASE}/:id/messages`,
		requireImplementationScope("agents:read"),
		(c) =>
			invoke(
				c,
				Permissions.AGENT_READ,
				readCommand("getImplementationMessages"),
			),
	);
	app.post(
		BASE,
		requireImplementationScope("agents:execute"),
		bodyLimit({ maxSize: 16_384 }),
		async (c) => {
			let body: Record<string, unknown>;
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Use a valid JSON request."), 400);
			}
			return invoke(
				c,
				Permissions.AGENT_EXECUTE,
				async (actor, input) =>
					(await sharedCommands()).startImplementationSession(
						actor,
						input,
						audit(c, actor),
					),
				body,
			);
		},
	);
	app.post(
		`${BASE}/:id/cancel`,
		requireImplementationScope("agents:execute"),
		(c) =>
			invoke(c, Permissions.AGENT_DELETE, async (actor, input) =>
				(await sharedCommands()).cancelImplementationSession(
					actor,
					input,
					audit(c, actor),
				),
			),
	);
	app.post(
		`${BASE}/:id/follow-up`,
		requireImplementationScope("agents:execute"),
		bodyLimit({ maxSize: 32_768 }),
		async (c) => {
			let body: Record<string, unknown>;
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Use a valid JSON request."), 400);
			}
			return invoke(
				c,
				Permissions.AGENT_EXECUTE,
				async (actor, input) =>
					(await sharedCommands()).followUpImplementationSession(
						actor,
						input,
						(event) =>
							recordAuditFromRequest(
								{ headers: c.req.raw.headers },
								{
									...event,
									actor: {
										type:
											c.get("externalApiContext")
												.keyType === "oauth"
												? "agent"
												: "api_key",
										userId: actor.userId,
									},
								},
							),
					),
				body,
			);
		},
	);
}
