/**
 * `aiUsageLimits.list` — read every active limit row in the caller's
 * tenant scope. Powers the "Usage limits" card on the AI Usage page.
 * b:
 * - Personal context: any authenticated user sees their own rows.
 * - Org context: only `owner | admin` members see rows; lower-role
 * members get `{ limits: [], canManage: false }` (mirrors the existing
 * page-level guard so the procedure does not leak data).
 * - Non-members in org context → `FORBIDDEN`.
 * `canManage` is the gate the frontend uses to show the "Manage limits"
 * button + the row-click → edit Sheet.
 * Per [`backend/api.md`] §"Procedure Structure" + §"Authorization
 * Pattern" and [`backend/queries.md`] §"Explicit `select`".
 */
import { ORPCError } from "@orpc/server";
import { db, getOrganizationMembership } from "@repo/database";
import { z } from "zod";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { type AiUsageLimitDto, toAiUsageLimitDto } from "./dto";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
});

interface ListResult {
	limits: AiUsageLimitDto[];
	canManage: boolean;
}

function canManageLimits(role: string | undefined): boolean {
	return role === "owner" || role === "admin";
}

export const list = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/payments/ai-usage-limits",
		tags: ["Payments"],
		summary: "List AI usage limits",
		description:
			"Returns every active AiUsageLimit row in the caller's tenant scope (personal or org). Org members below admin receive an empty list.",
	})
	.input(inputSchema)
	.handler(
		async ({ input, context: { user, session } }): Promise<ListResult> => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				session,
			);

			if (organizationId) {
				const membership = await getOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}

				const canManage = canManageLimits(membership.role);

				// b — non-admin/owner members see no limits at all,
				// matching the page-level guard so the procedure cannot leak
				// org-scoped configuration.
				if (!canManage) {
					return { limits: [], canManage: false };
				}

				const rows = await db.aiUsageLimit.findMany({
					where: {
						organizationId,
						userId: null,
						archivedAt: null,
					},
					select: {
						id: true,
						name: true,
						organizationId: true,
						userId: true,
						projectId: true,
						providerConfigId: true,
						modelCanonicalName: true,
						taskType: true,
						dimension: true,
						window: true,
						maxValue: true,
						enforcement: true,
						bannerThresholdPercent: true,
						createdById: true,
						createdAt: true,
					},
					orderBy: { createdAt: "asc" },
				});

				return {
					limits: rows.map(toAiUsageLimitDto),
					canManage: true,
				};
			}

			// Personal context — XOR enforced via `userId = user.id, organizationId = null`.
			const rows = await db.aiUsageLimit.findMany({
				where: {
					userId: user.id,
					organizationId: null,
					archivedAt: null,
				},
				select: {
					id: true,
					name: true,
					organizationId: true,
					userId: true,
					projectId: true,
					providerConfigId: true,
					modelCanonicalName: true,
					taskType: true,
					dimension: true,
					window: true,
					maxValue: true,
					enforcement: true,
					bannerThresholdPercent: true,
					createdById: true,
					createdAt: true,
				},
				orderBy: { createdAt: "asc" },
			});

			return {
				limits: rows.map(toAiUsageLimitDto),
				canManage: true,
			};
		},
	);
