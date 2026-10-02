import { ORPCError } from "@orpc/server";
import {
	db,
	getCompanyContextReadiness,
	isFeatureEnabled,
	resolveProjectTenant,
} from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";
import { resolveCurrentCompanyModel } from "./lib/source-state";

/**
 * What the Proposal and Business Case create flow shows about company
 * context (Fizzy #2719): `empty` when the organization has no
 * company source yet, `notReady` when it has sources but none is ready for
 * retrieval, and `hidden` otherwise.
 *
 * `hidden` is one answer for every case that must not be told apart, so the
 * endpoint is no oracle: a caller without read access to the project, a
 * project guest (no member row in the project's organization), the gate off
 * for that organization, and an organization with a ready source all read the
 * same. Only an organization member who can read the project ever learns
 * anything about its company context.
 *
 * The organization is the PROJECT's — company context used in a project is
 * always that project's organization's, whatever workspace the caller has
 * active. "Ready" is `companyContextReadyWhere` under the
 * organization's current embedding model, the predicate retrieval uses.
 *
 * AUTHORIZATION: project read access (`assertProjectPermission` with
 * `PROJECT_READ`), then membership of the project's organization, then the
 * company context gate — each failing to `hidden` rather than an error.
 */
export const getCompanyContextNoticeStateProcedure = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/company-context/notice-state",
		tags: ["Organizations", "Company context"],
		summary: "Company context notice state",
		description:
			"Whether the Proposal and Business Case create flow should say the organization's company context is empty or not ready yet.",
	})
	.input(z.object({ projectId: z.string().min(1) }))
	.handler(async ({ context: { user }, input: { projectId } }) => {
		const hidden = { state: "hidden" as const };

		try {
			await assertProjectPermission(
				projectId,
				user.id,
				Permissions.PROJECT_READ,
			);
		} catch (error) {
			// NOT_FOUND (no tie to the project) and FORBIDDEN alike.
			if (error instanceof ORPCError) {
				return hidden;
			}
			throw error;
		}

		const organizationId = (await resolveProjectTenant(projectId))
			?.organizationId;
		if (!organizationId) {
			return hidden;
		}
		// A project guest reads the project but has no member row here.
		if (!(await verifyOrganizationMembership(organizationId, user.id))) {
			return hidden;
		}
		if (!(await isFeatureEnabled("COMPANY_CONTEXT", organizationId))) {
			return hidden;
		}

		const model = await resolveCurrentCompanyModel(organizationId, user.id);
		const { total, ready } = model
			? await getCompanyContextReadiness(organizationId, model.identity)
			: {
					total: await db.companyContextSource.count({
						where: { organizationId },
					}),
					ready: 0,
				};

		if (total === 0) {
			return { state: "empty" as const };
		}
		return ready > 0 ? hidden : { state: "notReady" as const };
	});
