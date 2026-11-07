import { ORPCError } from "@orpc/server";
import { getTemplateInstanceArtifact } from "@repo/database";
import { reportArtifactHash } from "@repo/database/prisma/queries/report-distribution";
import { getSignedUrl } from "@repo/storage";
import { buildContentDisposition } from "@repo/utils/attachment";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import type { ReportCommandContext } from "../../lib/report-command-context";
import { assertArtifactTenantAccess } from "./_tenant";

export const downloadInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	expiresIn: z.number().min(60).max(3600).default(300), // 5 minutes default
});

export const downloadArtifactProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(downloadInputSchema)
	.handler(handleDownloadReportArtifact);

export async function handleDownloadReportArtifact({
	input,
	context,
}: {
	input: z.infer<typeof downloadInputSchema>;
	context: ReportCommandContext;
}) {
	const organizationId = resolveOrganizationId(
		input.organizationId,
		context.session,
	);

	const artifact = await getTemplateInstanceArtifact(input.id, {
		userId: context.user.id,
		organizationId,
	});

	if (!artifact || artifact.execution.status === "CANCELLED") {
		throw new ORPCError("NOT_FOUND", {
			message: "Report artifact not found",
		});
	}

	assertArtifactTenantAccess(artifact, {
		userId: context.user.id,
		organizationId,
	});

	// If artifact has content stored directly, return it
	if (artifact.content !== null && !artifact.s3Path) {
		return {
			type: "inline" as const,
			content: artifact.content,
			mimeType: artifact.mimeType,
			filename: artifact.name,
			artifactHash: reportArtifactHash(artifact),
		};
	}

	// If artifact is stored in S3, generate signed URL
	if (artifact.s3Path && artifact.s3Bucket) {
		const downloadUrl = await getSignedUrl(artifact.s3Path, {
			expiresIn: input.expiresIn,
			bucket: artifact.s3Bucket,
			responseContentType: artifact.mimeType,
			responseContentDisposition: buildContentDisposition(artifact.name),
		});

		return {
			type: "url" as const,
			url: downloadUrl,
			mimeType: artifact.mimeType,
			filename: artifact.name,
			artifactHash: reportArtifactHash(artifact),
			expiresIn: input.expiresIn,
		};
	}

	throw new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "Artifact has no content available",
	});
}
