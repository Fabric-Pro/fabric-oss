import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// Shared PROJECT_READ-gated base for all /projects/{id}/usage/* procedures.
export const projectUsageProcedure = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.PROJECT_READ),
);

export const USAGE_ROUTE_TAGS = ["Projects", "Usage"] as const;

export const usageRangeSchema = z
	.enum(["7d", "30d", "90d", "all"])
	.default("30d");

export const projectScopeSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});
