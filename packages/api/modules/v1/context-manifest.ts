import { Permissions } from "@repo/permissions";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	ContextManifestError,
	contextManifestPageSchema,
	readContextManifest,
} from "../projects/lib/context-manifest-reader";
import { resolveContextProject } from "./contexts";
import { ok } from "./helpers";

const decimal = (value: string | undefined) =>
	value === undefined
		? undefined
		: /^[0-9]+$/.test(value)
			? Number(value)
			: Number.NaN;
export function registerContextManifestRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	const path = "/projects/:projectId/contexts/manifest";
	app.use(path, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	app.get(path, requireScope("projects:read"), async (c) => {
		const projectId = c.req.param("projectId") ?? "";
		const actor = await resolveContextProject(
			projectId,
			c.get("externalApiContext"),
			{
				org: c.req.query("org"),
				personal: c.req.query("personal") === "1",
			},
			{
				permission: Permissions.CONTEXT_READ,
				refusal:
					"No permission to read context sources of this project",
			},
		);
		if ("error" in actor)
			return c.json({ error: actor.error }, actor.status);
		const includeCode = c.req.query("includeCodeContexts");
		const parsed = contextManifestPageSchema.safeParse({
			limit: decimal(c.req.query("limit")),
			offset: decimal(c.req.query("offset")),
			includeCodeContexts:
				includeCode === undefined
					? undefined
					: includeCode === "true"
						? true
						: includeCode === "false"
							? false
							: includeCode,
			type: c.req.query("type"),
		});
		if (!parsed.success)
			return c.json(
				{
					error: {
						code: "INVALID_INPUT",
						message:
							"Use decimal page bounds and includeCodeContexts=true or false.",
					},
				},
				400,
			);
		try {
			return c.json(
				ok(
					await readContextManifest(
						{ ...actor, projectId },
						parsed.data,
					),
				),
			);
		} catch (error) {
			if (error instanceof ContextManifestError)
				return c.json(
					{ error: { code: error.code, message: error.message } },
					error.status,
				);
			return c.json(
				{
					error: {
						code: "INTERNAL_SERVER_ERROR",
						message: "Context manifest could not be read.",
					},
				},
				500,
			);
		}
	});
}
