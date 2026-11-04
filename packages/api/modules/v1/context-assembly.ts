import { Permissions } from "@repo/permissions";
import {
	assembleSelectedContext,
	contextSelectionActorSchema,
	contextSelectionInputSchema,
} from "@repo/rag/lib/context-continuity";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { contextAssemblyRefusal } from "../projects/lib/context-assembly-errors";
import { resolveContextProject } from "./contexts";
import { ok } from "./helpers";

export function registerContextAssemblyRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	const path = "/projects/:projectId/contexts/assemble";
	app.use(path, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	app.post(
		path,
		requireScope("projects:read"),
		bodyLimit({
			maxSize: 16 * 1024,
			onError: (c) =>
				c.json(
					{
						error: {
							code: "TOO_LARGE",
							message:
								"Context selection request exceeds 16 KiB.",
						},
					},
					413,
				),
		}),
		async (c, next) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(
					{
						error: {
							code: "INVALID_INPUT",
							message: "Provide a valid JSON context selection.",
						},
					},
					400,
				);
			}
			const parsed = contextSelectionInputSchema.safeParse(raw);
			if (!parsed.success) {
				return c.json(
					{
						error: {
							code: "INVALID_INPUT",
							message:
								"Select valid distinct sources, current revisions and bounded ranges.",
						},
					},
					400,
				);
			}
			// Even optional/denied Workspace refs require the credential's declared scope.
			if (
				parsed.data.selections.some(
					(ref) => ref.sourceKind === "workspace_document",
				)
			) {
				return requireScope("workspaces:read")(c, async () => {
					if (c.get("externalApiContext").boundProjectId) {
						c.res = c.json(
							{
								error: {
									code: "FORBIDDEN",
									message:
										"Project-scoped credentials cannot read Workspace document selections.",
								},
							},
							403,
						);
						return;
					}
					await next();
				});
			}
			await next();
		},
		async (c) => {
			const projectId = c.req.param("projectId") ?? "";
			if (
				!contextSelectionActorSchema.shape.projectId.safeParse(
					projectId,
				).success
			) {
				return c.json(
					{
						error: {
							code: "INVALID_INPUT",
							message: "Provide a valid project identifier.",
						},
					},
					400,
				);
			}
			try {
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
				if ("error" in actor) {
					return c.json({ error: actor.error }, actor.status);
				}
				const input = contextSelectionInputSchema.safeParse(
					await c.req.json(),
				);
				if (!input.success) {
					return c.json(
						{
							error: {
								code: "INVALID_INPUT",
								message: "Select valid context sources.",
							},
						},
						400,
					);
				}
				return c.json(
					ok(
						await assembleSelectedContext(
							{ ...actor, projectId },
							input.data,
						),
					),
				);
			} catch (error) {
				const refusal = contextAssemblyRefusal(error);
				return c.json(
					{
						error: {
							code: refusal.reason,
							message: refusal.message,
						},
					},
					refusal.status,
				);
			}
		},
	);
}
