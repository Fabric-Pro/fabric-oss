import { ORPCError } from "@orpc/server";
import { updateWizardTempContextTag } from "@repo/database";
import { ProjectDocumentTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const VALID_DOCUMENT_TAGS = ProjectDocumentTypeSchema.options;

export const updateTempContextTagProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_UPDATE))
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
		const { contextId, organizationId, documentTag } = input;
		const user = context.user;

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
