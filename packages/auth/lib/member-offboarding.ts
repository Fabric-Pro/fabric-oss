/**
 * What has to happen when someone stops being a member of an organization.
 *
 * One place, because there are two ways out and they were not treated the same.
 * Better Auth calls `organizationHooks.beforeRemoveMember` /
 * `afterRemoveMember` when an admin ejects somebody, and calls NOTHING when
 * somebody leaves of their own accord — `/organization/leave` deletes the
 * member row directly, and none of the plugin's fifteen before/after hook pairs
 * covers leaving. So the two triggers are wired differently by necessity and
 * must not be allowed to mean different things.
 *
 * ## What this does, and what it deliberately does not
 *
 * It revokes ACCESS: the departing person's `ProjectMember` rows across the
 * organization's projects, their workspace membership rows, and the
 * `activeOrganizationId` pointer on their sessions. Nothing else.
 *
 * It does NOT delete the data they own in the organization. There is a workflow
 * for that (`memberCascadeDeleteWorkflow`) and this module does not start it —
 * see the note at the bottom.
 *
 * ## Why revoking access is the half that cannot be deferred
 *
 * `requireProjectPermission` resolves a caller against a project by walking
 * personal-project owner, then active `ProjectMember` row, then organization
 * role. Membership of the organization is the LAST rung, not a precondition: an
 * accepted `ProjectMember` row authorizes on its own, which is exactly how a
 * project-scoped guest who belongs to no organization works. That makes a
 * surviving row after a departure indistinguishable from a legitimate guest —
 * so it has to actually be deleted, and it cannot wait on a background job.
 *
 * ## Timing decides whether a failure may refuse, which is why it is the input
 *
 * For a REMOVAL the revocation runs in `beforeRemoveMember`, which better-auth
 * calls after every one of its own checks — permission, member-belongs-to-org,
 * organization exists, user exists — and immediately before
 * `adapter.deleteMember`. Two consequences, and both are the point:
 *
 *  - A failure can REFUSE. Throwing leaves the member row in place, so there is
 *    no state where somebody has been removed from the organization while their
 *    project grants keep authorizing them. The opposite half-state — grants
 *    gone, membership intact — is the recoverable direction.
 *  - The re-add race disappears. Revoking before the member row is deleted
 *    means no admin can re-add and re-grant in the window, because there is
 *    nothing to re-add yet. Revoking afterwards would let a fresh grant be
 *    deleted by a teardown that had already started.
 *
 * For a LEAVE neither is available. `/organization/leave` has no before-hook,
 * and a global `hooks.before` would run ahead of better-auth's own
 * preconditions — a member row that does not exist, and the refusal to let the
 * only owner leave — so revoking there would strip a sole owner's grants on an
 * attempt that then fails. Replicating those preconditions to avoid that would
 * put a second copy of better-auth's policy in this repo, which is the exact
 * class of defect this module exists to remove. So the leave path revokes AFTER
 * the fact and contains its failures: there is no longer anything to refuse.
 * The residual is stated rather than hidden — a failed revocation on the leave
 * path leaves project access in place, logged at error with the ids needed to
 * repair it.
 *
 * ## The owned-data cascade is NOT wired here, on purpose
 *
 * `memberCascadeDeleteWorkflow` hard-deletes the departing member's projects,
 * workspaces, workflows, MCP configs, agent template instances and chats in the
 * organization, plus their attachments from object storage. It has never run:
 * the code that used to start it lived in a global `hooks.after` branch that
 * re-read the `member` row to find the target user, and better-auth had already
 * hard-deleted that row before the hook fired, so the lookup always returned
 * null. Turning it on is therefore not a repair but a first activation of
 * destructive behaviour — and it has no fence against remove-then-re-add. That
 * decision is deliberately separate from closing the access hole.
 */

import { revokeOrganizationMemberAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { APIError } from "better-auth/api";
import { updateSeatsInOrganizationSubscription } from "./organization";

/**
 * How the membership ended — and therefore WHEN this runs and whether a failure
 * may refuse. Not exported: it names the discriminant below, and every caller
 * writes the literal.
 */
type MemberOffboardingTrigger = "removed" | "left";

export interface RevokeDepartingMemberAccessInput {
	organizationId: string;
	userId: string;
	trigger: MemberOffboardingTrigger;
}

/**
 * Revoke a departing member's project and workspace access.
 *
 * Throws for `"removed"`, because that path runs before the member row is
 * deleted and refusing is both possible and correct. Never throws for
 * `"left"`, because that path runs after the row is gone and there is nothing
 * left to refuse.
 */
export async function revokeDepartingMemberAccess(
	input: RevokeDepartingMemberAccessInput,
): Promise<void> {
	const { organizationId, userId, trigger } = input;

	// Both ids are load-bearing predicates. An empty string would widen the
	// revocation's scope to "every project whose organizationId is the empty
	// string" instead of narrowing it, and better-auth reaches its own handler
	// with an empty id by falling back to the session's active organization —
	// so the value handed here need not be the one it acted on.
	if (!organizationId || !userId) {
		const detail = { organizationId, userId, trigger };
		logger.error("[Auth] Offboarding called without both ids", detail);
		if (trigger === "removed") {
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message:
					"Could not revoke the member's access to this organization",
				code: "MEMBER_OFFBOARDING_FAILED",
			});
		}
		return;
	}

	try {
		const revoked = await revokeOrganizationMemberAccess({
			organizationId,
			userId,
		});
		logger.info("[Auth] Revoked organization access on offboarding", {
			organizationId,
			userId,
			trigger,
			...revoked,
		});
	} catch (error) {
		logger.error(
			"[Auth] Failed to revoke organization access on offboarding",
			{ organizationId, userId, trigger, error: String(error) },
		);

		if (trigger === "removed") {
			// Refuse the removal. An admin retrying is a far better outcome
			// than a member who is out of the organization on paper and still
			// authorized on its projects.
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message:
					"Could not revoke the member's access to this organization",
				code: "MEMBER_OFFBOARDING_FAILED",
			});
		}
	}
}

/**
 * Bring the subscription's seat count back in line after a departure.
 *
 * Separate from the revocation, and always AFTER the member row is gone:
 * `updateSeatsInOrganizationSubscription` counts the organization's members, so
 * running it before the deletion would buy a seat for somebody on their way
 * out.
 *
 * Contained. A billing provider being unreachable must not turn a completed
 * departure into an error, and the next membership change re-derives the count
 * from scratch.
 */
export async function syncSeatsAfterDeparture(
	organizationId: string,
): Promise<void> {
	try {
		await updateSeatsInOrganizationSubscription(organizationId);
	} catch (error) {
		logger.error("[Auth] Failed to update seats on offboarding", {
			organizationId,
			error: String(error),
		});
	}
}
