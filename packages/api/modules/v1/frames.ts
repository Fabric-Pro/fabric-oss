/**
 * v1 Frames routes
 * GET /frames          list frames (FRAME + SLIDESHOW)
 * GET /frames/:id      get frame details
 */
import { getFrameById, listFrames } from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { notFound, ok, resolveV1Context } from "./helpers";

function mapFrame(f: {
	id: string;
	title: string;
	description?: string | null;
	kind?: string;
	fileType: string;
	status: string;
	isPublic: boolean;
	shareToken?: string | null;
	userId: string;
	organizationId?: string;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		id: f.id,
		title: f.title,
		description: f.description ?? null,
		kind: f.kind ?? null,
		fileType: f.fileType,
		status: f.status,
		isPublic: f.isPublic,
		shareToken: f.shareToken ?? null,
		userId: f.userId,
		organizationId: f.organizationId ?? null,
		createdAt: f.createdAt.toISOString(),
		updatedAt: f.updatedAt.toISOString(),
	};
}

export function registerFrameRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/frames", requireScope("frames:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
		const offset = Number(c.req.query("offset") ?? 0);

		const frames = await listFrames({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			limit,
			offset,
		});

		return c.json(ok(frames.map(mapFrame), { total: frames.length }));
	});

	app.get("/frames/:id", requireScope("frames:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const frame = await getFrameById({
			id: c.req.param("id")!,
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});

		if (!frame) {
			return c.json(notFound("Frame"), 404);
		}

		return c.json(ok(mapFrame(frame)));
	});
}
