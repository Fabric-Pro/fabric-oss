import { ORPCError } from "@orpc/client";
import {
	getDocumentById,
	getDocumentVersions,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listVersionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/documents/:documentId/versions",
		tags: ["Projects", "Documents", "Versions"],
		summary: "List document versions",
		description: "List all versions of a document",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
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

		// Verify document belongs to project
		const document = await getDocumentById(input.documentId);

		if (!document || document.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		// Get versions.
		//
		// Each version carries a resolved `author` ({ kind: "HUMAN" | "AI_AGENT",
		// name }) alongside the raw `changedBy`, batched by `getDocumentVersions`
		// — the version-history UI renders `author.name` and branches on `kind` to
		// tell a person apart from the auto-refresh agent. The author is passed
		// through verbatim and MUST NOT be narrowed away here: `changedBy` on its
		// own is an opaque id (or an agent sentinel) that the client cannot, and
		// must not, interpret.
		const result = await getDocumentVersions(input.documentId);

		return { versions: result.versions };
	});
