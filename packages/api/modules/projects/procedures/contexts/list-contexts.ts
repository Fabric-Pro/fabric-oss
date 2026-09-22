import { ORPCError } from "@orpc/client";
import {
	annotateDuplicateContexts,
	ContextSourcePathError,
	hasProjectAccess,
	listContexts,
} from "@repo/database";
import { ProjectContextTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listContextsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts",
		tags: ["Projects", "Contexts"],
		summary: "List contexts",
		description: "List contexts for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			type: ProjectContextTypeSchema.optional(),
			// Only synced knowledge files under this folder of the working
			// tree (Fizzy #2620), e.g. "docs/guides"; "" selects every synced
			// file. Normalized and validated by `listContexts`, which also
			// enforces the length limit — after the project-access check, so
			// every refusal reaches the caller the same way.
			sourcePathPrefix: z.string().optional(),
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

		// List contexts - returns { contexts, total, hasMore }
		// Exclude contexts that have been imported as documents (linked via sourceContextId).
		// Use limit: "none" so the Context tab shows every source type — the UI
		// renders a single scroll area with no pagination, and the default batching
		// limit (50) would silently drop older GitHub/Notion/codebase rows when a
		// project accumulates many recent meeting transcripts.
		let result: Awaited<ReturnType<typeof listContexts>>;
		try {
			result = await listContexts({
				projectId: input.projectId,
				type: input.type,
				excludeLinkedDocuments: true,
				limit: "none",
				sourcePathPrefix: input.sourcePathPrefix,
			});
		} catch (error) {
			if (error instanceof ContextSourcePathError) {
				throw new ORPCError("BAD_REQUEST", { message: error.message });
			}
			throw error;
		}

		// Duplicate detection (Fizzy #2619) is derived from `contentHash` over
		// exactly the rows returned here, so a canonical row is always one the
		// caller can see — a linked-document row this list hides can never be
		// the original a visible row is marked as a copy of.
		// With a `sourcePathPrefix` filter an original outside the filter is
		// not visible, so a copy inside it is not flagged.
		const duplicateOf = annotateDuplicateContexts(result.contexts);

		// Return flattened response (not double-nested)
		return {
			...result,
			contexts: result.contexts.map((context) => ({
				...context,
				duplicateOfContextId: duplicateOf.get(context.id) ?? null,
			})),
		};
	});
