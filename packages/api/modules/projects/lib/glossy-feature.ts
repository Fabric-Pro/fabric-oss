import { ORPCError } from "@orpc/client";
import { os } from "@orpc/server";
import { isFeatureEnabled, resolveProjectTenant } from "@repo/database";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../orpc/middleware/project-visibility";

/**
 * Feature gate. Glossy Version Export is OFF unless the GLOSSY_EDITION flag
 * resolves true for the project's OWNING organization — org override > global
 * override > `FABRIC_FEATURE_GLOSSY_EDITION` > registry default (false).
 *
 * Takes the projectId, not an organizationId, on purpose, for the same reason
 * `assertPublishingSuiteFeatureEnabled` does: a caller-supplied organizationId
 * would depend on every call site passing the right thing, so the tenant is
 * derived here from the Project row instead.
 *
 * Per ADR-018 ("An organization is the only tenant context"), a project that
 * resolves with no organization is refused, not routed into the global/env/
 * default chain — the personal arm of flag resolution is a fail-closed
 * default, not a reachable destination for a new feature.
 *
 * NOT_FOUND rather than FORBIDDEN: the API behaves as though the routes do not
 * exist, which is what it already did when the flag was off (KTD20). There is
 * no companion kill switch — a build writes only Glossy-owned rows and never
 * the document or retrieval, so this one gate is re-read before every build
 * (the prepare step) rather than paired with a second, faster-acting switch.
 */
export async function assertGlossyEnabled(projectId: string): Promise<void> {
	const tenant = await resolveProjectTenant(projectId);
	await assertGlossyEnabledForOrganization(tenant?.organizationId);
}

/**
 * {@link assertGlossyEnabled} as middleware, for the project-scoped Glossy
 * procedures. Placed BEFORE `requireProjectPermission`: with the gate off,
 * every caller gets NOT_FOUND (AE10), where the permission middleware would
 * first answer a viewer's write with FORBIDDEN. The handlers still run the
 * gate again through their shared loaders.
 *
 * Its refusal is worded exactly as the permission middleware's NOT_FOUND
 * for a caller with no tie to the project: running first, it answers
 * callers the permission middleware has not yet sorted, so its own wording
 * would tell an outsider which ids name a project in a Glossy-enabled
 * organization (Fizzy #2639). The handlers' re-check runs after the
 * permission middleware and keeps the gate's wording.
 *
 * A missing `projectId` passes through: the permission middleware that
 * follows refuses it as BAD_REQUEST.
 */
export function requireGlossyEnabled() {
	return os.middleware(async ({ next }, input: unknown) => {
		const projectId = (input as Record<string, unknown> | undefined)
			?.projectId;
		if (typeof projectId === "string" && projectId) {
			try {
				await assertGlossyEnabled(projectId);
			} catch (error) {
				if (error instanceof ORPCError && error.code === "NOT_FOUND") {
					throw new ORPCError("NOT_FOUND", {
						message: PROJECT_NOT_FOUND_MESSAGE,
					});
				}
				throw error;
			}
		}
		return next();
	});
}

/**
 * The same gate for the one Glossy surface that has no project: the
 * organization Brand kit. The caller passes the organization its permission
 * middleware has already verified the caller belongs to — never one it has
 * not checked.
 *
 * Same fail-closed semantics as {@link assertGlossyEnabled}: a missing
 * organization is NOT_FOUND and never reaches the global/env/default chain.
 */
export async function assertGlossyEnabledForOrganization(
	organizationId: string | null | undefined,
): Promise<void> {
	if (!organizationId) {
		throw new ORPCError("NOT_FOUND", {
			message: "Glossy Version Export is not enabled",
		});
	}

	const enabled = await isFeatureEnabled("GLOSSY_EDITION", organizationId);
	if (!enabled) {
		throw new ORPCError("NOT_FOUND", {
			message: "Glossy Version Export is not enabled",
		});
	}
}
