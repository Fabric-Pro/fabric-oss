import type { Context, Hono } from "hono";
import { z } from "zod";
import {
	listCuratedFeedbackCommand,
	recordCuratedFeedbackCommand,
	type CuratedFeedbackActor,
} from "../dashboard/lib/curated-feedback-commands";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { ok, resolveV1Context } from "./helpers";

type Env = { Variables: ExternalApiVariables };

async function actor(c: Context<Env>): Promise<
	| { actor: CuratedFeedbackActor; error?: undefined }
	| {
			actor?: undefined;
			error: { error: string; status: 400 | 403 | 404 };
	  }
> {
	const resolved = await resolveV1Context(
		c.get("externalApiContext"),
		c.req.query("org"),
	);
	if ("error" in resolved) {
		return { error: resolved };
	}
	if (!resolved.organizationId) {
		return {
			error: {
				error: "An organization is required",
				status: 403 as const,
			},
		};
	}
	return {
		actor: {
			userId: resolved.userId,
			organizationId: resolved.organizationId,
		},
	};
}

export function registerDashboardRoutes(app: Hono<Env>) {
	app.get(
		"/dashboard/curated-feedback",
		requireScope("dashboard:read"),
		async (c) => {
			const resolved = await actor(c);
			if (resolved.error) {
				return c.json(
					{ error: { message: resolved.error.error } },
					resolved.error.status,
				);
			}
			return c.json(ok(await listCuratedFeedbackCommand(resolved.actor)));
		},
	);

	app.post(
		"/dashboard/curated-feedback",
		requireScope("dashboard:write"),
		async (c) => {
			const resolved = await actor(c);
			if (resolved.error) {
				return c.json(
					{ error: { message: resolved.error.error } },
					resolved.error.status,
				);
			}
			try {
				return c.json(
					ok(
						await recordCuratedFeedbackCommand(
							resolved.actor,
							await c.req.json(),
						),
					),
				);
			} catch (error) {
				if (
					error instanceof z.ZodError ||
					error instanceof SyntaxError
				) {
					return c.json(
						{
							error: {
								message:
									"Use a valid cardKey and feedback action",
							},
						},
						400,
					);
				}
				throw error;
			}
		},
	);
}
