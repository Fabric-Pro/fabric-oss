import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { db, hasProjectAccess } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * List ProjectDocumentAsset rows for a given document plus a short-lived
 * signed download URL for each. Used by DocumentEditor / viewer to render
 * generated artifacts (e.g. architecture-diagram HTML) inline.
 */
export const listDocumentAssetsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/documents/:documentId/assets",
		tags: ["Projects", "Documents", "Assets"],
		summary: "List document assets",
		description:
			"List binary/HTML artifacts attached to a generated document (e.g. architecture diagrams).",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, documentId, organizationId } = input;
		const user = context.user;

		const resolvedOrgId = resolveOrganizationId(
			organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			resolvedOrgId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Defence in depth — make sure the document belongs to the project
		// even though requireProjectPermission already gates org membership.
		const doc = await db.projectDocument.findFirst({
			where: { id: documentId, projectId },
			select: { id: true },
		});
		if (!doc) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found in this project",
			});
		}

		const assets = await db.projectDocumentAsset.findMany({
			where: { projectDocumentId: documentId },
			orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
		});

		if (assets.length === 0) {
			return { assets: [] };
		}

		const bucket = config.storage.bucketNames.projectDocumentAssets;
		const storageProvider = getStorageProvider();

		const signed = await Promise.allSettled(
			assets.map(async (a) => ({
				a,
				url: await storageProvider.getSignedUrl(a.storageKey, {
					bucket,
					expiresIn: 3600, // 1 hour
				}),
			})),
		);

		return {
			assets: signed
				.filter(
					(
						r,
					): r is PromiseFulfilledResult<{
						a: (typeof assets)[number];
						url: string;
					}> => r.status === "fulfilled",
				)
				.map(({ value: { a, url } }) => ({
					id: a.id,
					filename: a.filename,
					contentType: a.contentType,
					sizeBytes: a.sizeBytes,
					sha256: a.sha256,
					sortOrder: a.sortOrder,
					createdAt: a.createdAt,
					downloadUrl: url,
				})),
		};
	});
