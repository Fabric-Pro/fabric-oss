import { ORPCError } from "@orpc/client";
import { isFeatureEnabled, resolveProjectTenant } from "@repo/database";

/**
 * Feature gate. The Publishing Suite is OFF unless the PUBLISHING_SUITE flag
 * resolves true for the project's OWNING organization — org override > global
 * override > `FABRIC_FEATURE_PUBLISHING_SUITE` > registry default (false).
 *
 * Takes the projectId, not an organizationId, on purpose. Every procedure here
 * declares `organizationId` as an optional, nullable INPUT field, so a gate
 * accepting one would depend on each call site passing the right thing. The
 * tenant is therefore derived here from the Project row — the same source
 * topic creation already uses — and there is no organization parameter for a
 * caller to get wrong.
 *
 * Per ADR-018 ("An organization is the only tenant context"), a project that
 * resolves with no organization is refused, not routed into the global/env/
 * default chain — the personal arm of flag resolution is a fail-closed
 * default, not a reachable destination for a new feature. Do NOT restore
 * `tenant.organizationId ?? undefined` here: that was a deliberate pre-ADR-018
 * fall-through, and reinstating it re-opens the routing ADR-018 closed.
 *
 * NOT_FOUND rather than FORBIDDEN: the API behaves as though the routes do not
 * exist, which is what it already did when the flag was off.
 */
export async function assertPublishingSuiteFeatureEnabled(
	projectId: string,
): Promise<void> {
	const tenant = await resolveProjectTenant(projectId);
	if (!tenant || !tenant.organizationId) {
		throw new ORPCError("NOT_FOUND", {
			message: "Publishing Suite is not enabled",
		});
	}

	const enabled = await isFeatureEnabled(
		"PUBLISHING_SUITE",
		tenant.organizationId,
	);
	if (!enabled) {
		throw new ORPCError("NOT_FOUND", {
			message: "Publishing Suite is not enabled",
		});
	}
}
