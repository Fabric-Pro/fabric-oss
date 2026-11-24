import { ORPCError } from "@orpc/client";
import { isFeatureEnabled } from "@repo/database";

/**
 * Feature gate for OneDrive and SharePoint document folders (Fizzy #2808).
 * Off unless the CLOUD_DRIVE_FOLDERS flag resolves true for the organization.
 *
 * The caller passes the project row's organization, never a client-supplied
 * one. A project without an organization is refused like a disabled one: an
 * organization is the only tenant context, and the folder tables require one.
 *
 * NOT_FOUND rather than FORBIDDEN: with the gate off the procedures behave as
 * though they do not exist, as `assertCompanyContextEnabled` does.
 *
 * Returns the organization, now known to be set.
 */
export async function assertCloudDriveFoldersEnabled(
	organizationId: string | null | undefined,
): Promise<string> {
	if (
		!organizationId ||
		!(await isFeatureEnabled("CLOUD_DRIVE_FOLDERS", organizationId))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Document folders are not enabled",
		});
	}
	return organizationId;
}
