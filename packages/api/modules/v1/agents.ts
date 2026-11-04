/**
 * v1 Agents routes
 * GET  /agents        list agents for caller's tenant
 * GET  /agents/:id    get agent details
 */

import { REGISTERED_AGENT_EXECUTION_UNSUPPORTED } from "@repo/agent-types";
import { db, getAgentById, listAgents } from "@repo/database";
import type { Hono } from "hono";
import {
	requireScope,
	requireV1OwnerPermission,
} from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { notFound, ok, resolveV1Context } from "./helpers";

export function registerAgentRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/agents", requireScope("agents:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
		const offset = Number(c.req.query("offset") ?? 0);

		// listAgents returns Agent[] directly (no pagination wrapper)
		const agents = await listAgents({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			limit,
			offset,
			status: c.req.query("status") as
				| "ACTIVE"
				| "INACTIVE"
				| "DEPLOYING"
				| "ERROR"
				| "MAINTENANCE"
				| undefined,
		});

		return c.json(ok(agents, { total: agents.length }));
	});

	app.get("/agents/:id", requireScope("agents:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		// getAgentById already enforces tenant isolation internally
		const agent = await getAgentById(c.req.param("id")!, {
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});

		if (!agent) {
			return c.json(notFound("Agent"), 404);
		}
		return c.json(ok(agent));
	});

	/**
	 * POST /agents/:id/execute
	 * Triggers an agent execution via Temporal.
	 */
	app.post(
		"/agents/:id/execute",
		requireScope("agents:execute"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}
			const permissionRefusal = await requireV1OwnerPermission(
				c,
				ctx,
				"agents:execute",
			);
			if (permissionRefusal) {
				return permissionRefusal;
			}

			if (!ctx.organizationId) {
				return c.json(
					{ error: { message: "An organization is required" } },
					403,
				);
			}
			// Verify agent exists and is accessible
			const agent = await db.agent.findFirst({
				where: {
					id: c.req.param("id")!,
					...(ctx.organizationId
						? { organizationId: ctx.organizationId }
						: { userId: ctx.userId, organizationId: null }),
				},
			});
			if (!agent) {
				return c.json(notFound("Agent"), 404);
			}
			if (agent.status !== "ACTIVE") {
				return c.json(
					{ error: { message: "Agent is not active" } },
					422,
				);
			}

			return c.json(
				{ error: REGISTERED_AGENT_EXECUTION_UNSUPPORTED },
				409,
			);
		},
	);
}
