import { ORPCError } from "@orpc/server";
import { updateWizardTempContextTag } from "@repo/database";
import { ProjectDocumentTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const VALID_DOCUMENT_TAGS = ProjectDocumentTypeSchema.options;

export const updateTempContextTagProcedure = tenantProtectedProcedure
	// Evaluated against the organization named in the input, not the
	// session's: wizard temp contexts are stamped with it, and processing one
	// runs extraction and embeddings on that organization's AI provider.
	// `requireOrganization`: temp contexts exist only to become a project's
	// in an organization (ADR-018). Without it a null organization resolves
	// nothing and the role check is skipped — an organization viewer could
	// upload and process files the session role used to refuse them.
	.use(
		requireInputOrgPermission(Permissions.PROJECT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/wizard/temp-contexts/:contextId/tag",
		tags: ["Wizard", "Temp Contexts"],
		summary: "Update document tag on temp context",
	})
	.input(
		z.object({
			contextId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			documentTag: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { contextId, documentTag } = input;
		const user = context.user;
		// The organization the gate authorized (it resolves the same way), so
		// an omitted one is the session's here too, never the null arm.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Validate documentTag against ProjectDocumentType enum (null clears the tag)
		if (
			documentTag !== null &&
			documentTag !== "" &&
			!VALID_DOCUMENT_TAGS.includes(documentTag as any)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Invalid document tag: ${documentTag}. Valid tags: ${VALID_DOCUMENT_TAGS.join(", ")}`,
			});
		}

		try {
			await updateWizardTempContextTag(
				contextId,
				user.id,
				documentTag,
				organizationId ?? undefined,
			);

			return { success: true };
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Temp context not found",
			});
		}
	});
