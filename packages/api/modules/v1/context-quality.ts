import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { contextQualityIdSchema } from "../context-quality/contracts";
import {
	evaluateProjectContext,
	inspectContextQualitySource,
} from "../context-quality/lib/commands";
import { contextQualityError } from "../context-quality/lib/transport-errors";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { registerAgentResultQualityRoutes } from "./agent-result-quality";
import { registerSavedContextQualityRoutes } from "./context-quality-runs";
import { resolveContextProject } from "./contexts";
import { badRequest, ok } from "./helpers";

const BASE = "/projects/:projectId/context-quality";

export function registerContextQualityRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	registerSavedContextQualityRoutes(app);
	registerAgentResultQualityRoutes(app);
	const authorize = async (c: Context<{ Variables: ExternalApiVariables }>) =>
		resolveContextProject(
			c.req.param("projectId") ?? "",
			c.get("externalApiContext"),
			{
				org: c.req.query("org"),
				personal: c.req.query("personal") === "1",
			},
			{
				permission: Permissions.CONTEXT_READ,
				refusal:
					"No permission to read context sources of this project",
				organizationRefusal:
					"Context quality requires an organization project",
				personalRefusal:
					"Context quality is an organization surface; ?personal=1 is not supported",
			},
		);
	app.use(`${BASE}/*`, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	app.get(
		`${BASE}/sources/:sourceId`,
		requireScope("projects:read"),
		async (c) => {
			const actor = await authorize(c);
			if ("error" in actor) {
				return c.json({ error: actor.error }, actor.status);
			}
			if (
				!contextQualityIdSchema.safeParse(c.req.param("sourceId"))
					.success
			) {
				return c.json(badRequest("Invalid source identifier"), 400);
			}
			try {
				return c.json(
					ok(
						await inspectContextQualitySource(
							{
								...actor,
								projectId: c.req.param("projectId") ?? "",
							},
							c.req.param("sourceId") ?? "",
						),
					),
				);
			} catch (error) {
				const refusal = contextQualityError(error);
				if (refusal) {
					return c.json(
						{ error: { message: refusal.message } },
						refusal.status,
					);
				}
				throw error;
			}
		},
	);
	app.post(
		`${BASE}/evaluate`,
		requireScope("projects:read"),
		bodyLimit({
			maxSize: 128 * 1024,
			onError: (c) =>
				c.json(badRequest("Evaluation request is too large"), 413),
		}),
		async (c) => {
			const actor = await authorize(c);
			if ("error" in actor) {
				return c.json({ error: actor.error }, actor.status);
			}
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}
			try {
				return c.json(
					ok(
						await evaluateProjectContext(
							{
								...actor,
								projectId: c.req.param("projectId") ?? "",
							},
							body,
						),
					),
				);
			} catch (error) {
				const refusal = contextQualityError(error);
				if (refusal) {
					return c.json(
						{ error: { message: refusal.message } },
						refusal.status,
					);
				}
				throw error;
			}
		},
	);
}
