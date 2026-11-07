import { FrameReviewError } from "@repo/database";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireScope } from "../../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../../external-api/types";
import { ok, resolveV1Context } from "../../v1/helpers";
import {
	createAuthoredFrame,
	createAuthoredFrameFromTemplate,
	createAuthoredFrameTemplate,
	getAuthoredFrameTemplate,
	listAuthoredFrameTemplates,
	validateAuthoredFrame,
} from "./frame-authoring-commands";
export function registerFrameAuthoringRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	const actions = [
		["POST", "/frames", "frames:write", createAuthoredFrame],
		["POST", "/frames/validate", "frames:read", validateAuthoredFrame],
		[
			"POST",
			"/frames/from-template",
			"frames:write",
			createAuthoredFrameFromTemplate,
		],
		["GET", "/frame-templates", "frames:read", listAuthoredFrameTemplates],
		[
			"GET",
			"/frame-templates/:templateId",
			"frames:read",
			getAuthoredFrameTemplate,
		],
		[
			"POST",
			"/frame-templates",
			"frames:write",
			createAuthoredFrameTemplate,
		],
	] as const;
	for (const [method, path, scope, operation] of actions) {
		const handler = async (
			c: import("hono").Context<{ Variables: ExternalApiVariables }>,
		) => {
			const ctx = await resolveV1Context(
				c.get("externalApiContext"),
				c.req.query("org"),
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}
			if (
				!ctx.organizationId ||
				c.get("externalApiContext").boundProjectId
			) {
				return c.json(
					{
						error: {
							message:
								"Use an organization connection for page authoring.",
						},
					},
					403,
				);
			}
			try {
				let input: unknown = {};
				if (method === "POST") {
					const text = await c.req.text();
					if (Buffer.byteLength(text, "utf8") > 1_100_000) {
						return c.json(
							{
								error: {
									message: "Page request is too large.",
								},
							},
							413,
						);
					}
					input = JSON.parse(text);
				} else {
					input =
						operation === getAuthoredFrameTemplate
							? c.req.param("templateId")
							: Object.fromEntries(
									Object.entries(c.req.query())
										.filter(([key]) => key !== "org")
										.map(([key, value]) => [
											key,
											key === "includeSystem"
												? z
														.enum(["true", "false"])
														.transform(
															(v) => v === "true",
														)
														.parse(value)
												: value,
										]),
								);
				}
				const actor = {
					userId: ctx.userId,
					organizationId: ctx.organizationId,
					auditActorType: "api_key" as const,
					transport: "api" as const,
				};
				const result = await operation(actor, input as never);
				return c.json(ok(result));
			} catch (e) {
				if (e instanceof FrameReviewError) {
					return c.json(
						{ error: { code: e.code, message: e.message } },
						e.code === "NOT_FOUND"
							? 404
							: e.code === "FORBIDDEN"
								? 403
								: e.code === "CONFLICT"
									? 409
									: e.code === "PAYLOAD_TOO_LARGE"
										? 413
										: 400,
					);
				}
				if (e instanceof z.ZodError || e instanceof SyntaxError) {
					return c.json(
						{
							error: {
								code: "BAD_REQUEST",
								message:
									"Provide valid page content and declared template inputs.",
							},
						},
						400,
					);
				}
				throw e;
			}
		};
		if (method === "GET") {
			app.get(path, requireScope(scope), handler);
		} else {
			app.post(
				path,
				requireScope(scope),
				bodyLimit({ maxSize: 1_100_000 }),
				handler,
			);
		}
	}
}
