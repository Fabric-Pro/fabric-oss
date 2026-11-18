import { hasPermission } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { PARLUME_FEATURE_KEY } from "../../lib/parlume-usage";

// Shared PROJECT_READ-gated base for all /projects/{id}/usage/* procedures.
export const projectUsageProcedure = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.PROJECT_READ),
);

/**
 * Parlume's spend is for the people who can invite and remove it, as on the
 * Parlume page; a project reader's usage views leave its calls out.
 */
export async function hiddenUsageFeatureKey(
	projectId: string,
	userId: string,
): Promise<string | undefined> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	return hasPermission(
		access?.permissions ?? [],
		Permissions.PROJECT_MEMBERS_MANAGE,
	)
		? undefined
		: PARLUME_FEATURE_KEY;
}

export const USAGE_ROUTE_TAGS = ["Projects", "Usage"] as const;

export const usageRangeSchema = z
	.enum(["7d", "30d", "90d", "all"])
	.default("30d");

export const projectScopeSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});
