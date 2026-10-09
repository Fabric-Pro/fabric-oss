import { ORPCError } from "@orpc/client";
import { os } from "@orpc/server";
import { isFeatureEnabled, resolveProjectTenant } from "@repo/database";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../orpc/middleware/project-visibility";

/**
 * Rollout gate for the Proposal artifact (Fizzy #2801). The capability is OFF
 * unless the PROPOSAL_ARTIFACT flag resolves true for the project's OWNING
 * organization — org override > global override >
 * `FABRIC_FEATURE_PROPOSAL_ARTIFACT` > registry default (false).
 *
 * The organization is always derived from the Project row, never taken from
 * the caller's session or input: a guest working from another organization
 * must see the gate of the organization that owns the project, not their own.
 *
 * Same fail-closed shape as the Glossy gate: a project that resolves with no
 * organization is refused without reading the flag (ADR-018), and the answer
 * is NOT_FOUND rather than FORBIDDEN, so with the gate off the routes behave
 * as though they do not exist. `isFeatureEnabled` reads an unreadable
 * override table as the env value, so a flag-store fault resolves as off and
 * Proposals keep today's flow while it lasts; that is the documented
 * behaviour for a rollout gate, as opposed to a kill switch.
 */

function notEnabled(): ORPCError<"NOT_FOUND", unknown> {
	return new ORPCError("NOT_FOUND", {
		message: "The Proposal artifact is not enabled",
	});
}

/**
 * The gate for an organization the caller has already resolved from a
 * project or document row — never a client-supplied id. Returns that
 * organization, narrowed, so the caller can bind its tenant-aware queries to
 * it.
 */
export async function assertProposalArtifactEnabledForOrganization(
	organizationId: string | null | undefined,
): Promise<string> {
	if (!organizationId) {
		throw notEnabled();
	}
	if (!(await isFeatureEnabled("PROPOSAL_ARTIFACT", organizationId))) {
		throw notEnabled();
	}
	return organizationId;
}

/**
 * The gate for a project: resolves the owning organization from the Project
 * row and checks the flag for it. Returns the owning organization, the one
 * every Proposal artifact query must run in.
 */
export async function assertProposalArtifactEnabled(
	projectId: string,
): Promise<string> {
	const tenant = await resolveProjectTenant(projectId);
	return await assertProposalArtifactEnabledForOrganization(
		tenant?.organizationId,
	);
}

/**
 * The recipient brand gate: passes when GLOSSY_EDITION OR PROPOSAL_ARTIFACT is
 * on for the project's owning organization. The recipient brand serves both
 * the Glossy edition and the Proposal artifact's Style tab, so either rollout
 * makes it reachable. Only the recipient brand procedures use this; every
 * other Glossy and Brand kit procedure stays on GLOSSY_EDITION alone.
 *
 * Returns the owning organization, like {@link assertProposalArtifactEnabled}.
 */
export async function assertGlossyOrProposalArtifactEnabled(
	projectId: string,
): Promise<string> {
	const tenant = await resolveProjectTenant(projectId);
	const organizationId = tenant?.organizationId;
	if (!organizationId) {
		throw new ORPCError("NOT_FOUND", {
			message: "The recipient brand is not enabled",
		});
	}

	const [glossyEnabled, proposalArtifactEnabled] = await Promise.all([
		isFeatureEnabled("GLOSSY_EDITION", organizationId),
		isFeatureEnabled("PROPOSAL_ARTIFACT", organizationId),
	]);
	if (!glossyEnabled && !proposalArtifactEnabled) {
		throw new ORPCError("NOT_FOUND", {
			message: "The recipient brand is not enabled",
		});
	}
	return organizationId;
}

/**
 * A project gate as middleware, placed BEFORE `requireProjectPermission`:
 * with the gate off every caller gets NOT_FOUND, where the permission
 * middleware would first answer a viewer's write with FORBIDDEN.
 *
 * Its refusal is worded exactly as the permission middleware's NOT_FOUND for
 * a caller with no tie to the project, as `requireGlossyEnabled` does
 * (Fizzy #2639): running first, it answers callers the permission middleware
 * has not yet sorted, so gate-specific wording would tell an outsider which
 * ids name a project in an enabled organization. Any other failure passes
 * through unchanged.
 *
 * A missing `projectId` passes through: the permission middleware that
 * follows refuses it as BAD_REQUEST.
 */
function projectGateMiddleware(
	assertGate: (projectId: string) => Promise<unknown>,
) {
	return os.middleware(async ({ next }, input: unknown) => {
		const projectId = (input as Record<string, unknown> | undefined)
			?.projectId;
		if (typeof projectId === "string" && projectId) {
			try {
				await assertGate(projectId);
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
 * {@link assertProposalArtifactEnabled} as middleware, for the project-scoped
 * Proposal artifact procedures.
 */
export function requireProposalArtifactEnabled() {
	return projectGateMiddleware(assertProposalArtifactEnabled);
}

/**
 * {@link assertGlossyOrProposalArtifactEnabled} as middleware, for the
 * recipient brand procedures only. The handlers run the same gate again
 * through `loadRecipientBrandProject`.
 */
export function requireGlossyOrProposalArtifactEnabled() {
	return projectGateMiddleware(assertGlossyOrProposalArtifactEnabled);
}
