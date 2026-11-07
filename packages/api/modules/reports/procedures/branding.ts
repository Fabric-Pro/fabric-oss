import { ORPCError } from "@orpc/server";
import {
	ArtifactBrandingError,
	getArtifactBrandingChoices,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getReportBrandingProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			organizationId: z.string().optional(),
			projectId: z.string().min(1).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("NOT_FOUND");
		}
		try {
			return await getArtifactBrandingChoices({
				organizationId,
				projectId: input.projectId,
				userId: context.user.id,
			});
		} catch (error) {
			if (error instanceof ArtifactBrandingError) {
				throw new ORPCError("NOT_FOUND");
			}
			throw error;
		}
	});

import {
	applyReportInstanceBranding,
	getReportInstanceBranding,
	ReportBrandingCommandError,
	reportInstanceBrandingUpdateSchema,
} from "@repo/database";

const reportIdentity = z.object({
	id: z.string().min(1),
	organizationId: z.string().optional(),
});
function reportBrandingFailure(error: unknown): never {
	if (error instanceof ReportBrandingCommandError) {
		throw new ORPCError(error.code, { message: error.message });
	}
	throw error;
}
export const getReportInstanceBrandingProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(reportIdentity)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("NOT_FOUND");
		}
		try {
			return await getReportInstanceBranding(
				{ organizationId, userId: context.user.id },
				input.id,
			);
		} catch (error) {
			return reportBrandingFailure(error);
		}
	});
export const applyReportInstanceBrandingProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.input(reportIdentity.extend(reportInstanceBrandingUpdateSchema.shape))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("NOT_FOUND");
		}
		const { id, organizationId: _, ...change } = input;
		try {
			return await applyReportInstanceBranding(
				{ organizationId, userId: context.user.id },
				id,
				change,
			);
		} catch (error) {
			return reportBrandingFailure(error);
		}
	});
