import {
	applyFrameChange,
	approveFrameRevision,
	dismissFrameChange,
	FrameReviewError,
	getFrameChange,
	getFrameReviewState,
	listFrameChanges,
	proposeFrameChange,
} from "@repo/database";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireScope } from "../../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../../external-api/types";
import { ok, resolveV1Context } from "../../v1/helpers";

export function registerFrameReviewRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	const actions = [
		["POST", "/frames/:id/changes", "frames:write", proposeFrameChange],
		["GET", "/frames/:id/changes", "frames:read", listFrameChanges],
		[
			"GET",
			"/frames/:id/changes/:proposalId",
			"frames:read",
			getFrameChange,
		],
		[
			"POST",
			"/frames/:id/changes/:proposalId/apply",
			"frames:write",
			applyFrameChange,
		],
		[
			"POST",
			"/frames/:id/changes/:proposalId/dismiss",
			"frames:write",
			dismissFrameChange,
		],
		["GET", "/frames/:id/review", "frames:read", getFrameReviewState],
		["POST", "/frames/:id/approve", "frames:write", approveFrameRevision],
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
								"Select an organization connection for page reviews.",
						},
					},
					403,
				);
			}
			try {
				let raw: Record<string, unknown> = {};
				if (method === "POST") {
					if (
						Number(c.req.header("content-length") ?? 0) > 1_100_000
					) {
						return c.json(
							{
								error: {
									message: "Review request is too large.",
								},
							},
							413,
						);
					}
					const text = await c.req.text();
					if (Buffer.byteLength(text, "utf8") > 1_100_000) {
						return c.json(
							{
								error: {
									message: "Review request is too large.",
								},
							},
							413,
						);
					}
					if (text) {
						const parsed: unknown = JSON.parse(text);
						if (
							!parsed ||
							typeof parsed !== "object" ||
							Array.isArray(parsed)
						) {
							return c.json(
								{
									error: {
										message: "Provide a JSON object.",
									},
								},
								400,
							);
						}
						raw = parsed as Record<string, unknown>;
					}
				} else if (operation === listFrameChanges) {
					raw = Object.fromEntries(
						Object.entries(c.req.query()).filter(
							([k]) => k !== "org",
						),
					);
				}
				const proposalId = c.req.param("proposalId");
				if (proposalId) {
					raw = { ...raw, proposalId };
				}
				const actor = {
					userId: ctx.userId,
					organizationId: ctx.organizationId,
					auditActorType: "api_key" as const,
					transport: "api" as const,
				};
				const result = await operation(actor, c.req.param("id")!, raw);
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
								message: "Provide a valid page review request.",
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
