/**
 * getUrlPageContent — URL Context Sources.
 *
 * Single-page detail: returns the full `content` plus all metadata for
 * one indexed child page. Vectors are NEVER shipped — chunk descriptors
 * include offsets and snippets, no embedding payload.
 *
 * Tenant + project access checks follow the same pattern as
 * `listUrlPages`: project-access guard, then re-fetch the page with the
 * XOR tenant filter so cross-tenant pageId addresses return NOT_FOUND.
 */
import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getUrlPageContentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/url-pages/:pageId",
		tags: ["Projects", "Contexts"],
		summary: "Get URL page content",
		description:
			"Returns full markdown content plus chunk descriptors for a single crawled page. Used by the content preview drawer's row-expand lazy load.",
	})
	.input(
		z.object({
			pageId: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Tenant XOR filter mirrored from parent contexts.
		const tenantFilter = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };

		const page = await db.projectContextUrlPage.findFirst({
			where: {
				id: input.pageId,
				projectId: input.projectId,
				...tenantFilter,
			},
			select: {
				id: true,
				pageUrl: true,
				pageTitle: true,
				content: true,
				lastFetchedAt: true,
				contentHash: true,
				etag: true,
				lastModifiedHeader: true,
				chunkCount: true,
				qdrantId: true,
				embeddedAt: true,
				extractionStatus: true,
				extractionError: true,
				parentContextId: true,
			},
		});

		if (!page) {
			throw new ORPCError("NOT_FOUND", {
				message: "URL page not found",
			});
		}

		// Chunk descriptors — for v1 we surface what the DB row records.
		// The full chunk-by-chunk Qdrant fan-out is a Group 4 deliverable
		// (workflow stamps each chunk with metadata.chunkIndex / charStart
		// / charEnd / snippet). Once that lands, this block lifts those
		// descriptors directly from the search payload. Until then we
		// emit a single-element descriptor with the qdrantId so the UI
		// can render "indexed at <embeddedAt>" without crashing on a
		// missing field.
		const chunks =
			page.qdrantId && page.embeddedAt
				? [
						{
							qdrantId: page.qdrantId,
							index: 0,
							charStart: 0,
							charEnd: page.content.length,
							snippet: page.content.slice(0, 200),
						},
					]
				: [];

		return {
			id: page.id,
			parentContextId: page.parentContextId,
			pageUrl: page.pageUrl,
			pageTitle: page.pageTitle,
			content: page.content,
			lastFetchedAt: page.lastFetchedAt,
			contentHash: page.contentHash,
			etag: page.etag,
			lastModifiedHeader: page.lastModifiedHeader,
			chunkCount: page.chunkCount,
			extractionStatus: page.extractionStatus,
			extractionError: page.extractionError,
			chunks,
		};
	});
