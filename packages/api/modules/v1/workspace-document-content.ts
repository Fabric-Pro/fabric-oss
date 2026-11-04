import {
	getWorkspaceDocumentCatalog,
	readWorkspaceDocumentContent,
	WorkspaceDocumentContentError,
} from "@repo/database/prisma/queries/workspaces/document-content";
import type { Hono } from "hono";
import { z } from "zod";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { ok, resolveV1Context } from "./helpers";

/** Query numbers are decimal digits only: no empty/whitespace, signs, hex or exponents. */
function decimalQuery(value: string | undefined): number | undefined {
	return value === undefined
		? undefined
		: /^[0-9]+$/.test(value)
			? Number(value)
			: Number.NaN;
}

/** Organization/object grants are rechecked by the same reader used by oRPC and MCP. */
export function registerWorkspaceDocumentContentRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	const listPath = "/workspaces/:workspaceId/documents";
	app.use(listPath, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	app.get(listPath, requireScope("workspaces:read"), async (c) => {
		const ctx = await resolveV1Context(
			c.get("externalApiContext"),
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx)
			return c.json({ error: { message: ctx.error } }, ctx.status);
		const parsed = z
			.object({
				limit: z.number().int().min(1).max(100).default(20),
				offset: z.number().int().min(0).max(2147483646).default(0),
			})
			.safeParse({
				limit: decimalQuery(c.req.query("limit")),
				offset: decimalQuery(c.req.query("offset")),
			});
		if (!parsed.success)
			return c.json(
				{
					error: {
						code: "INVALID_INPUT",
						message:
							"Provide a document limit between 1 and 100 and a non-negative integer offset.",
					},
				},
				400,
			);
		try {
			const actor = {
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? "",
				workspaceId: c.req.param("workspaceId") ?? "",
			};
			const page = await getWorkspaceDocumentCatalog(actor, {
				workspaceId: actor.workspaceId,
				...parsed.data,
			});
			return c.json(
				ok({
					documents: page.documents.map((doc) => ({
						id: doc.id,
						filename: doc.filename,
						mimeType: doc.mimeType,
						status: doc.status,
						updatedAt: doc.updatedAt.toISOString(),
					})),
					total: page.documentCount,
					nextOffset: page.nextOffset ?? null,
					paginationMode: page.paginationMode,
					snapshotConsistent: page.snapshotConsistent,
				}),
			);
		} catch (error) {
			if (error instanceof WorkspaceDocumentContentError)
				return c.json(
					{ error: { code: error.code, message: error.message } },
					error.status,
				);
			return c.json(
				{
					error: {
						code: "INTERNAL_SERVER_ERROR",
						message: "Workspace documents could not be listed.",
					},
				},
				500,
			);
		}
	});
	const path = "/workspaces/:workspaceId/documents/:documentId/content";
	app.use(path, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	});
	app.get(path, requireScope("workspaces:read"), async (c) => {
		const ctx = await resolveV1Context(
			c.get("externalApiContext"),
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx)
			return c.json({ error: { message: ctx.error } }, ctx.status);
		try {
			const page = await readWorkspaceDocumentContent(
				{
					userId: ctx.userId,
					organizationId: ctx.organizationId ?? "",
				},
				{
					workspaceId: c.req.param("workspaceId") ?? "",
					documentId: c.req.param("documentId"),
					offset: decimalQuery(c.req.query("offset")),
					limit: decimalQuery(c.req.query("limit")),
					expectedRevision: c.req.query("expectedRevision"),
				},
			);
			return c.json(ok(page));
		} catch (error) {
			if (error instanceof WorkspaceDocumentContentError)
				return c.json(
					{ error: { code: error.code, message: error.message } },
					error.status,
				);
			return c.json(
				{
					error: {
						code: "INTERNAL_SERVER_ERROR",
						message:
							"Workspace document content could not be read.",
					},
				},
				500,
			);
		}
	});
}
