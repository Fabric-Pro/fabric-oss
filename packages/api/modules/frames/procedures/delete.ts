import { ORPCError } from "@orpc/client";
import { countPageRecords, deleteFrame, getFrameById } from "@repo/database";
import { logger } from "@repo/logs";
import { deleteFramePageFiles } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { PAGE_FILES_BUCKET } from "../lib/page-files";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * The stored files of a page are removed with the page. Its records go with
 * its row; its files do not, so they are deleted first: when the object store
 * cannot be reached the page stays, and deleting it again retries. A page with
 * no file records never reaches the object store.
 */
async function deleteStoredFiles(page: {
	frameId: string;
	userId: string;
	organizationId: string | undefined;
}): Promise<void> {
	if (!page.organizationId) {
		return;
	}
	const files = await countPageRecords({
		frameId: page.frameId,
		organizationId: page.organizationId,
		collection: "$files",
	});
	if (files === 0) {
		return;
	}
	try {
		await deleteFramePageFiles(page, { bucket: PAGE_FILES_BUCKET });
	} catch (error) {
		logger.error("[frames] could not delete a page's stored files", {
			frameId: page.frameId,
			error,
		});
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Could not delete the page's stored files",
		});
	}
}

export const deleteFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "DELETE",
		path: "/frames/{id}",
		tags: ["Frames"],
		summary: "Delete a frame",
		description:
			"Delete a first-class Fabric Frame by ID, with the files it stored",
	})
	.input(inputSchema)
	.output(
		z.object({
			success: z.boolean(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const frame = await getFrameById({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});
		if (!frame) {
			throw new Error("Frame not found");
		}

		await deleteStoredFiles({
			frameId: frame.id,
			userId: frame.userId,
			organizationId,
		});

		const result = await deleteFrame({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!result.success) {
			throw new Error(result.error || "Failed to delete frame");
		}

		return { success: true };
	});
