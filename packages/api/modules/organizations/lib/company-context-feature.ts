import { ORPCError } from "@orpc/client";
import { isFeatureEnabled } from "@repo/database";

/**
 * Feature gate for company context (Fizzy #2719). Company context is OFF
 * unless the COMPANY_CONTEXT flag resolves true for the organization — org
 * override > global override > `FABRIC_FEATURE_COMPANY_CONTEXT` > registry
 * default (false). One gate covers the page, retrieval and the empty-context
 * notice; when it is off, all three are absent.
 *
 * The caller passes an organization it has already resolved and verified —
 * the one its permission middleware checked the caller belongs to, or the
 * project row's owning organization — never a client-supplied id.
 *
 * Per ADR-018 ("An organization is the only tenant context"), a missing
 * organization is refused, not routed into the global/env/default chain.
 *
 * NOT_FOUND rather than FORBIDDEN: with the gate off the API behaves as though
 * the routes do not exist, the same answer `assertGlossyEnabledForOrganization`
 * gives.
 */
export async function assertCompanyContextEnabled(
	organizationId: string | null | undefined,
): Promise<void> {
	if (!organizationId) {
		throw new ORPCError("NOT_FOUND", {
			message: "Company context is not enabled",
		});
	}

	const enabled = await isFeatureEnabled("COMPANY_CONTEXT", organizationId);
	if (!enabled) {
		throw new ORPCError("NOT_FOUND", {
			message: "Company context is not enabled",
		});
	}
}
