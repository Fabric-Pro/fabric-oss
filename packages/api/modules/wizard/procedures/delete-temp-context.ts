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
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const deleteTempContextProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_DELETE))
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
		const { contextId, organizationId } = input;
		const user = context.user;

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
