import { ORPCError } from "@orpc/server";
import {
	createCompanyTextSource,
	updateCompanyContextSourceStatus,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	MAX_INSTRUCTIONS_LENGTH,
	MAX_SOURCE_TYPE_LENGTH,
} from "../../../projects/procedures/contexts/update-context-metadata";
import { assertCompanyContextEditor } from "./lib/access";
import { startCompanyTextEmbedding } from "./lib/workflows";

/**
 * Add a pasted text to the organization's company context and start
 * embedding it (Fizzy #2719).
 *
 * The embedding start is awaited rather than fired and forgotten: a start that
 * fails marks the source FAILED, so the page shows it and `reprocess` can
 * recover it, instead of leaving it pending with nothing running.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate.
 */
export const createCompanyContextTextProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/company-context/text",
		tags: ["Organizations", "Company context"],
		summary: "Add a company context text",
		description:
			"Add pasted text to the organization's company context and start embedding it.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			title: z.string().trim().min(1).max(INPUT_BOUNDS.name),
			content: z.string().trim().min(1).max(INPUT_BOUNDS.text),
			sourceType: z
				.string()
				.trim()
				.min(1)
				.max(MAX_SOURCE_TYPE_LENGTH)
				.optional(),
			aiInstructions: z
				.string()
				.trim()
				.max(MAX_INSTRUCTIONS_LENGTH)
				.optional(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, title, content } = input;
		await assertCompanyContextEditor(organizationId, user.id);

		const source = await createCompanyTextSource({
			organizationId,
			createdByUserId: user.id,
			content,
			sourceTitle: title,
			sourceType: input.sourceType,
			aiInstructions: input.aiInstructions,
			metadata: {
				title,
				addedBy: user.id,
				addedAt: new Date().toISOString(),
			},
		});

		try {
			await startCompanyTextEmbedding({
				sourceId: source.id,
				organizationId,
				userId: user.id,
				type: source.type,
				title,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			logger.error(
				`[CompanyContext] Failed to start embedding for company source ${source.id}: ${message}`,
			);
			await updateCompanyContextSourceStatus(
				source.id,
				organizationId,
				"FAILED",
				{ extractionError: `Failed to start indexing: ${message}` },
			).catch((updateError) => {
				logger.error(
					`[CompanyContext] Failed to mark company source ${source.id} FAILED: ${updateError}`,
				);
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The text was saved, but indexing could not start",
				data: { sourceId: source.id },
			});
		}

		return { sourceId: source.id, status: source.extractionStatus };
	});
