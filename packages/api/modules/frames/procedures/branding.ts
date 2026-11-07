import { ORPCError } from "@orpc/server";
import {
	ArtifactBrandingError,
	applyFrameBranding,
	getFrameBranding,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { frameBrandingApplySchema } from "../lib/frame-branding-contract";
import { frameEditErrors } from "../lib/frame-edit-errors";
import { frameReadDto } from "../lib/frame-read-dto";

const identity = z.object({
	id: z.string().min(1),
	organizationId: z.string().optional(),
});
export const getFrameBrandingProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.input(identity)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		let result;
		try {
			result = organizationId
				? await getFrameBranding({
						...input,
						organizationId,
						userId: context.user.id,
						userEmail: context.user.email,
					})
				: null;
		} catch (error) {
			if (error instanceof ArtifactBrandingError) {
				throw new ORPCError("NOT_FOUND");
			}
			throw error;
		}
		if (!result) {
			throw new ORPCError("NOT_FOUND");
		}
		return result;
	});
export const applyFrameBrandingProcedure = tenantProtectedProcedure
	.use(frameEditErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
	.input(identity.extend(frameBrandingApplySchema.shape))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("NOT_FOUND");
		}
		try {
			const result = await applyFrameBranding({
				...input,
				organizationId,
				userId: context.user.id,
				expectedUpdatedAt: new Date(input.expectedUpdatedAt),
			});
			if (!result) {
				throw new ORPCError("NOT_FOUND");
			}
			return {
				...frameReadDto(result),
				createdAt: result.createdAt.toISOString(),
				updatedAt: result.updatedAt.toISOString(),
			};
		} catch (error) {
			if (error instanceof ArtifactBrandingError) {
				throw new ORPCError(
					error.code === "NOT_FOUND" ? "NOT_FOUND" : "CONFLICT",
					{ message: error.message },
				);
			}
			throw error;
		}
	});
