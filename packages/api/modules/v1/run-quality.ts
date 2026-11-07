import { ORPCError } from "@orpc/server";
import {
	compareSchema,
	configureSchema,
	identitySchema,
	listSchema,
	RunQualityError,
	type RunQualityTarget,
	runQualityTargetSchema,
} from "@repo/utils/run-quality-contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
	type AgentPreviewSelectionPolicy,
	agentPreviewSelectionScopePolicy,
} from "../agents/lib/agent-preview-selection-policy";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import type * as QualityCommands from "../run-quality/lib/commands";

// Public v1 mounts this before authentication/CORS. Resolve heavy source readers only
// after the request passes its scope and tenant gates.
const commands: typeof QualityCommands = {
	getRunQualityPolicy: async (...args) =>
		(await import("../run-quality/lib/commands")).getRunQualityPolicy(
			...args,
		),
	configureRunQualityPolicy: async (...args) =>
		(await import("../run-quality/lib/commands")).configureRunQualityPolicy(
			...args,
		),
	listRunQualityAssessments: async (...args) =>
		(await import("../run-quality/lib/commands")).listRunQualityAssessments(
			...args,
		),
	getRunQualityAssessment: async (...args) =>
		(await import("../run-quality/lib/commands")).getRunQualityAssessment(
			...args,
		),
	cancelRunQualityAssessment: async (...args) =>
		(
			await import("../run-quality/lib/commands")
		).cancelRunQualityAssessment(...args),
	compareRunQualityAssessments: async (...args) =>
		(
			await import("../run-quality/lib/commands")
		).compareRunQualityAssessments(...args),
};

import { ok, resolveV1Context } from "./helpers";

type Env = { Variables: ExternalApiVariables };
export function registerRunQualityRoutes(app: Hono<Env>) {
	async function invoke<S extends z.ZodType<RunQualityTarget>>(
		c: Context<Env>,
		schema: S,
		raw: unknown,
		write: boolean,
		run: (
			actor: { userId: string; organizationId: string },
			input: z.output<S>,
			policy?: AgentPreviewSelectionPolicy,
		) => Promise<unknown>,
	) {
		c.header("Cache-Control", "private, no-store");
		try {
			const api = c.get("externalApiContext");
			if (!api) {
				return c.json(
					{
						error: {
							code: "UNAUTHORIZED",
							message: "Authentication is required.",
						},
					},
					401,
				);
			}
			if (api.boundProjectId !== undefined) {
				return c.json(
					{
						error: {
							code: "FORBIDDEN",
							message:
								"Automatic checks require an organization connection; project-bound connections are not supported.",
						},
					},
					403,
				);
			}
			const input = schema.parse(raw);
			const domain =
				input.targetType === "AGENT" ? "agents" : "workflows";
			for (const scope of [
				`${domain}:read`,
				...(write ? [`${domain}:write`] : []),
			]) {
				if (!api.scopes.includes(scope) && !api.scopes.includes("*")) {
					return c.json(
						{
							error: {
								code: "INSUFFICIENT_SCOPE",
								message: `This operation requires ${scope}.`,
							},
						},
						403,
					);
				}
				let granted = false;
				const refusal = await requireScope(scope)(c, async () => {
					granted = true;
				});
				if (!granted) {
					return (
						refusal ??
						c.json(
							{
								error: {
									code: "FORBIDDEN",
									message: "Current permission is required.",
								},
							},
							403,
						)
					);
				}
			}
			const resolved = await resolveV1Context(api, c.req.query("org"));
			if ("error" in resolved) {
				return c.json(
					{ error: { code: "FORBIDDEN", message: resolved.error } },
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
			return c.json(
				ok(
					await run(
						{
							userId: resolved.userId,
							organizationId: resolved.organizationId,
						},
						input,
						agentPreviewSelectionScopePolicy(api.scopes),
					),
				),
			);
		} catch (error) {
			if (
				error instanceof ORPCError &&
				error.data &&
				typeof error.data === "object" &&
				"code" in error.data &&
				error.data.code === "INSUFFICIENT_SCOPE"
			) {
				return c.json(
					{
						error: {
							code: "INSUFFICIENT_SCOPE",
							message: error.message,
						},
					},
					403,
				);
			}
			if (error instanceof z.ZodError || error instanceof SyntaxError) {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message:
								"Use the declared quality-check schema without actor or organization overrides.",
						},
					},
					400,
				);
			}
			if (error instanceof RunQualityError) {
				return c.json(
					{ error: { code: error.code, message: error.message } },
					error.code === "FORBIDDEN"
						? 403
						: error.code === "NOT_FOUND"
							? 404
							: error.code === "CONFLICT"
								? 409
								: error.code === "UNAVAILABLE"
									? 503
									: 400,
				);
			}
			throw error;
		}
	}
	const target = (c: Context<Env>) => ({
		targetType: c.req.query("targetType"),
		targetId: c.req.query("targetId"),
	});
	app.get("/run-quality/policy", (c) =>
		invoke(
			c,
			runQualityTargetSchema,
			target(c),
			false,
			commands.getRunQualityPolicy,
		),
	);
	app.put(
		"/run-quality/policy",
		bodyLimit({ maxSize: 128 * 1024 }),
		async (c) =>
			invoke(
				c,
				configureSchema,
				await c.req.json().catch(() => null),
				true,
				commands.configureRunQualityPolicy,
			),
	);
	app.get("/run-quality/assessments", (c) =>
		invoke(
			c,
			listSchema,
			{
				...target(c),
				limit:
					c.req.query("limit") === undefined
						? undefined
						: Number(c.req.query("limit")),
				offset:
					c.req.query("offset") === undefined
						? undefined
						: Number(c.req.query("offset")),
			},
			false,
			commands.listRunQualityAssessments,
		),
	);
	app.get("/run-quality/assessments/:assessmentId", (c) =>
		invoke(
			c,
			identitySchema,
			{ ...target(c), assessmentId: c.req.param("assessmentId") },
			false,
			commands.getRunQualityAssessment,
		),
	);
	app.post(
		"/run-quality/assessments/:assessmentId/cancel",
		bodyLimit({ maxSize: 1024 }),
		async (c) => {
			const body = runQualityTargetSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			return invoke(
				c,
				identitySchema,
				body.success
					? {
							...body.data,
							assessmentId: c.req.param("assessmentId"),
						}
					: null,
				true,
				commands.cancelRunQualityAssessment,
			);
		},
	);
	app.post("/run-quality/compare", bodyLimit({ maxSize: 2048 }), async (c) =>
		invoke(
			c,
			compareSchema,
			await c.req.json().catch(() => null),
			false,
			commands.compareRunQualityAssessments,
		),
	);
}
