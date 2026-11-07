import { ORPCError } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { getProjectDeliverySnapshot } from "../projects/lib/delivery-snapshot";
import { resolveContextProject } from "./contexts";
import { ok } from "./helpers";

export function registerProjectDeliveryRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get(
		"/projects/:projectId/delivery",
		requireScope("projects:read"),
		async (c) => {
			c.header("Cache-Control", "private, no-store");
			const projectId = c.req.param("projectId") ?? "";
			const actor = await resolveContextProject(
				projectId,
				c.get("externalApiContext"),
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
				{
					permission: Permissions.PROJECT_READ,
					refusal: "Your current role cannot read project delivery.",
				},
			);
			if ("error" in actor) {
				return c.json({ error: actor.error }, actor.status);
			}
			try {
				return c.json(
					ok(
						await getProjectDeliverySnapshot(
							{
								userId: actor.userId,
								organizationId: actor.organizationId,
							},
							{ projectId },
						),
					),
				);
			} catch (error) {
				if (error instanceof ORPCError) {
					return c.json(
						{ error: { code: error.code, message: error.message } },
						error.code === "FORBIDDEN" ? 403 : 404,
					);
				}
				throw error;
			}
		},
	);
}
