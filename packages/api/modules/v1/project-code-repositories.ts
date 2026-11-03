/**
 * External API v1 - a project's code repositories
 * (specs/2026-10-21-ai-artifacts-hub §5.7, workspace layout).
 *
 *   GET  /projects/:projectId/code-repositories
 *   GET  /projects/:projectId/instructions/plugin-name   the plugin's name in coding tools
 *
 * The repositories connected to the project that hold the software being
 * built: every connected repository except the one Coding Instructions read
 * from. The CLI clones them into the agent workspace's `repos/<name>/`
 * folder (`fabric repos sync`, `fabric instructions init --repos`), and the
 * plugin tells the agent that layout. Addresses only, never a credential:
 * the clone uses the developer's own git sign-in.
 *
 * Under `instructions:read`, the scope the plugin's sign-in carries; the
 * caller's live CONTEXT_READ on the project is checked per request.
 */

import { db } from "@repo/database";
import { projectPluginName } from "@repo/instructions";
import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { listProjectCodeRepositories } from "../projects/lib/code-repositories";
import {
	type RequiredContextPermission,
	resolveContextProject,
} from "./contexts";
import { ok } from "./helpers";

const READ_PERMISSION: RequiredContextPermission = {
	permission: Permissions.CONTEXT_READ,
	refusal: "No permission to read this project",
};

export function registerProjectCodeRepositoryRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get(
		"/projects/:projectId/code-repositories",
		requireScope("instructions:read"),
		async (c: Context<{ Variables: ExternalApiVariables }>) => {
			const projectId = c.req.param("projectId") ?? "";
			const resolved = await resolveContextProject(
				projectId,
				c.get("externalApiContext"),
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
				READ_PERMISSION,
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			const repositories = await listProjectCodeRepositories(projectId);
			return c.json(ok({ repositories }));
		},
	);
	app.get(
		"/projects/:projectId/instructions/plugin-name",
		requireScope("instructions:read"),
		async (c: Context<{ Variables: ExternalApiVariables }>) => {
			const projectId = c.req.param("projectId") ?? "";
			const resolved = await resolveContextProject(
				projectId,
				c.get("externalApiContext"),
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
				READ_PERMISSION,
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			const project = await db.project.findUnique({
				where: { id: projectId },
				select: { id: true, name: true, instructionPluginName: true },
			});
			if (!project) {
				return c.json({ error: { message: "Project not found" } }, 404);
			}
			return c.json(ok({ name: projectPluginName(project) }));
		},
	);
}
