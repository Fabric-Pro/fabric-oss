import { ORPCError } from "@orpc/server";
import {
	getCompanyContextReadiness,
	getIndexedProjectContentCount,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveCurrentCompanyModel } from "../../../organizations/procedures/company-context/lib/source-state";

export const getEmbeddingChangeImpactProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_AI_CONFIG_EDIT, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/ai-config/embeddings/change-impact",
		tags: ["AI Config"],
		summary: "Count indexed content affected by an embeddings model change",
	})
	.input(z.object({ organizationId: z.string().optional() }))
	.output(
		z.object({
			companyContext: z.object({
				indexedWithCurrentModel: z.number().int().nonnegative(),
				total: z.number().int().nonnegative(),
			}),
			projectContent: z.object({
				indexed: z.number().int().nonnegative(),
			}),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"An organization is required to read embeddings change impact.",
			});
		}
		const [model, indexed] = await Promise.all([
			resolveCurrentCompanyModel(organizationId, context.user.id),
			getIndexedProjectContentCount(organizationId),
		]);
		const readiness = model
			? await getCompanyContextReadiness(organizationId, model.identity)
			: { ready: 0, total: 0 };
		return {
			companyContext: {
				indexedWithCurrentModel: readiness.ready,
				total: readiness.total,
			},
			projectContent: { indexed },
		};
	});
