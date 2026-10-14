import { ORPCError } from "@orpc/client";
import {
	hasProjectAccess,
	listDocuments,
	listStoredSourceContexts,
} from "@repo/database";
import {
	ProjectDocumentStatusSchema,
	ProjectDocumentTypeSchema,
} from "@repo/database/prisma/zod";
import { logger } from "@repo/logs";
import { classifyContext } from "@repo/utils/context-download-class";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
	userHasProjectPermission,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const listDocumentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/documents",
		tags: ["Projects", "Documents"],
		summary: "List documents",
		description: "List documents for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			type: ProjectDocumentTypeSchema.optional(),
			status: ProjectDocumentStatusSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// The project is authorized before this runs, so the resolver refuses
		// any organization but the project's. Documents are read by project
		// alone; the organization is used only to verify the caller's
		// membership before an original file is offered (`canDownloadContexts`).
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

		// List documents
		const result = await listDocuments({
			projectId: input.projectId,
			type: input.type,
			status: input.status,
		});

		return {
			...result,
			documents: await withSourceFiles(result.documents, {
				projectId: input.projectId,
				userId: user.id,
				organizationId,
			}),
		};
	});

/**
 * Whether the caller passes the gates `projects.contexts.createDownloadUrl`
 * applies — `CONTEXT_READ` on the project, and active membership of its
 * organization. An invited project guest can read the documents list without
 * the second, so offering them an original they would then be refused is
 * worse than not offering it.
 */
async function canDownloadContexts(caller: {
	projectId: string;
	userId: string;
	organizationId: string | null | undefined;
}): Promise<boolean> {
	if (
		caller.organizationId &&
		!(await verifyOrganizationMembership(
			caller.organizationId,
			caller.userId,
		))
	) {
		return false;
	}
	return userHasProjectPermission({
		userId: caller.userId,
		projectId: caller.projectId,
		permission: Permissions.CONTEXT_READ,
	});
}

/**
 * The stored upload behind each source context the caller may download, by
 * context id. Best effort: the list does not depend on it, so a failed lookup
 * hides the "Original file" item rather than failing the whole list.
 */
async function originalFilesOf(
	contextIds: string[],
	caller: {
		projectId: string;
		userId: string;
		organizationId: string | null | undefined;
	},
): Promise<Map<string, string | null>> {
	// Only when a document names a source: the common list pays no extra reads.
	if (contextIds.length === 0) {
		return new Map();
	}
	try {
		if (!(await canDownloadContexts(caller))) {
			return new Map();
		}
		const rows = await listStoredSourceContexts(
			caller.projectId,
			contextIds,
		);
		return new Map(
			rows
				.filter((ctx) => classifyContext(ctx) === "A")
				.map((ctx) => [ctx.id, ctx.originalFilename]),
		);
	} catch (err) {
		logger.warn(
			`[DocumentsList] Could not resolve the original files of project ${caller.projectId}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return new Map();
	}
}

/**
 * Attach `sourceFile` to every document imported from an uploaded file, so the
 * list can offer the upload as it was alongside the Markdown, PDF and Word
 * exports of the converted text. A document whose source was pulled or written
 * text (an integration import, a pasted note) gets `null`: it has no original
 * file, and its source context would download as synthesized Markdown, which
 * must never be labelled as the original. Every document gets `null` for a
 * caller the download itself would refuse.
 */
async function withSourceFiles<
	T extends { source: string; sourceContextId: string | null },
>(
	documents: T[],
	caller: {
		projectId: string;
		userId: string;
		organizationId: string | null | undefined;
	},
): Promise<
	(T & {
		sourceFile: { contextId: string; filename: string | null } | null;
	})[]
> {
	const contextIds = [
		...new Set(
			documents.flatMap((doc) =>
				doc.source === "IMPORTED" && doc.sourceContextId
					? [doc.sourceContextId]
					: [],
			),
		),
	];
	const files = await originalFilesOf(contextIds, caller);
	return documents.map((doc) => {
		const contextId =
			doc.source === "IMPORTED" ? doc.sourceContextId : null;
		return {
			...doc,
			sourceFile:
				contextId && files.has(contextId)
					? { contextId, filename: files.get(contextId) ?? null }
					: null,
		};
	});
}
