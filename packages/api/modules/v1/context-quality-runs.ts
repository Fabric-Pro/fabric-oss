import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	cancelContextQualityRun,
	compareContextQualityRuns,
	createContextQualityRun,
	getContextQualityRun,
	getContextQualityRunCapabilities,
	listContextQualityRuns,
} from "../context-quality/lib/saved-commands";
import { contextQualityError } from "../context-quality/lib/transport-errors";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { resolveContextProject } from "./contexts";
import { badRequest, ok } from "./helpers";

type Env = { Variables: ExternalApiVariables };
const BASE = "/projects/:projectId/context-quality/runs";
export function registerSavedContextQualityRoutes(app: Hono<Env>) {
	app.use(BASE, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	app.use(`${BASE}/*`, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	async function actor(c: Context<Env>) {
		return resolveContextProject(
			c.req.param("projectId") ?? "",
			c.get("externalApiContext"),
			{
				org: c.req.query("org"),
				personal: c.req.query("personal") === "1",
			},
			{
				permission: Permissions.CONTEXT_READ,
				refusal: "No permission to read project context.",
				organizationRefusal:
					"Saved evaluations require an organization project.",
				personalRefusal:
					"Saved evaluations require an organization project.",
			},
		);
	}
	async function invoke(
		c: Context<Env>,
		fn: (actor: {
			organizationId: string;
			projectId: string;
			userId: string;
		}) => Promise<unknown>,
	) {
		const resolved = await actor(c);
		if ("error" in resolved)
			return c.json({ error: resolved.error }, resolved.status);
		try {
			return c.json(
				ok(
					await fn({
						...resolved,
						projectId: c.req.param("projectId") ?? "",
					}),
				),
			);
		} catch (error) {
			const safe = contextQualityError(error);
			if (safe)
				return c.json(
					{ error: { message: safe.message } },
					safe.status,
				);
			throw new Error("Saved evaluation request could not be completed.");
		}
	}
	app.get(`${BASE}/capabilities`, requireScope("projects:read"), (c) =>
		invoke(c, getContextQualityRunCapabilities),
	);
	app.get(`${BASE}/compare`, requireScope("projects:read"), (c) =>
		invoke(c, (a) =>
			compareContextQualityRuns(a, {
				baselineId: c.req.query("baselineId") ?? "",
				candidateId: c.req.query("candidateId") ?? "",
			}),
		),
	);
	app.get(BASE, requireScope("projects:read"), (c) =>
		invoke(c, (a) =>
			listContextQualityRuns(a, {
				limit:
					c.req.query("limit") === undefined
						? 20
						: Number(c.req.query("limit")),
				cursor: c.req.query("cursor"),
			}),
		),
	);
	app.get(`${BASE}/:runId`, requireScope("projects:read"), (c) =>
		invoke(c, (a) =>
			getContextQualityRun(a, { runId: c.req.param("runId") ?? "" }),
		),
	);
	app.post(
		BASE,
		requireScope("projects:write"),
		bodyLimit({
			maxSize: 128 * 1024,
			onError: (c) =>
				c.json(badRequest("Evaluation request is too large."), 413),
		}),
		async (c) => {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json(
					badRequest("Use a valid JSON evaluation request."),
					400,
				);
			}
			return invoke(c, (a) => createContextQualityRun(a, body));
		},
	);
	app.post(`${BASE}/:runId/cancel`, requireScope("projects:write"), (c) =>
		invoke(c, (a) =>
			cancelContextQualityRun(a, { runId: c.req.param("runId") ?? "" }),
		),
	);
}
