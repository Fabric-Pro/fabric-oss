import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	deleteWizardTempContext,
	getWizardTempContextById,
} from "@repo/database";
import { deleteWizardContext } from "@repo/rag";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const deleteTempContextProcedure = tenantProtectedProcedure
	// Evaluated against the organization named in the input, not the
	// session's: wizard temp contexts are stamped with it, and processing one
	// runs extraction and embeddings on that organization's AI provider.
	// `requireOrganization`: temp contexts exist only to become a project's
	// in an organization (ADR-018). Without it a null organization resolves
	// nothing and the role check is skipped — an organization viewer could
	// upload and process files the session role used to refuse them.
	.use(
		requireInputOrgPermission(Permissions.PROJECT_DELETE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "DELETE",
		path: "/wizard/temp-contexts/:contextId",
		tags: ["Wizard", "Temp Contexts"],
		summary: "Delete temp context",
		description: "Delete a temp context and its associated storage",
	})
	.input(
		z.object({
			contextId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { contextId } = input;
		const user = context.user;
		// The organization the gate authorized (it resolves the same way), so
		// an omitted one is the session's here too, never the null arm.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get temp context first to get the S3 path
		const tempContext = await getWizardTempContextById(
			contextId,
			user.id,
			organizationId ?? undefined,
		);

		if (!tempContext) {
			throw new ORPCError("NOT_FOUND", {
				message: "Temp context not found",
			});
		}

		// Delete from S3 if exists
		if (tempContext.s3Path) {
			try {
				const storageProvider = getStorageProvider();
				await storageProvider.deleteFile(tempContext.s3Path, {
					bucket: config.storage.bucketNames.projectContexts,
				});
			} catch (error) {
				// Log but don't fail - the file might not exist
				console.warn(
					`Failed to delete S3 file for temp context ${contextId}:`,
					error,
				);
			}
		}

		// Delete from Qdrant if embedded
		if (tempContext.qdrantId || tempContext.embeddedAt) {
			try {
				await deleteWizardContext({
					sessionId: tempContext.sessionId,
					contextId: tempContext.id,
					organizationId: organizationId ?? undefined,
				});
			} catch (error) {
				// Log but don't fail - the embedding might not exist
				console.warn(
					`Failed to delete Qdrant embedding for temp context ${contextId}:`,
					error,
				);
			}
		}

		// Delete from database
		await deleteWizardTempContext(
			contextId,
			user.id,
			organizationId ?? undefined,
		);

		return {
			success: true,
			deletedId: contextId,
		};
	});
