import { ORPCError } from "@orpc/server";
import { getReportArtifact } from "@repo/database";
import { getSignedUrl } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertArtifactTenantAccess } from "./_tenant";

const downloadInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	expiresIn: z.number().min(60).max(3600).default(300), // 5 minutes default
});

export const downloadArtifactProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_UPDATE))
	.input(downloadInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const artifact = await getReportArtifact(input.id);

		if (!artifact) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report artifact not found",
			});
		}

		assertArtifactTenantAccess(artifact, {
			userId: context.user.id,
			organizationId,
		});

		// If artifact has content stored directly, return it
		if (artifact.content && !artifact.s3Path) {
			return {
				type: "inline" as const,
				content: artifact.content,
				mimeType: artifact.mimeType,
				filename: artifact.name,
			};
		}

		// If artifact is stored in S3, generate signed URL
		if (artifact.s3Path && artifact.s3Bucket) {
			const downloadUrl = await getSignedUrl(artifact.s3Path, {
				expiresIn: input.expiresIn,
				bucket: artifact.s3Bucket,
			});

			return {
				type: "url" as const,
				url: downloadUrl,
				mimeType: artifact.mimeType,
				filename: artifact.name,
				expiresIn: input.expiresIn,
			};
		}

		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Artifact has no content available",
		});
	});
