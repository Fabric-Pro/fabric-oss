/**
 * v1 Skills routes
 * GET /skills        list skills visible to caller
 * GET /skills/:id    get skill by ID or slug
 */
import { getSkill, listSkills } from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { notFound, ok, resolveV1Context } from "./helpers";

export function registerSkillRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/skills", requireScope("skills:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
		const offset = Number(c.req.query("offset") ?? 0);

		// listSkills accepts organizationId as string | null | undefined
		// SYSTEM skills are always included; ORG/USER skills are tenant-isolated
		const result = await listSkills({
			userId: ctx.organizationId ? undefined : ctx.userId,
			organizationId: ctx.organizationId,
			search: c.req.query("search"),
			category: c.req.query("category"),
			isPublished: true,
			limit,
			offset,
		});

		return c.json(ok(result.skills, { total: result.total }));
	});

	app.get("/skills/:id", requireScope("skills:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		// getSkill accepts either an ID or a slug
		const skill = await getSkill(c.req.param("id")!);
		if (!skill) {
			return c.json(notFound("Skill"), 404);
		}

		// Tenant access check — return 404 to avoid enumeration
		if (skill.scope === "SYSTEM") {
			// SYSTEM skills are visible to all authenticated callers
		} else if (skill.scope === "USER") {
			if (skill.userId !== ctx.userId) {
				return c.json(notFound("Skill"), 404);
			}
		} else if (skill.scope === "ORGANIZATION") {
			if (skill.organizationId !== ctx.organizationId) {
				return c.json(notFound("Skill"), 404);
			}
		} else {
			return c.json(notFound("Skill"), 404);
		}

		return c.json(ok(skill));
	});
}
