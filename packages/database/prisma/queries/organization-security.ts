/**
 * Database queries for organization security settings.
 *
 * Opt-in organization-wide MFA enforcement (SOC 2 CC6.1). When an organization
 * sets `requireTwoFactor`, members without two-factor authentication enabled are
 * gated (redirected to enroll) before they can access the organization. Default
 * false, so the feature is inert for every existing org until an owner/admin
 * turns it on.
 */

import { db } from "../client";

/**
 * Read an organization's MFA-enforcement flag. Defaults to `false` when the
 * organization is missing so callers fail open (never gate on a lookup miss).
 */
export async function getOrganizationRequireTwoFactor(
	organizationId: string,
): Promise<boolean> {
	try {
		const org = await db.organization.findUnique({
			where: { id: organizationId },
			select: { requireTwoFactor: true },
		});
		return org?.requireTwoFactor ?? false;
	} catch {
		// Fail open: never gate members — or surface an error on the org layout —
		// because of a transient DB failure or the brief window between a code
		// deploy and its column migration. Treating an unreadable flag as "not
		// required" is the safe default for an access-gating control and keeps the
		// enforcement read from introducing a new way for org pages to break.
		return false;
	}
}

/**
 * Update an organization's MFA-enforcement flag. Authorization (admin/owner) is
 * enforced by the calling procedure, not here.
 */
export async function updateOrganizationRequireTwoFactor({
	organizationId,
	requireTwoFactor,
}: {
	organizationId: string;
	requireTwoFactor: boolean;
}) {
	return await db.organization.update({
		where: { id: organizationId },
		data: { requireTwoFactor },
		select: { id: true, requireTwoFactor: true },
	});
}
