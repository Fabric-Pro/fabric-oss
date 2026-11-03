/**
 * External API v1 - project knowledge hub (specs/2026-10-21-ai-artifacts-hub).
 *
 *   GET  /projects/:projectId/knowledge/types   the project's artifact type catalog
 *
 * Read by the CLI when it renders the Coding Instructions plugin, so the
 * plugin's built-in `fabric-knowledge` skill lists the project's current
 * types. Under `instructions:read`, the scope the plugin's sign-in carries;
 * the caller's live CONTEXT_READ on the project is checked per request.
 * Writes and searches go through the MCP gateway tools.
 */

import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	type RequiredContextPermission,
	resolveContextProject,
} from "./contexts";
import { ok } from "./helpers";

const READ_PERMISSION: RequiredContextPermission = {
	permission: Permissions.CONTEXT_READ,
	refusal: "No permission to read context sources of this project",
};

type KnowledgeContext = Context<{ Variables: ExternalApiVariables }>;

export function registerKnowledgeHubRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get(
		"/projects/:projectId/knowledge/types",
		requireScope("instructions:read"),
		async (c: KnowledgeContext) => {
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
			// Loaded on use: the knowledge module pulls in RAG and Temporal, which
			// the rest of the public API does not need.
			const { listProjectKnowledgeTypes } = await import(
				"../projects/lib/knowledge"
			);
			const types = await listProjectKnowledgeTypes(projectId);
			return c.json(
				ok({
					types: types.map((t) => ({
						key: t.key,
						name: t.name,
						description: t.description,
						template: t.template,
						fieldSchema: t.fieldSchema,
						summaryBehavior: t.summaryBehavior,
					})),
				}),
			);
		},
	);
}
