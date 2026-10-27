import { db, hasOrganizationTie, hasProjectAccess } from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "./effective-project-permissions";

/** Cancellation needs ownership/access; approval additionally grants execution. */
export async function canControlChatRun(input: {
	userId: string;
	organizationId: string;
	projectId?: string;
	action: "observe" | "approve" | "cancel";
}): Promise<boolean> {
	const { userId, organizationId, projectId, action } = input;
	if (projectId) {
		if (!(await hasProjectAccess(projectId, userId, organizationId))) {
			return false;
		}
		const effective = await resolveEffectiveProjectPermissions(
			projectId,
			userId,
		);
		return (
			effective?.organizationId === organizationId &&
			(action !== "approve" ||
				hasPermission(effective.permissions, Permissions.AGENT_EXECUTE))
		);
	}
	if (action === "observe") {
		return await hasOrganizationTie(userId, organizationId);
	}
	const member = await db.member.findFirst({
		where: { userId, organizationId },
		select: { role: true },
	});
	if (action !== "approve") {
		return !!member || (await hasOrganizationTie(userId, organizationId));
	}
	return (
		!!member &&
		hasPermission(
			resolveOrgPermissions(member.role ?? "member"),
			Permissions.AGENT_EXECUTE,
		)
	);
}
