import { ORPCError } from "@orpc/server";

/**
 * Authorize a report-template-instance artifact for the calling tenant.
 *
 * Replaces the prior `artifact.userId !== context.user.id` check, which
 * incorrectly blocked org members from accessing org-owned artifacts created
 * by other members. The check now mirrors the artifact's own tenant XOR:
 *
 *   - In an organization context, the artifact must belong to that org.
 *     Membership of the caller is already enforced upstream by
 *     `tenantProtectedProcedure`.
 *   - In a personal context, the artifact must be owned by the caller and
 *     have no organization (`organizationId === null`).
 *
 * Throws `FORBIDDEN` on mismatch.
 */
export function assertArtifactTenantAccess(
	artifact: { userId: string; organizationId: string | null },
	caller: { userId: string; organizationId: string | undefined },
): void {
	if (caller.organizationId) {
		if (artifact.organizationId !== caller.organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "Access denied to this artifact",
			});
		}
		return;
	}
	if (artifact.userId !== caller.userId || artifact.organizationId !== null) {
		throw new ORPCError("FORBIDDEN", {
			message: "Access denied to this artifact",
		});
	}
}
