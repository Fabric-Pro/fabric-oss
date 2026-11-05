import { ORPCError } from "@orpc/server";
import type { AgentPreviewActor } from "@repo/temporal/agent-preview-contracts";
import { AGENT_PREVIEW_MAX_BYTES } from "@repo/temporal/agent-preview-contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { recordAuditFromRequest } from "../../lib/audit";
import {
	type AgentPreviewAudit,
	cancelAgentPreviewCommand,
	getAgentPreviewCommand,
	startAgentPreviewCommand,
} from "../agents/lib/agent-preview-commands";
import { agentPreviewSelectionScopePolicy } from "../agents/lib/agent-preview-selection-policy";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { ok, resolveV1Context } from "./helpers";

type Env = { Variables: ExternalApiVariables };
export function registerAgentPreviewRoutes(app: Hono<Env>) {
	async function invoke(
		c: Context<Env>,
		command: (
			actor: AgentPreviewActor,
			audit: AgentPreviewAudit,
		) => Promise<unknown>,
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
					await command(
						{
							userId: resolved.userId,
							organizationId: resolved.organizationId,
						},
						(event) =>
							recordAuditFromRequest(
								{ headers: c.req.raw.headers },
								{
									...event,
									actor: {
										type:
											api.keyType === "oauth"
												? "agent"
												: "api_key",
										userId: api.userId,
									},
								},
							),
					),
				),
			);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "Use the declared draft preview schema.",
						},
					},
					400,
				);
			}
			if (error instanceof ORPCError) {
				return c.json(
					{
						error: {
							code:
								error.code === "FORBIDDEN" &&
								error.data &&
								typeof error.data === "object" &&
								"code" in error.data &&
								error.data.code === "INSUFFICIENT_SCOPE"
									? "INSUFFICIENT_SCOPE"
									: error.code,
							message: error.message,
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
									: 400,
				);
			}
			throw error;
		}
	}
	app.post(
		"/agent-previews",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: AGENT_PREVIEW_MAX_BYTES }),
		async (c) => {
			const body: unknown = await c.req.json().catch(() => null);
			return invoke(c, (actor, audit) =>
				startAgentPreviewCommand(
					actor,
					body,
					audit,
					agentPreviewSelectionScopePolicy(
						c.get("externalApiContext").scopes,
					),
				),
			);
		},
	);
	app.get("/agent-previews/:workflowId", requireScope("agents:read"), (c) =>
		invoke(c, (actor) =>
			getAgentPreviewCommand(
				actor,
				{
					workflowId: c.req.param("workflowId"),
					runId: c.req.query("runId"),
				},
				agentPreviewSelectionScopePolicy(
					c.get("externalApiContext").scopes,
				),
			),
		),
	);
	app.post(
		"/agent-previews/:workflowId/cancel",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: 1024 }),
		async (c) => {
			const text = await c.req.text();
			if (text.trim() && text.trim() !== "{}") {
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
			return invoke(c, (actor, audit) =>
				cancelAgentPreviewCommand(
					actor,
					{
						workflowId: c.req.param("workflowId"),
						runId: c.req.query("runId"),
					},
					audit,
					agentPreviewSelectionScopePolicy(
						c.get("externalApiContext").scopes,
					),
				),
			);
		},
	);
}
